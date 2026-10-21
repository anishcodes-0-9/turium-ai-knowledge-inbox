import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/testApp.js';
import { AppError } from '../src/errors.js';

let t: TestApp;
let fixture: http.Server;
let fixturePort: number;

beforeAll(async () => {
  fixture = http.createServer((req, res) => {
    if (req.url === '/article') return void res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><title>Fixture Article</title><body><nav>menu</nav><article><p>${'The fixture article explains that the office plant is named Gerald. '.repeat(12)}</p></article></body></html>`);
    if (req.url === '/empty') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body></body></html>');
    if (req.url === '/flaky') return void res.writeHead(503).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  fixturePort = (fixture.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => fixture.close(() => r())));

beforeEach(() => {
  t = buildTestApp({}, { resolve: async (h) => (h === 'fixture.test' ? ['127.0.0.1'] : ['10.0.0.9']), ipPolicy: (ip) => ip === '127.0.0.1' });
});

const api = () => request(t.app);
const fixtureUrl = (p: string) => `http://fixture.test:${fixturePort}${p}`;

describe('GET /health', () => {
  it('returns status, counts and models', async () => {
    const res = await api().get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.items).toEqual({ pending: 0, processing: 0, indexed: 0, failed: 0 });
    expect(res.body.models).toEqual({ embedding: 'fake-embed-v1', chat: 'fake-chat-v1' });
  });
});

describe('POST /ingest (notes)', () => {
  it('accepts a note with 202 and the pending item, then indexes it', async () => {
    const res = await api().post('/ingest').send({ type: 'note', content: 'The wifi password is pelican42.\n\nSecond paragraph.' }).expect(202);
    expect(res.headers['x-request-id']).toBeTruthy();
    const item = res.body.item;
    expect(item).toMatchObject({ sourceType: 'note', status: 'pending', title: 'The wifi password is pelican42.', chunkCount: 0, error: null });
    expect(item.content).toBeUndefined();
    expect(item.contentPreview).toContain('pelican42');

    await t.worker.drain();
    const list = await api().get('/items').expect(200);
    expect(list.body.items[0]).toMatchObject({ id: item.id, status: 'indexed', chunkCount: 1, attempts: 1 });
    expect(list.body.items[0].completedAt).toBeTruthy();
    expect(t.ai.embedCalls).toHaveLength(1);
  });

  it('uses an explicit title when provided', async () => {
    const res = await api().post('/ingest').send({ type: 'note', content: 'body', title: '  Custom  ' }).expect(202);
    expect(res.body.item.title).toBe('Custom');
  });

  it.each([
    [{}, /type/],
    [{ type: 'pdf' }, /type/],
    [{ type: 'note' }, /content/],
    [{ type: 'note', content: '' }, /content/],
    [{ type: 'note', content: '   \n  ' }, /empty/],
    [{ type: 'url' }, /url/],
    [{ type: 'url', url: 'ftp://example.com' }, /scheme/],
    [{ type: 'url', url: 'not a url' }, /not valid/],
    [{ type: 'url', url: 'http://user:pw@example.com' }, /credentials/],
  ])('rejects invalid body %j with 400', async (body, msg) => {
    const res = await api().post('/ingest').send(body).expect(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.message).toMatch(msg);
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('rejects malformed JSON and oversized notes', async () => {
    const bad = await api().post('/ingest').set('content-type', 'application/json').send('{"type":').expect(400);
    expect(bad.body.error.message).toMatch(/valid JSON/);
    const big = await api().post('/ingest').send({ type: 'note', content: 'x'.repeat(60_000) }).expect(400);
    expect(big.body.error.message).toMatch(/too long/);
  });

  it('rejects blocked URL destinations at submission time with 422', async () => {
    const res = await api().post('/ingest').send({ type: 'url', url: 'http://169.254.169.254/latest/meta-data' }).expect(422);
    expect(res.body.error.code).toBe('url_blocked');
  });
});

describe('POST /ingest (urls)', () => {
  it('fetches, extracts and indexes a page', async () => {
    const res = await api().post('/ingest').send({ type: 'url', url: fixtureUrl('/article') }).expect(202);
    expect(res.body.item).toMatchObject({ sourceType: 'url', status: 'pending', url: fixtureUrl('/article') });
    await t.worker.drain();
    const detail = await api().get(`/items/${res.body.item.id}`).expect(200);
    expect(detail.body.item).toMatchObject({ status: 'indexed', title: 'Fixture Article' });
    expect(detail.body.item.content).toContain('Gerald');
    expect(detail.body.item.content).not.toContain('menu');
    expect(detail.body.item.chunkCount).toBeGreaterThanOrEqual(2);
  });

  it('a stale URL fetch cannot replace the content of an item another writer finished, and skips embedding', async () => {
    const res = await api().post('/ingest').send({ type: 'url', url: fixtureUrl('/article') }).expect(202);
    const id = res.body.item.id as string;
    const realSetContent = t.items.setContent.bind(t.items);
    vi.spyOn(t.items, 'setContent').mockImplementationOnce((itemId, fields) => {
      // While this worker was fetching, another writer finished the item.
      t.items.markFailed(itemId, { code: 'url_fetch_failed', message: 'other writer' });
      return realSetContent(itemId, fields);
    });
    await t.worker.drain();
    const item = t.items.getById(id)!;
    expect(item).toMatchObject({ status: 'failed', errorCode: 'url_fetch_failed', content: null, title: res.body.item.title });
    expect(t.chunks.countForItem(id)).toBe(0);
    expect(t.ai.embedCalls).toHaveLength(0); // stopped before paying for embeddings
  });

  it('records a visible failure for hosts resolving to private addresses', async () => {
    const res = await api().post('/ingest').send({ type: 'url', url: 'http://intranet.test/secret' }).expect(202);
    await t.worker.drain();
    const item = (await api().get('/items').expect(200)).body.items[0];
    expect(item).toMatchObject({ id: res.body.item.id, status: 'failed', attempts: 1 });
    expect(item.error.code).toBe('url_blocked');
  });

  it('fails without retry when the page has no readable text', async () => {
    await api().post('/ingest').send({ type: 'url', url: fixtureUrl('/empty') }).expect(202);
    await t.worker.drain();
    const item = (await api().get('/items')).body.items[0];
    expect(item.status).toBe('failed');
    expect(item.error.code).toBe('extraction_failed');
    expect(item.attempts).toBe(1);
  });

  it('retries transient fetch failures up to the attempt limit, then fails', async () => {
    await api().post('/ingest').send({ type: 'url', url: fixtureUrl('/flaky') }).expect(202);
    await t.worker.drain();
    const item = (await api().get('/items')).body.items[0];
    expect(item.status).toBe('failed');
    expect(item.attempts).toBe(2); // INGEST_MAX_ATTEMPTS=2 in test config
    expect(item.error.code).toBe('url_fetch_failed');
  });
});

describe('GET /items', () => {
  it('paginates newest first and validates query params', async () => {
    for (const n of [1, 2, 3]) await api().post('/ingest').send({ type: 'note', content: `note ${n}` }).expect(202);
    const page = await api().get('/items?limit=2&offset=1').expect(200);
    expect(page.body).toMatchObject({ total: 3, limit: 2, offset: 1 });
    expect(page.body.items.map((i: { title: string }) => i.title)).toEqual(['note 2', 'note 1']);
    const bad = await api().get('/items?limit=0').expect(400);
    expect(bad.body.error.code).toBe('validation_error');
  });

  it('returns 404 for unknown and 400 for malformed ids', async () => {
    await api().get('/items/00000000-0000-4000-8000-000000000000').expect(404);
    await api().get('/items/nope').expect(400);
    await api().get('/nope').expect(404);
  });
});

describe('POST /items/:id/retry', () => {
  it('requeues a failed item and does not duplicate chunks on reprocessing', async () => {
    t.ai.embedError = new AppError('provider_error', 'down', { retryable: false });
    const res = await api().post('/ingest').send({ type: 'note', content: 'Retry me please.' }).expect(202);
    await t.worker.drain();
    expect((await api().get(`/items/${res.body.item.id}`)).body.item.status).toBe('failed');

    t.ai.embedError = null;
    const retry = await api().post(`/items/${res.body.item.id}/retry`).expect(202);
    expect(retry.body.item.status).toBe('pending');
    await t.worker.drain();
    // Re-run again via direct requeue to prove idempotency of chunk storage.
    t.items.requeue(res.body.item.id, { resetAttempts: true });
    await t.worker.drain();
    const item = (await api().get(`/items/${res.body.item.id}`)).body.item;
    expect(item.status).toBe('indexed');
    expect(item.chunkCount).toBe(1);
    expect(t.chunks.countForItem(res.body.item.id)).toBe(1);
  });

  it('returns 409 and changes nothing if the item stopped being failed between the check and the write', async () => {
    t.ai.embedError = new AppError('provider_error', 'down', { retryable: false });
    const res = await api().post('/ingest').send({ type: 'note', content: 'Retry race.' }).expect(202);
    await t.worker.drain();
    const id = res.body.item.id as string;
    const staleFailed = t.items.getById(id)!;
    t.items.requeue(id, { resetAttempts: true }); // meanwhile: retried elsewhere ...
    t.items.claimNextPending(); // ... and now being processed
    const before = t.items.getById(id)!;
    vi.spyOn(t.items, 'getById').mockReturnValueOnce(staleFailed); // the route's read sees the stale row

    const conflict = await api().post(`/items/${id}/retry`).expect(409);
    expect(conflict.body.error.code).toBe('conflict');
    vi.restoreAllMocks();
    expect(t.items.getById(id)).toEqual(before); // still processing, attempts not reset
  });

  it('rejects retry for non-failed items with 409', async () => {
    const res = await api().post('/ingest').send({ type: 'note', content: 'fine' }).expect(202);
    await t.worker.drain();
    const conflict = await api().post(`/items/${res.body.item.id}/retry`).expect(409);
    expect(conflict.body.error.code).toBe('conflict');
  });
});

describe('POST /query', () => {
  const seed = async () => {
    await api().post('/ingest').send({ type: 'note', content: 'Our team mascot is a purple llama named Steve.' });
    await api().post('/ingest').send({ type: 'note', content: 'The quarterly budget review happens every March.' });
    await t.worker.drain();
  };

  it('validates the question', async () => {
    const res = await api().post('/query').send({ question: 'hi' }).expect(400);
    expect(res.body.error.message).toMatch(/at least 3/);
    await api().post('/query').send({ question: 'valid question', topK: 0 }).expect(400);
    await api().post('/query').send({ question: 'valid question', minScore: 2 }).expect(400);
  });

  it('reports no_indexed_content when nothing is saved, without calling the provider', async () => {
    const res = await api().post('/query').send({ question: 'What is the mascot?' }).expect(200);
    expect(res.body).toMatchObject({ sufficientEvidence: false, insufficientReason: 'no_indexed_content', citations: [] });
    expect(t.ai.embedCalls).toHaveLength(0);
    expect(t.ai.chatCalls).toHaveLength(0);
  });

  it('answers with validated citations pointing at real chunks', async () => {
    await seed();
    const res = await api().post('/query').send({ question: 'What is the team mascot named?' }).expect(200);
    expect(res.body.sufficientEvidence).toBe(true);
    expect(res.body.answer).toContain('[1]');
    expect(res.body.citations).toHaveLength(1);
    const c = res.body.citations[0];
    expect(c.passage).toBe(1);
    expect(c.title).toBe('Our team mascot is a purple llama named Steve.');
    expect(c.snippet).toContain('Steve');
    expect(c.sourceType).toBe('note');
    expect(t.chunks.getById(c.chunkId)).not.toBeNull();
    expect(t.items.getById(c.itemId)?.status).toBe('indexed');
    expect(res.body.retrieval.candidates).toBe(2);
    // The llama note must be passage [1] in the prompt (highest similarity).
    expect(t.ai.chatCalls[0]![1]!.content).toMatch(/\[1\] Source: Our team mascot/);
  });

  it('returns no_relevant_chunks for an unrelated question (200, not an error)', async () => {
    await seed();
    const res = await api().post('/query').send({ question: 'zebra photosynthesis quantum' }).expect(200);
    expect(res.body).toMatchObject({ sufficientEvidence: false, insufficientReason: 'no_relevant_chunks', citations: [] });
    expect(res.body.retrieval.aboveThreshold).toBe(0);
    expect(t.ai.chatCalls).toHaveLength(0);
  });

  it('honours the model declaring insufficient evidence and never returns citations for it', async () => {
    await seed();
    t.ai.chatScript = () => JSON.stringify({ answer: 'The notes do not say.', sufficient: false, citations: [1] });
    const res = await api().post('/query').send({ question: 'What colour is the mascot?' }).expect(200);
    expect(res.body).toMatchObject({ sufficientEvidence: false, insufficientReason: 'model_reported_insufficient', citations: [] });
  });

  it('never passes on the model\'s own text when it reports insufficient evidence', async () => {
    await seed();
    t.ai.chatScript = () => JSON.stringify({ answer: 'Not in the notes, but llamas usually live about 20 years [1].', sufficient: false, citations: [1] });
    const res = await api().post('/query').send({ question: 'How long do llamas live?' }).expect(200);
    expect(res.body).toMatchObject({ sufficientEvidence: false, insufficientReason: 'model_reported_insufficient', citations: [] });
    expect(res.body.answer).toBe('Your saved knowledge does not contain enough information to answer this question.');
    expect(JSON.stringify(res.body)).not.toContain('20 years');
  });

  it('drops fabricated citation numbers from the model and strips their markers', async () => {
    await seed();
    t.ai.chatScript = () => JSON.stringify({ answer: 'Steve [1] [9]', sufficient: true, citations: [1, 9, 42] });
    const res = await api().post('/query').send({ question: 'mascot llama named' }).expect(200);
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.answer).toBe('Steve [1]');
  });

  it('keeps ordinary bracketed numbers in the answer while still validating the citations', async () => {
    await seed();
    t.ai.chatScript = () => JSON.stringify({ answer: 'Steve is the mascot [1]. His badge reads [0] and index [9] is unused.', sufficient: true, citations: [1] });
    const res = await api().post('/query').send({ question: 'mascot llama named' }).expect(200);
    expect(res.body.sufficientEvidence).toBe(true);
    expect(res.body.answer).toBe('Steve is the mascot [1]. His badge reads [0] and index [9] is unused.');
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0].passage).toBe(1);
  });

  it.each([
    ['claims sufficiency but cites nothing valid', JSON.stringify({ answer: 'Steve [9]', sufficient: true, citations: [9] })],
    ['returns prose instead of JSON', 'The mascot is Steve [1].'],
    ['returns truncated JSON', '{"answer":"The mascot is St'],
  ])('never reports sufficient evidence when the model %s', async (_label, raw) => {
    await seed();
    t.ai.chatScript = () => raw;
    const res = await api().post('/query').send({ question: 'mascot llama named' }).expect(200);
    expect(res.body).toMatchObject({ sufficientEvidence: false, insufficientReason: 'unverifiable_answer', citations: [] });
    expect(res.body.answer).not.toContain('Steve');
    expect(res.body.retrieval.selected).toBeGreaterThan(0);
  });

  it.each([
    ['the string "false"', '"false"'],
    ['the string "no"', '"no"'],
    ['the number 0', '0'],
    ['null', 'null'],
    ['missing', undefined],
  ])('never reports sufficient evidence when `sufficient` is %s, even with a valid citation', async (_label, value) => {
    await seed();
    const sufficient = value === undefined ? '' : `,"sufficient":${value}`;
    t.ai.chatScript = () => `{"answer":"The notes do not say [1].","citations":[1]${sufficient}}`;
    const res = await api().post('/query').send({ question: 'mascot llama named' }).expect(200);
    expect(res.body).toMatchObject({ sufficientEvidence: false, insufficientReason: 'unverifiable_answer', citations: [] });
    expect(res.body.answer).not.toContain('notes do not say');
  });

  it('maps a completion cut off by the token limit to a 502 provider error', async () => {
    await seed();
    t.ai.chatScript = () => ({ content: '{"answer":"Steve [1]","sufficient":true,"citations":[1]}', truncated: true });
    const res = await api().post('/query').send({ question: 'mascot llama named' }).expect(502);
    expect(res.body.error.code).toBe('provider_error');
    expect(res.body.error.message).toMatch(/token limit/);
  });

  it('respects a caller-supplied minScore and topK', async () => {
    await seed();
    const strict = await api().post('/query').send({ question: 'mascot llama named', minScore: 0.99 }).expect(200);
    expect(strict.body.insufficientReason).toBe('no_relevant_chunks');
    expect(strict.body.retrieval.minScore).toBe(0.99);
    const loose = await api().post('/query').send({ question: 'mascot llama named', minScore: -1, topK: 1 }).expect(200);
    expect(loose.body.retrieval.selected).toBe(1);
  });

  it('maps provider failures to 502/503 with safe messages', async () => {
    await seed();
    t.ai.embedError = new AppError('provider_rate_limited', 'AI provider rate limit reached; please try again shortly');
    const limited = await api().post('/query').send({ question: 'mascot llama named' }).expect(503);
    expect(limited.body.error.code).toBe('provider_rate_limited');
    t.ai.embedError = null;
    t.ai.chatError = new Error('socket hang up with secret sk-123');
    const down = await api().post('/query').send({ question: 'mascot llama named' }).expect(500);
    expect(down.body.error.code).toBe('internal_error');
    expect(JSON.stringify(down.body)).not.toContain('sk-123');
  });
});

describe('worker recovery', () => {
  it('requeues items left in processing after a restart', async () => {
    const res = await api().post('/ingest').send({ type: 'note', content: 'interrupted' }).expect(202);
    t.items.claimNextPending(); // simulate crash mid-processing
    expect(t.items.getById(res.body.item.id)?.status).toBe('processing');
    t.worker.start();
    await t.worker.stop();
    const item = t.items.getById(res.body.item.id)!;
    expect(['pending', 'indexed']).toContain(item.status);
    await t.worker.drain();
    expect(t.items.getById(res.body.item.id)?.status).toBe('indexed');
  });

  it('claims each pending item exactly once', async () => {
    await api().post('/ingest').send({ type: 'note', content: 'one' });
    await api().post('/ingest').send({ type: 'note', content: 'two' });
    const a = t.items.claimNextPending();
    const b = t.items.claimNextPending();
    const c = t.items.claimNextPending();
    expect(a?.id).not.toBe(b?.id);
    expect(c).toBeNull();
  });
});
