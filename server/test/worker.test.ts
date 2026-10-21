import { Writable } from 'node:stream';
import { pino } from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IngestionWorker, type WorkerOptions } from '../src/worker/ingestionWorker.js';
import { AppError } from '../src/errors.js';
import type { IngestionDeps } from '../src/services/ingestionService.js';
import { buildTestApp, type TestApp } from './helpers/testApp.js';

interface LogLine { level: number; msg: string; [k: string]: unknown }

/** Real pino logger writing JSON lines into memory, so tests assert on actual structured output. */
function captureLogger() {
  const lines: LogLine[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const l of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l) as LogLine);
      cb();
    },
  });
  return { log: pino({ level: 'debug' }, stream), lines };
}

let t: TestApp;
let cap: ReturnType<typeof captureLogger>;
let worker: IngestionWorker | null;

const makeWorker = (opts: Partial<WorkerOptions> = {}) => {
  const deps: IngestionDeps = {
    db: t.db, items: t.items, chunks: t.chunks, ai: t.ai, log: cap.log,
    chunking: { chunkSize: 400, overlap: 60 }, fetch: { timeoutMs: 1000, maxBytes: 100_000, maxRedirects: 0 }, noteMaxChars: 50_000,
  };
  worker = new IngestionWorker(deps, { pollIntervalMs: 20, maxAttempts: 2, backoffMs: () => 0, ...opts });
  return worker;
};
const addNote = (content = 'A note about llamas.') => t.items.create({ sourceType: 'note', title: 'n', content });
const waitFor = async (cond: () => boolean, timeoutMs = 2000) => {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(() => {
  t = buildTestApp();
  cap = captureLogger();
  worker = null;
});
afterEach(async () => {
  vi.useRealTimers();
  await worker?.stop(100);
  await t.worker.stop(100);
});

describe('worker loop resilience', () => {
  it('logs an unexpected (non-item) failure with structured context and keeps processing afterwards', async () => {
    const item = addNote();
    vi.spyOn(t.items, 'claimNextPending').mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const w = makeWorker();
    w.start();
    await waitFor(() => t.items.getById(item.id)?.status === 'indexed');

    const failure = cap.lines.find((l) => l.msg === 'ingestion worker loop failed; retrying after backoff');
    expect(failure).toMatchObject({ level: 50, consecutiveFailures: 1, retryInMs: 20 });
    expect((failure!.err as { message: string }).message).toContain('SQLITE_BUSY');
    expect(w.status()).toMatchObject({ state: 'ok', consecutiveFailures: 0, currentItemId: null });
  });

  it('backs off exponentially on a persistent failure instead of spinning', async () => {
    vi.useFakeTimers();
    const claim = vi.spyOn(t.items, 'claimNextPending').mockImplementation(() => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });
    const w = makeWorker({ pollIntervalMs: 100 });
    w.start();
    await vi.advanceTimersByTimeAsync(3000);
    // Attempts at t=0, 100, 300, 700, 1500 (next would be 3100). A fixed 100ms poll would give ~30.
    expect(claim).toHaveBeenCalledTimes(5);
    expect(w.status()).toMatchObject({ state: 'degraded', consecutiveFailures: 5 });
    expect(cap.lines.filter((l) => l.level === 50).map((l) => l.retryInMs)).toEqual([100, 200, 400, 800, 1600]);
  });

  it('caps the loop backoff at 30 seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(t.items, 'claimNextPending').mockImplementation(() => {
      throw new Error('boom');
    });
    makeWorker({ pollIntervalMs: 1000 }).start();
    await vi.advanceTimersByTimeAsync(200_000);
    const delays = cap.lines.filter((l) => l.level === 50).map((l) => l.retryInMs as number);
    expect(Math.max(...delays)).toBe(30_000);
  });

  it('reports a degraded worker on GET /health', async () => {
    vi.spyOn(t.items, 'claimNextPending').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    t.worker.start();
    await waitFor(() => t.worker.status().state === 'degraded');
    const res = await request(t.app).get('/health').expect(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.worker).toMatchObject({ state: 'degraded', consecutiveFailures: 1 });
    expect(typeof res.body.worker.lastFailureAt).toBe('string');
  });
});

describe('bounded shutdown', () => {
  it('returns within the timeout when an item hangs, leaving it recoverable', async () => {
    const item = addNote();
    t.ai.embed = () => new Promise<Float32Array[]>(() => {}); // provider never answers
    const w = makeWorker();
    w.start();
    await waitFor(() => w.status().currentItemId === item.id);

    const started = Date.now();
    expect(await w.stop(200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(t.items.getById(item.id)?.status).toBe('processing');
    expect(cap.lines.find((l) => l.msg.startsWith('stopped without waiting'))).toMatchObject({ level: 40, itemId: item.id });

    // Next boot recovers it within the attempt budget (1 of 2 used).
    makeWorker().start();
    expect(t.items.getById(item.id)).toMatchObject({ status: 'pending', errorCode: 'interrupted' });
  });

  it('waits for an in-flight item that finishes within the timeout', async () => {
    const item = addNote();
    const realEmbed = t.ai.embed.bind(t.ai);
    t.ai.embed = async (texts) => {
      await new Promise((r) => setTimeout(r, 100));
      return realEmbed(texts);
    };
    const w = makeWorker();
    w.start();
    await waitFor(() => w.status().currentItemId === item.id);
    expect(await w.stop(2000)).toBe(true);
    expect(t.items.getById(item.id)?.status).toBe('indexed');
  });
});

describe('restart recovery attempt limit', () => {
  it('marks an interrupted item failed once its attempts are used up', async () => {
    const item = addNote();
    t.items.claimNextPending(); // attempt 1, then "crash"
    t.items.claimNextPending(); // no-op: already processing
    expect(t.items.recoverInterrupted(2)).toEqual({ requeued: [item.id], failed: [] });
    t.items.claimNextPending(); // attempt 2, then "crash" again
    expect(t.items.getById(item.id)?.attempts).toBe(2);

    makeWorker({ maxAttempts: 2 }).start();
    expect(t.items.getById(item.id)).toMatchObject({ status: 'failed', errorCode: 'interrupted', attempts: 2 });
    expect(t.items.getById(item.id)?.errorMessage).toMatch(/attempt limit/);
    expect(t.items.getById(item.id)?.completedAt).toBeTruthy();
    expect(cap.lines.find((l) => l.msg.startsWith('marked interrupted items failed'))).toMatchObject({ level: 50, itemIds: [item.id], maxAttempts: 2 });
  });

  it('cannot crash-loop: repeated restarts stop after maxAttempts', () => {
    const item = addNote();
    let claims = 0;
    for (let boot = 0; boot < 10; boot++) {
      t.items.recoverInterrupted(3);
      if (t.items.claimNextPending()) claims++; // the process "dies" while processing every time
    }
    expect(claims).toBe(3);
    expect(t.items.getById(item.id)?.status).toBe('failed');
  });

  it('only touches processing rows and is atomic across many items', () => {
    const pending = addNote('pending');
    const a = addNote('a');
    const b = addNote('b');
    t.items.claimNextPending(); // claims `pending` (oldest) -> processing, attempts 1
    t.items.markIndexed(pending.id);
    t.items.claimNextPending(); // a: attempts 1
    t.items.claimNextPending(); // b: attempts 1
    t.db.prepare('UPDATE items SET attempts = 3 WHERE id = ?').run(b.id);
    const res = t.items.recoverInterrupted(3);
    expect(res).toEqual({ requeued: [a.id], failed: [b.id] });
    expect(t.items.getById(pending.id)?.status).toBe('indexed');
  });

  it('a manually retried item gets a fresh attempt budget', async () => {
    const item = addNote();
    t.items.claimNextPending();
    t.items.recoverInterrupted(1); // attempts 1 >= 1 -> failed
    expect(t.items.getById(item.id)?.status).toBe('failed');
    await request(t.app).post(`/items/${item.id}/retry`).expect(202);
    await t.worker.drain();
    expect(t.items.getById(item.id)).toMatchObject({ status: 'indexed', attempts: 1, errorCode: null });
  });
});

/** Makes the next call to an outcome-recording write fail, like a locked database would. */
function failNextWrite(target: 'markFailed' | 'requeue', before?: () => void) {
  (vi.spyOn(t.items, target) as unknown as { mockImplementationOnce(fn: () => never): void }).mockImplementationOnce(() => {
    before?.();
    throw new Error('SQLITE_BUSY: database is locked');
  });
}

describe('runtime recovery of orphaned processing jobs', () => {
  it.each([
    ['markFailed', false, 'a final failure'],
    ['requeue', true, 'a retryable failure'],
  ] as const)('recovers an item stranded by a failed %s write while the worker keeps running (%s)', async (target, retryable, _what) => {
    const item = addNote();
    t.ai.embedError = new AppError('provider_error', 'provider down', { retryable });
    failNextWrite(target, () => {
      t.ai.embedError = null; // the provider is healthy again by the time the retry runs
    });
    const w = makeWorker();
    w.start();

    await waitFor(() => t.items.getById(item.id)?.status === 'indexed');
    // Attempt 1 failed and its outcome could not be recorded; recovery requeued it; attempt 2 succeeded.
    expect(t.items.getById(item.id)).toMatchObject({ status: 'indexed', attempts: 2, errorCode: null });
    expect(t.chunks.countForItem(item.id)).toBe(1);
    expect(t.ai.embedCalls).toHaveLength(2);
    expect(w.status().state).not.toBe('stopped'); // never restarted
    expect(cap.lines.find((l) => l.msg === 'requeued orphaned processing items after a worker failure')).toMatchObject({ level: 40, itemIds: [item.id] });
    expect(cap.lines.some((l) => l.msg === 'requeued items interrupted by a previous shutdown')).toBe(false); // not the startup path
  });

  it('does not reclaim or duplicate a job that is still executing', async () => {
    const item = addNote();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realEmbed = t.ai.embed.bind(t.ai);
    let embedCalls = 0;
    t.ai.embed = async (texts) => {
      embedCalls++;
      await gate;
      return realEmbed(texts);
    };
    const w = makeWorker();
    w.start();
    await waitFor(() => w.status().currentItemId === item.id);

    for (let i = 0; i < 6; i++) {
      w.kick(); // each kick wakes the loop; the busy worker must ignore it
      await new Promise((r) => setTimeout(r, 30)); // spans several 20ms poll intervals
    }
    expect(t.items.getById(item.id)).toMatchObject({ status: 'processing', attempts: 1 });
    expect(embedCalls).toBe(1);

    release();
    await waitFor(() => t.items.getById(item.id)?.status === 'indexed');
    expect(t.items.getById(item.id)?.attempts).toBe(1);
    expect(embedCalls).toBe(1);
  });

  it('recovers only rows that are still processing and leaves every other state alone', () => {
    const done = addNote('done');
    const broken = addNote('broken');
    const stranded = addNote('stranded');
    const waiting = addNote('waiting');
    t.items.claimNextPending(); // done -> processing
    t.items.claimNextPending(); // broken -> processing
    t.items.claimNextPending(); // stranded -> processing; `waiting` is never claimed and stays pending
    t.items.markIndexed(done.id);
    t.items.markFailed(broken.id, { code: 'x', message: 'boom' });
    const untouched = [done, broken, waiting].map((i) => t.items.getById(i.id));

    expect(t.items.recoverOrphaned(3)).toEqual({ requeued: [stranded.id], failed: [] });

    expect(t.items.getById(stranded.id)).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'interrupted' });
    expect(t.items.getById(stranded.id)?.errorMessage).toMatch(/internal error; retrying/);
    expect([done, broken, waiting].map((i) => t.items.getById(i.id))).toEqual(untouched); // indexed, failed and pending rows unchanged
    expect(t.items.recoverOrphaned(3)).toEqual({ requeued: [], failed: [] }); // nothing left to recover
  });

  it('sweeps only while the worker is idle, never while a job is in flight', async () => {
    const item = addNote();
    t.ai.embedError = new AppError('provider_error', 'provider down', { retryable: false });
    failNextWrite('markFailed', () => {
      t.ai.embedError = null;
    });
    // From the second attempt on, hold the provider call open so the job stays in flight.
    const realEmbed = t.ai.embed.bind(t.ai);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.ai.embed = async (texts) => {
      if (++calls > 1) await gate;
      return realEmbed(texts);
    };
    const w = makeWorker();
    const seenCurrentItem: Array<string | null> = [];
    const realRecover = t.items.recoverOrphaned.bind(t.items);
    const sweep = vi.spyOn(t.items, 'recoverOrphaned').mockImplementation((max) => {
      seenCurrentItem.push(w.status().currentItemId);
      return realRecover(max);
    });
    w.start();

    await waitFor(() => w.status().currentItemId === item.id && calls === 2); // attempt 2 in flight
    expect(sweep).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) {
      w.kick(); // wake the loop repeatedly while the job is running
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(sweep).toHaveBeenCalledTimes(1); // no sweep while busy
    expect(seenCurrentItem).toEqual([null]); // and the one sweep ran with nothing in flight

    release();
    await waitFor(() => t.items.getById(item.id)?.status === 'indexed');
    expect(t.items.getById(item.id)?.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('respects the attempt limit: an item whose outcome keeps failing to record ends failed, after exactly maxAttempts runs', async () => {
    const item = addNote();
    t.ai.embedError = new AppError('provider_error', 'provider down', { retryable: false });
    vi.spyOn(t.items, 'markFailed').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked'); // every outcome write fails
    });
    const w = makeWorker({ maxAttempts: 2 });
    w.start();

    await waitFor(() => t.items.getById(item.id)?.status === 'failed');
    expect(t.items.getById(item.id)).toMatchObject({ status: 'failed', attempts: 2, errorCode: 'interrupted' });
    expect(t.items.getById(item.id)?.errorMessage).toMatch(/internal error and the attempt limit was reached/);
    expect(t.items.getById(item.id)?.completedAt).toBeTruthy();

    await new Promise((r) => setTimeout(r, 200)); // no further processing once failed
    expect(t.ai.embedCalls).toHaveLength(2);
    expect(cap.lines.find((l) => l.msg === 'marked orphaned processing items failed: attempt limit reached')).toMatchObject({ level: 50, itemIds: [item.id], maxAttempts: 2 });
  });

  it('does not run an orphan sweep while the worker is healthy', async () => {
    const sweep = vi.spyOn(t.items, 'recoverOrphaned');
    const ids = [addNote('one'), addNote('two'), addNote('three')].map((i) => i.id);
    makeWorker().start();
    await waitFor(() => ids.every((id) => t.items.getById(id)?.status === 'indexed'));
    await new Promise((r) => setTimeout(r, 150)); // several idle polls
    expect(sweep).not.toHaveBeenCalled();
  });

  it('backs off instead of spinning, and never double-processes, while the database rejects both the outcome write and the recovery', async () => {
    vi.useFakeTimers();
    const item = addNote();
    t.ai.embedError = new AppError('provider_error', 'provider down', { retryable: false });
    vi.spyOn(t.items, 'markFailed').mockImplementation(() => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });
    const realRecover = t.items.recoverOrphaned.bind(t.items);
    let recoverCalls = 0;
    vi.spyOn(t.items, 'recoverOrphaned').mockImplementation((max) => {
      if (++recoverCalls <= 5) throw new Error('SQLITE_IOERR: disk I/O error'); // database stays broken for 5 attempts
      return realRecover(max);
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const realEmbed = t.ai.embed.bind(t.ai);
    t.ai.embed = async (texts) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        return await realEmbed(texts);
      } finally {
        inFlight--;
      }
    };
    makeWorker({ pollIntervalMs: 100, maxAttempts: 2 }).start();

    await vi.advanceTimersByTimeAsync(3200);
    // Recovery attempts at t=100, 300, 700, 1500, 3100 (doubling). A fixed 100ms poll would have made ~32.
    expect(recoverCalls).toBe(5);
    // The item is stranded but was processed exactly once; nothing re-ran it.
    expect(t.items.getById(item.id)).toMatchObject({ status: 'processing', attempts: 1 });
    expect(t.ai.embedCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000); // database recovers: requeue, one more attempt, then terminal failure
    expect(t.items.getById(item.id)).toMatchObject({ status: 'failed', attempts: 2, errorCode: 'interrupted' });
    expect(t.ai.embedCalls).toHaveLength(2); // exactly maxAttempts, never more
    expect(maxInFlight).toBe(1); // never concurrent
  });
});

describe('outcome writes only apply while the item is still processing', () => {
  const chunkFor = (itemId: string, text: string) => ({
    id: `${itemId}:0`, itemId, chunkIndex: 0, text, embedding: new Float32Array([1, 0, 0]), embeddingModel: 'fake-embed-v1',
  });

  describe('repository', () => {
    it('applies markIndexed and markFailed once, while processing', () => {
      const a = addNote('a');
      const b = addNote('b');
      t.items.claimNextPending();
      t.items.claimNextPending();
      expect(t.items.markIndexed(a.id)).toBe(true);
      expect(t.items.markFailed(b.id, { code: 'x', message: 'boom' })).toBe(true);
      expect(t.items.getById(a.id)?.status).toBe('indexed');
      expect(t.items.getById(b.id)).toMatchObject({ status: 'failed', errorCode: 'x' });
    });

    it('a late failure cannot change an already-indexed item', () => {
      const item = addNote();
      t.items.claimNextPending();
      t.items.markIndexed(item.id);
      const before = t.items.getById(item.id)!;

      expect(t.items.markFailed(item.id, { code: 'provider_error', message: 'late' })).toBe(false);
      expect(t.items.getById(item.id)).toEqual(before); // no column changed, including updatedAt
      expect(t.items.getById(item.id)).toMatchObject({ status: 'indexed', errorCode: null, errorMessage: null });
    });

    it('a stale success cannot overwrite a terminal failure', () => {
      const item = addNote();
      t.items.claimNextPending();
      t.items.markFailed(item.id, { code: 'url_fetch_failed', message: 'first writer' });
      const before = t.items.getById(item.id)!;

      expect(t.items.markIndexed(item.id)).toBe(false);
      expect(t.items.getById(item.id)).toEqual(before);
      expect(t.items.getById(item.id)).toMatchObject({ status: 'failed', errorCode: 'url_fetch_failed' });
    });

    it.each(['pending', 'indexed', 'failed'] as const)('writes to a %s item are no-ops', (status) => {
      const item = addNote();
      if (status !== 'pending') {
        t.items.claimNextPending();
        if (status === 'indexed') t.items.markIndexed(item.id);
        else t.items.markFailed(item.id, { code: 'x', message: 'y' });
      }
      const before = t.items.getById(item.id)!;
      expect(t.items.markIndexed(item.id)).toBe(false);
      expect(t.items.markFailed(item.id, { code: 'z', message: 'z' })).toBe(false);
      expect(t.items.requeue(item.id, { onlyIfStatus: 'processing' })).toBe(false);
      expect(t.items.getById(item.id)).toEqual(before);
    });

    it('setContent applies only while processing', () => {
      const a = addNote('a');
      expect(t.items.setContent(a.id, { title: 'T', content: 'pending body' })).toBe(false); // pending
      t.items.claimNextPending();
      expect(t.items.setContent(a.id, { title: 'T', content: 'fetched body' })).toBe(true);
      expect(t.items.getById(a.id)).toMatchObject({ title: 'T', content: 'fetched body', contentChars: 12 });
      t.items.markIndexed(a.id);
      const before = t.items.getById(a.id)!;
      expect(t.items.setContent(a.id, { title: 'STALE', content: 'stale' })).toBe(false);
      expect(t.items.getById(a.id)).toEqual(before);
    });

    it.each([
      // [current status, options, expected to apply]
      ['processing', {}, true],
      ['processing', { onlyIfStatus: 'processing' as const }, true],
      ['processing', { onlyIfStatus: 'failed' as const }, false],
      ['failed', {}, true],
      ['failed', { onlyIfStatus: 'failed' as const }, true],
      ['failed', { onlyIfStatus: 'processing' as const }, false],
      ['indexed', { onlyIfStatus: 'processing' as const }, false],
      ['indexed', { onlyIfStatus: 'failed' as const }, false],
    ] as const)('requeue from %s with %j applies: %s', (status, opts, applies) => {
      const item = addNote();
      t.items.claimNextPending(); // processing, attempts 1
      if (status === 'failed') t.items.markFailed(item.id, { code: 'x', message: 'y' });
      if (status === 'indexed') t.items.markIndexed(item.id);
      const before = t.items.getById(item.id)!;
      const next = '2030-01-01T00:00:00.000Z';
      expect(t.items.requeue(item.id, { ...opts, nextAttemptAt: next, error: { code: 'e', message: 'm' } })).toBe(applies);
      const after = t.items.getById(item.id)!;
      if (!applies) return expect(after).toEqual(before);
      expect(after).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: next, errorCode: 'e', errorMessage: 'm', completedAt: null });
    });

    it('requeue resets attempts and clears error fields when asked', () => {
      const item = addNote();
      t.items.claimNextPending();
      t.items.markFailed(item.id, { code: 'x', message: 'y' });
      expect(t.items.requeue(item.id, { resetAttempts: true, onlyIfStatus: 'failed' })).toBe(true);
      expect(t.items.getById(item.id)).toMatchObject({ status: 'pending', attempts: 0, errorCode: null, errorMessage: null, nextAttemptAt: null, completedAt: null });
    });

    it('requeue stays unconditional by default, so manual retry of a failed item still works', () => {
      const item = addNote();
      t.items.claimNextPending();
      t.items.markFailed(item.id, { code: 'x', message: 'y' });
      expect(t.items.requeue(item.id, { resetAttempts: true })).toBe(true);
      expect(t.items.getById(item.id)).toMatchObject({ status: 'pending', attempts: 0, errorCode: null });
    });
  });

  describe('worker, with another writer finishing the item while this worker is mid-job', () => {
    /** Starts the worker on one item whose provider call is held open; returns controls for the race. */
    async function holdJob(embedOutcome: 'succeed' | AppError) {
      const item = addNote('the mascot is a llama named steve');
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const realEmbed = t.ai.embed.bind(t.ai);
      t.ai.embed = async (texts) => {
        await gate;
        if (embedOutcome !== 'succeed') throw embedOutcome;
        return realEmbed(texts);
      };
      const w = makeWorker();
      w.start();
      await waitFor(() => w.status().currentItemId === item.id);
      return { item, release, w };
    }
    const lostRaceLogged = () => cap.lines.some((l) => l.msg === 'item was finished by another writer; outcome discarded');

    it.each([
      ['a final failure', false],
      ['a retryable failure', true],
    ] as const)('a late %s cannot change an item another writer already indexed', async (_what, retryable) => {
      const { item, release } = await holdJob(new AppError('provider_error', 'late failure', { retryable }));
      t.chunks.replaceForItem(item.id, [chunkFor(item.id, 'winner text')]);
      expect(t.items.markIndexed(item.id)).toBe(true); // the other writer wins
      const winner = t.items.getById(item.id)!;

      release();
      await waitFor(lostRaceLogged);

      expect(t.items.getById(item.id)).toEqual(winner); // still indexed, no error, not requeued
      expect(t.chunks.getById(`${item.id}:0`)?.text).toBe('winner text');
      expect(t.chunks.countForItem(item.id)).toBe(1);
    });

    it('a stale success cannot overwrite a terminal failure, and rolls back its chunks', async () => {
      const { item, release } = await holdJob('succeed');
      expect(t.items.markFailed(item.id, { code: 'url_fetch_failed', message: 'other writer' })).toBe(true);
      const winner = t.items.getById(item.id)!;

      release();
      await waitFor(lostRaceLogged);

      expect(t.items.getById(item.id)).toEqual(winner);
      expect(t.items.getById(item.id)).toMatchObject({ status: 'failed', errorCode: 'url_fetch_failed' });
      expect(t.chunks.countForItem(item.id)).toBe(0); // the stale success's chunks were rolled back
    });

    it('a stale success cannot replace the winner\'s chunks', async () => {
      const { item, release } = await holdJob('succeed');
      t.chunks.replaceForItem(item.id, [chunkFor(item.id, 'winner text')]);
      t.items.markIndexed(item.id);

      release();
      await waitFor(lostRaceLogged);

      expect(t.chunks.getById(`${item.id}:0`)?.text).toBe('winner text');
      expect(t.items.getById(item.id)?.status).toBe('indexed');
    });

    it('does not treat a lost race as a processing failure: no retry, no worker failure', async () => {
      const { item, release, w } = await holdJob('succeed');
      t.items.markFailed(item.id, { code: 'x', message: 'y' });

      release();
      await waitFor(lostRaceLogged);
      await new Promise((r) => setTimeout(r, 100));

      expect(t.ai.embedCalls).toHaveLength(1); // not re-processed
      expect(w.status()).toMatchObject({ state: 'ok', consecutiveFailures: 0, currentItemId: null });
      expect(cap.lines.some((l) => l.msg === 'ingestion failed')).toBe(false);
    });
  });
});

describe('worker lifecycle: start and stop', () => {
  /** Holds every provider call open until released; counts calls and concurrency. */
  function gateEmbeds() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realEmbed = t.ai.embed.bind(t.ai);
    const counts = { calls: 0, inFlight: 0, maxInFlight: 0 };
    t.ai.embed = async (texts) => {
      counts.calls++;
      counts.maxInFlight = Math.max(counts.maxInFlight, ++counts.inFlight);
      try {
        await gate;
        return await realEmbed(texts);
      } finally {
        counts.inFlight--;
      }
    };
    return { release: () => release(), counts };
  }

  it('refuses to restart while a job from a timed-out stop is still in flight, and never processes it twice', async () => {
    const item = addNote();
    const { release, counts } = gateEmbeds();
    const w = makeWorker();
    w.start(); // 1. start processing and hold the provider call open
    await waitFor(() => w.status().currentItemId === item.id);

    expect(await w.stop(50)).toBe(false); // 2. stop times out with the job still in flight

    expect(() => w.start()).toThrow(/still in flight/); // 3. restart of the same instance is rejected
    await new Promise((r) => setTimeout(r, 100));
    expect(t.items.getById(item.id)).toMatchObject({ status: 'processing', attempts: 1 }); // 4. not requeued
    expect(counts.calls).toBe(1); // ... and not processed a second time

    release(); // 5. the original operation settles and records its own outcome
    await waitFor(() => t.items.getById(item.id)?.status === 'indexed');
    expect(t.items.getById(item.id)).toMatchObject({ status: 'indexed', attempts: 1, errorCode: null });
    expect(t.chunks.countForItem(item.id)).toBe(1);

    // Restart is allowed once nothing is in flight; recovery then has nothing to reset.
    const recover = vi.spyOn(t.items, 'recoverInterrupted');
    expect(() => w.start()).not.toThrow();
    expect(recover).toHaveReturnedWith({ requeued: [], failed: [] });
    const next = addNote('second');
    await waitFor(() => t.items.getById(next.id)?.status === 'indexed');
    expect(counts.calls).toBe(2); // one call per item: the first item was never re-run
    expect(t.items.getById(item.id)?.attempts).toBe(1);
  });

  it('start() while already started is a no-op: no second recovery and the live job is untouched', async () => {
    const item = addNote();
    const { release, counts } = gateEmbeds();
    const w = makeWorker();
    w.start();
    await waitFor(() => w.status().currentItemId === item.id);
    const recover = vi.spyOn(t.items, 'recoverInterrupted');

    w.start();
    w.start();
    expect(recover).not.toHaveBeenCalled();
    expect(t.items.getById(item.id)).toMatchObject({ status: 'processing', attempts: 1 });

    release();
    await waitFor(() => t.items.getById(item.id)?.status === 'indexed');
    expect(t.items.getById(item.id)?.attempts).toBe(1);
    expect(counts.calls).toBe(1);
  });

  it('repeated start() and kick() calls never run more than one job at a time or repeat a job', async () => {
    const ids = [addNote('one'), addNote('two'), addNote('three')].map((i) => i.id);
    const { release, counts } = gateEmbeds();
    const w = makeWorker();
    for (let i = 0; i < 5; i++) {
      w.start();
      w.kick();
    }
    await waitFor(() => w.status().currentItemId !== null);
    for (let i = 0; i < 5; i++) {
      w.start();
      w.kick();
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await waitFor(() => ids.every((id) => t.items.getById(id)?.status === 'indexed'));
    expect(counts.calls).toBe(3); // exactly one provider call per item
    expect(counts.maxInFlight).toBe(1);
    expect(ids.map((id) => t.items.getById(id)?.attempts)).toEqual([1, 1, 1]);
  });

  it('a clean stop can be repeated and restarted; restart recovers only genuinely interrupted rows', async () => {
    const w = makeWorker();
    w.start();
    const first = addNote('first');
    w.kick();
    await waitFor(() => t.items.getById(first.id)?.status === 'indexed');
    expect(await w.stop(500)).toBe(true);
    expect(await w.stop(500)).toBe(true); // idempotent
    expect(w.status().state).toBe('stopped');

    const orphan = addNote('orphan');
    t.items.claimNextPending(); // left in processing while stopped, as after a crash
    w.start();
    expect(w.status().state).not.toBe('stopped');
    await waitFor(() => t.items.getById(orphan.id)?.status === 'indexed');
    expect(t.items.getById(orphan.id)?.attempts).toBe(2); // the interrupted claim counts against the budget
    expect(t.items.getById(first.id)?.attempts).toBe(1);
  });
});
