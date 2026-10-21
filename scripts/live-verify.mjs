#!/usr/bin/env node
/**
 * Live end-to-end verification against a REAL AI provider.
 *
 * Starts the server on a scratch database, then:
 *   1. ingests a note with a distinctive fact and waits for `indexed`
 *   2. asks two single-fact questions the note answers → each answer must state the fact
 *      and cite that note
 *   3. asks an unrelated question → expects sufficientEvidence=false
 *   4. ingests a URL pointing at a private address → expects a visible `failed` state
 *   5. ingests a public URL (skipped with --no-network) and waits for its final state
 *   6. restarts the server → expects items and answers to persist
 *
 * Usage (reads AI_* from server/.env or the environment):
 *   node scripts/live-verify.mjs [--no-network] [--min-score 0.5]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const serverDir = join(root, 'server');
const args = process.argv.slice(2);
const noNetwork = args.includes('--no-network');
const minScoreArg = args.includes('--min-score') ? args[args.indexOf('--min-score') + 1] : undefined;
const PORT = Number(process.env.VERIFY_PORT ?? 3210);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'inbox-verify-'));
const dbPath = join(dataDir, 'verify.db');

if (existsSync(join(serverDir, '.env'))) process.loadEnvFile(join(serverDir, '.env'));
const env = { ...process.env, PORT: String(PORT), DATABASE_PATH: dbPath, NODE_ENV: 'production', LOG_LEVEL: 'warn' };
if (minScoreArg) env.RETRIEVAL_MIN_SCORE = minScoreArg;
if (!env.AI_API_KEY) {
  console.error('AI_API_KEY is not set (server/.env or environment). For Ollama use AI_API_KEY=ollama.');
  process.exit(2);
}

const results = [];
const record = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = async (path, init) => {
  const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json' } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

let child = null;
async function startServer() {
  child = spawn('npx', ['tsx', 'src/index.ts'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error('server did not become healthy');
}
async function stopServer() {
  if (!child) return;
  const p = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([p, sleep(5000)]);
  child = null;
}
async function waitForFinalStatus(id, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { body } = await http(`/items/${id}`);
    const item = body?.item;
    if (item && (item.status === 'indexed' || item.status === 'failed')) return item;
    await sleep(500);
  }
  throw new Error(`item ${id} did not reach a final state within ${timeoutMs}ms`);
}

const FACT = 'The office plant on the third floor is a fiddle-leaf fig named Gerald, and it is watered every Tuesday by Priya.';

try {
  const health = await startServer();
  record('server starts and reports health', health.status === 'ok', `models: ${health.models.embedding} / ${health.models.chat}`);

  // 1. Note ingestion
  const ingest = await http('/ingest', { method: 'POST', body: JSON.stringify({ type: 'note', content: FACT, title: 'Office plant' }) });
  record('POST /ingest note returns 202 pending', ingest.status === 202 && ingest.body?.item?.status === 'pending', `id=${ingest.body?.item?.id}`);
  const noteId = ingest.body.item.id;
  const t0 = Date.now();
  const indexed = await waitForFinalStatus(noteId);
  record('note reaches indexed with chunks', indexed.status === 'indexed' && indexed.chunkCount >= 1, `${indexed.chunkCount} chunk(s) in ${Date.now() - t0}ms${indexed.error ? ` error=${indexed.error.code}` : ''}`);

  // 2. Supported questions. Each asks for exactly one fact, so a correct answer must contain
  //    that proper noun whatever the wording ("What is it called?" was ambiguous: a model can
  //    correctly answer with the species instead of the name). Both facts are still required.
  const facts = [
    { question: 'What is the name of the office plant?', expect: /\bgerald\b/i, label: 'name (Gerald)' },
    { question: 'Who waters the office plant?', expect: /\bpriya\b/i, label: 'waterer (Priya)' },
  ];
  for (const f of facts) {
    const r = await http('/query', { method: 'POST', body: JSON.stringify({ question: f.question }) });
    const a = r.body ?? {};
    record(`answers "${f.question}" with sufficient evidence`, r.status === 200 && a.sufficientEvidence === true, `answer="${(a.answer ?? '').slice(0, 160)}"`);
    record(`answer states the ${f.label}`, f.expect.test(a.answer ?? ''));
    record('citation points at the saved note', (a.citations ?? []).some((c) => c.itemId === noteId), `citations=${JSON.stringify((a.citations ?? []).map((c) => ({ passage: c.passage, title: c.title, score: c.score })))}`);
    console.log(`      retrieval: ${JSON.stringify(a.retrieval)}`);
  }

  // 3. Unrelated question
  const q2 = await http('/query', { method: 'POST', body: JSON.stringify({ question: 'What is the boiling point of tungsten in kelvin?' }) });
  const a2 = q2.body ?? {};
  record('unrelated question yields insufficient evidence with no citations', q2.status === 200 && a2.sufficientEvidence === false && (a2.citations ?? []).length === 0, `reason=${a2.insufficientReason} topScore=${a2.retrieval?.topScore}`);
  if (a2.insufficientReason === 'model_reported_insufficient') console.log(`      note: chunk passed the threshold (topScore ${a2.retrieval?.topScore} ≥ ${a2.retrieval?.minScore}); consider raising RETRIEVAL_MIN_SCORE for this embedding model`);

  // 4. Blocked URL → visible failure (submission-time 422 for literal IPs; worker-time failure for hostnames)
  const blocked = await http('/ingest', { method: 'POST', body: JSON.stringify({ type: 'url', url: 'http://169.254.169.254/latest/meta-data/' }) });
  record('metadata-service URL rejected at submission with 422 url_blocked', blocked.status === 422 && blocked.body?.error?.code === 'url_blocked');
  const bad = await http('/ingest', { method: 'POST', body: JSON.stringify({ type: 'url', url: 'http://localhost.localdomain.invalid/' }) });
  if (bad.status === 202) {
    const failed = await waitForFinalStatus(bad.body.item.id);
    record('unresolvable URL ends in a visible failed state', failed.status === 'failed' && !!failed.error, `error=${failed.error?.code}: ${failed.error?.message}`);
  } else {
    record('unresolvable URL rejected', bad.status >= 400, `status=${bad.status}`);
  }

  // 5. Public URL
  if (noNetwork) {
    record('public URL ingestion', true, 'skipped (--no-network)');
  } else {
    const url = await http('/ingest', { method: 'POST', body: JSON.stringify({ type: 'url', url: 'https://example.com/' }) });
    const page = await waitForFinalStatus(url.body.item.id);
    record('public URL fetched, extracted and indexed', page.status === 'indexed' && page.chunkCount >= 1, `title="${page.title}" chars=${page.contentChars}${page.error ? ` error=${page.error.code}: ${page.error.message}` : ''}`);
  }

  // 6. Restart persistence
  await stopServer();
  await startServer();
  const after = await http(`/items/${noteId}`);
  record('item persists across restart', after.status === 200 && after.body?.item?.status === 'indexed');
  const q3 = await http('/query', { method: 'POST', body: JSON.stringify({ question: 'Who waters the office plant?' }) });
  record(
    'query after restart states the fact and cites the note',
    q3.status === 200 && q3.body?.sufficientEvidence === true && /\bpriya\b/i.test(q3.body?.answer ?? '') && (q3.body?.citations ?? []).some((c) => c.itemId === noteId),
    `answer="${(q3.body?.answer ?? '').slice(0, 120)}"`,
  );
} catch (err) {
  record('unexpected error', false, err instanceof Error ? err.message : String(err));
} finally {
  await stopServer();
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
