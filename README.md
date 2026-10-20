# AI Knowledge Inbox

A small, production-style web app for a single user: save plain-text notes and web page URLs, then ask questions and get answers grounded in that saved content, with citations back to the exact source snippets.

Built for the Turium AI full-stack assessment. The stack is deliberately minimal: **React + Vite** on the front, **Node + Express + TypeScript** on the back, **SQLite** (Node's built-in `node:sqlite`, no native build step) for everything including vectors, and any **OpenAI-compatible API** (OpenAI or a local Ollama) for embeddings and answers.

## Features

- Save notes (plain text) and URLs (fetched and extracted server-side)
- Asynchronous ingestion with visible states: `pending → processing → indexed | failed`, automatic bounded retries, manual retry from the UI, recovery of interrupted jobs after a restart
- Intentional chunking (paragraph/sentence aware, overlapping windows), real embeddings, cosine-similarity retrieval over SQLite
- RAG answers with validated citations, a relevance threshold, a context budget and an explicit "insufficient evidence" state (never a fabricated answer)
- Hardened URL fetching: scheme/credential checks, private/loopback/link-local/IPv6 blocking, DNS-pinned connections, redirect re-validation, timeouts, size and content-type limits
- Validated request/response contracts (Zod), consistent error envelope, sensible HTTP status codes, structured JSON logs with request IDs
- 163 automated tests (150 backend, 13 frontend) using a deterministic fake AI provider, plus a live verification script

## Architecture

```
┌──────────────────────┐        ┌────────────────────────────────────────────────────────┐
│  web/ (React + Vite) │  HTTP  │  server/ (Express + TypeScript)                        │
│                      │ ─────▶ │                                                        │
│  AddContentForm      │        │  routes/      ingest · items · query · health          │
│  ItemList / ItemCard │        │  middleware/  validation (Zod) · error envelope        │
│  AskPanel/AnswerView │ ◀───── │  services/    ingestion · chunker · urlFetcher         │
│  hooks: useItems     │  JSON  │               htmlExtractor · retrieval · answerGen    │
│         useAsk       │        │  worker/      in-process ingestion worker              │
└──────────────────────┘        │  providers/   OpenAI-compatible client                 │
                                │  db/          node:sqlite · migrations · repositories  │
                                └──────────┬───────────────────────────┬─────────────────┘
                                           │                           │
                                     SQLite file                 Embeddings + chat
                                 (items, chunks+vectors)      (OpenAI / Ollama / …)
```

**Data flow, ingestion:** `POST /ingest` validates the input, inserts an `items` row with `status='pending'` and returns `202` immediately. The in-process worker claims the item (atomic `UPDATE … WHERE status='pending'`), fetches and extracts the page (URLs only), chunks the text, embeds every chunk, and in **one transaction** replaces the item's chunks and flips it to `indexed`. Failures are persisted on the item with an error code and message; retryable failures are requeued with exponential backoff up to `INGEST_MAX_ATTEMPTS`.

**Data flow, query:** `POST /query` embeds the question with the same model, scans every chunk of every indexed item, ranks by cosine similarity, applies the threshold, top-K and context budget, sends the selected passages to the chat model with strict instructions, and validates that every citation the model returns refers to a passage that was actually sent.

## Prerequisites

- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; developed and verified on Node 26). `npm` 10+.
- An embeddings + chat provider. Either:
  - an **OpenAI API key**, or
  - **Ollama** running locally with `nomic-embed-text` and a chat model (e.g. `llama3`). No key needed.

## Setup and run

```bash
# 1. Install (root workspace installs both packages)
npm install

# 2. Configure the server
cp server/.env.example server/.env
#    OpenAI:  set AI_API_KEY=sk-...
#    Ollama:  AI_BASE_URL=http://127.0.0.1:11434/v1  AI_API_KEY=ollama
#             EMBEDDING_MODEL=nomic-embed-text        CHAT_MODEL=llama3
#             (ollama pull nomic-embed-text && ollama pull llama3)

# 3. Initialise the database (optional; the server does this on boot too)
npm run db:migrate

# 4a. Development: backend on :3001 with hot reload, frontend on :5173 proxying API calls
npm run dev
#     open http://localhost:5173

# 4b. Production-style single process: build both, serve the UI and API from :3001
npm run build && npm start
#     open http://localhost:3001
```

Other commands:

```bash
npm test              # backend + frontend test suites (no network, no AI calls)
npm run typecheck     # strict TypeScript on both packages
npm run test -w server -- --watch
```

### Environment variables

All variables are read by `server/src/config.ts` and validated at startup. See [`server/.env.example`](server/.env.example) for a safe template.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port |
| `LOG_LEVEL` | `info` | pino level (`silent` … `trace`) |
| `DATABASE_PATH` | `./data/inbox.db` | SQLite file (`:memory:` for ephemeral) |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible base URL (Ollama: `http://127.0.0.1:11434/v1`) |
| `AI_API_KEY` | required | Provider key (any non-empty string for Ollama). Never logged. |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model id, stored with every chunk |
| `EMBEDDING_DIMENSIONS` | unset | If set, vectors of another length are rejected |
| `CHAT_MODEL` | `gpt-4o-mini` | Answer model |
| `AI_TIMEOUT_MS` / `AI_MAX_RETRIES` | `30000` / `2` | Provider timeout and bounded SDK retries |
| `CHUNK_SIZE_CHARS` / `CHUNK_OVERLAP_CHARS` | `2800` / `400` | Chunk window and overlap (≈700 / ≈100 tokens) |
| `RETRIEVAL_TOP_K` | `6` | Max chunks sent to the model |
| `RETRIEVAL_MIN_SCORE` | `0.30` | Cosine threshold; model dependent (see below) |
| `RETRIEVAL_CONTEXT_BUDGET_CHARS` | `12000` | Evidence budget per query (≈3000 tokens) |
| `INGEST_MAX_ATTEMPTS` / `INGEST_POLL_INTERVAL_MS` | `3` / `1000` | Worker retry cap and fallback poll |
| `NOTE_MAX_CHARS` | `50000` | Note size limit |
| `URL_FETCH_TIMEOUT_MS` / `URL_MAX_BYTES` / `URL_MAX_REDIRECTS` | `10000` / `2000000` / `3` | URL fetch limits |

### Database

The schema lives in [`server/src/db/schema.ts`](server/src/db/schema.ts) as ordered migrations tracked in `schema_migrations`; they run on boot and via `npm run db:migrate`. Two tables:

- `items` – id, source type, title, url, extracted content, status, attempts, error code/message, created/updated/started/completed/next-attempt timestamps. Ingestion state lives on the item (one job per item) rather than in a separate jobs table, which would only duplicate these columns for a single-user app.
- `chunks` – id (`<itemId>:<index>`), item id, chunk index, text, char count, embedding (little-endian Float32 BLOB), embedding model, dimensions. `UNIQUE(item_id, chunk_index)` plus delete-then-insert in one transaction means retries can never leave duplicate chunks.

WAL mode and `foreign_keys=ON` are enabled; chunks cascade on item deletion.

## API

All responses are JSON. Errors always use one envelope:

```json
{ "error": { "code": "validation_error", "message": "Invalid ingest request: content: content is required", "details": { "issues": [ … ] }, "requestId": "…" } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `validation_error` | 400 (413 for oversized bodies) | Malformed input, unsupported scheme, credentials in URL, bad JSON |
| `not_found` | 404 | Unknown item or route |
| `conflict` | 409 | Retry requested for an item that is not `failed` |
| `url_blocked` | 422 | Destination is private/loopback/reserved/internal |
| `url_unsupported_content` / `extraction_failed` | 422 | Not HTML/text, or no readable text |
| `url_fetch_failed` | 502 | Network error, timeout, oversized page, non-2xx |
| `provider_error` | 502 | AI provider failure or misconfiguration |
| `provider_rate_limited` | 503 | Provider 429 after bounded retries |
| `internal_error` | 500 | Unexpected; details stay in the logs |

Every response carries an `x-request-id` header (client-supplied `x-request-id` is honoured) which also appears in logs.

### `POST /ingest` → `202 Accepted`

```bash
curl -s localhost:3001/ingest -H 'content-type: application/json' \
  -d '{"type":"note","content":"Our office plant is named Gerald.","title":"Office"}'

curl -s localhost:3001/ingest -H 'content-type: application/json' \
  -d '{"type":"url","url":"https://en.wikipedia.org/wiki/Retrieval-augmented_generation"}'
```

Body: `{type:'note', content, title?}` or `{type:'url', url, title?}`. Response: `{ item: ItemSummary }` with `status: "pending"`. The `202` is honest: nothing is searchable until `GET /items` reports `indexed`.

### `GET /items?limit=50&offset=0` → `200`

```json
{ "items": [ { "id": "…", "sourceType": "url", "title": "…", "url": "…", "contentPreview": "first 200 chars…",
               "contentChars": 5120, "chunkCount": 3, "status": "indexed", "attempts": 1, "error": null,
               "createdAt": "…", "updatedAt": "…", "startedAt": "…", "completedAt": "…" } ],
  "total": 1, "limit": 50, "offset": 0 }
```

Newest first. Never includes embeddings or full content. Failed items carry `error: { code, message }`.

Also: `GET /items/:id` → `{ item: ItemDetail }` (adds `content`), `POST /items/:id/retry` → `202` (failed items only), `GET /health` → status, item counts by state and configured models.

### `POST /query` → `200`

```bash
curl -s localhost:3001/query -H 'content-type: application/json' -d '{"question":"What is the office plant called?"}'
```

```json
{ "answer": "The office plant is named Gerald [1].",
  "sufficientEvidence": true, "insufficientReason": null,
  "citations": [ { "passage": 1, "chunkId": "<itemId>:0", "itemId": "…", "chunkIndex": 0, "title": "Office",
                   "sourceType": "note", "url": null, "snippet": "Our office plant is named Gerald.", "score": 0.72 } ],
  "retrieval": { "candidates": 12, "aboveThreshold": 2, "selected": 2, "topK": 6, "minScore": 0.3, "topScore": 0.72 } }
```

Optional `topK` (1–20) and `minScore` (−1..1) override the defaults per request. When evidence is insufficient the response is still `200` with `sufficientEvidence:false`, an empty `citations` array and a machine-readable `insufficientReason`:

- `no_indexed_content` – nothing indexed yet (no provider call is made)
- `no_relevant_chunks` – nothing scored above the threshold (no chat call is made)
- `model_reported_insufficient` – passages were sent, but the model judged they do not answer the question

`[n]` markers in `answer` refer to `citations[].passage`. Citations can only reference chunks that were in the prompt, which by construction exist in the database and belong to an `indexed` item.

## Ingestion lifecycle

1. `POST /ingest` validates the body. Notes are normalised (line endings, control chars, whitespace runs) and size-checked; URLs pass static validation (scheme, credentials, hostname, literal IPs). Item persisted as `pending`, worker kicked.
2. Worker claims the oldest runnable pending item (atomic status flip, `attempts + 1`, `started_at`).
3. URLs: DNS resolve → every address must be public → connect to the validated IP (Host/SNI unchanged) → follow ≤ 3 redirects, re-validating each → enforce timeout, 2 MB cap, HTML/plain-text only → extract readable text (drops script/style/nav/header/footer/aside/forms; prefers `<article>`/`<main>`) → store title + content.
4. Chunk → embed (batched) → validate vector count and dimensions → **transaction**: delete old chunks, insert new, mark `indexed`.
5. On error: retryable (`url_fetch_failed` 5xx/network, `provider_error`, `provider_rate_limited`) → requeue with backoff (1s, 2s, 4s… capped 30s) until `INGEST_MAX_ATTEMPTS`; otherwise → `failed` with the code and message shown in the UI, where **Retry** requeues it.
6. On boot, anything left in `processing` (a crash mid-job) is requeued and logged.

The worker is a single in-process loop: adequate for one instance and one user, and it keeps the project free of Redis or a queue service. The `kick()` after each insert gives near-instant pickup; the poll interval is only a safety net.

## RAG pipeline

1. Validate the question (3–2000 chars).
2. Load all chunks whose `embedding_model` matches the configured one and whose item is `indexed`. Chunks from a different model are never compared (a warning is logged if any exist).
3. Embed the question; rank by cosine similarity (linear scan in application code).
4. `selectContext`: drop below `minScore`, cap at `topK`, drop near-duplicate texts, stay within the character budget (a single oversized chunk is truncated rather than starving the answer).
5. Build the prompt: system rules (answer only from passages, treat passage text as data, say when insufficient, output JSON) + numbered passages wrapped in `<passage>` tags + question.
6. Parse the JSON reply defensively; drop citation numbers outside `1..n`; harvest inline `[n]` markers; if JSON is unparseable fall back to raw text and only inline markers.
7. Map validated passage numbers back to chunk rows → `citations` with real snippets.

Fetched page content is untrusted. It is only ever placed inside passage tags with an explicit instruction to ignore embedded instructions, it never reaches a tool call (there are none), and the extractor strips scripts. The test suite includes a page with injected "ignore previous instructions" text.

## Chunking strategy

Character-based, boundary-aware sliding window ([`chunker.ts`](server/src/services/chunker.ts)):

- Split into paragraphs; pack whole paragraphs into a chunk while they fit `CHUNK_SIZE_CHARS` (2800 ≈ 700 tokens).
- A paragraph larger than the window is split on sentence boundaries; a single oversized sentence is hard-split at word boundaries.
- Each subsequent chunk starts with the trailing `CHUNK_OVERLAP_CHARS` (400 ≈ 100 tokens) of the previous one, snapped to a word, so a fact straddling a boundary is retrievable from at least one chunk.
- Chunk ids are deterministic (`<itemId>:<index>`); exact duplicate chunks are dropped.

Why these numbers: ~700 tokens is large enough that a chunk carries its own context (a paragraph or two, a definition plus its example) so the model is not shown orphaned fragments, and small enough that 6 chunks fit comfortably in a ~3k-token evidence budget with precise citations. Going smaller (200–300 tokens) improves precision for short factoid questions but fragments explanations and multiplies embedding calls; going larger (1500+) dilutes the embedding with mixed topics and makes citations vague. Characters rather than a tokenizer keep the chunker deterministic and provider-agnostic (the same code works with Ollama models that do not share OpenAI's tokenizer); the 4-chars-per-token heuristic is conservative for English prose.

## Vector storage rationale

Embeddings are stored as Float32 BLOBs in SQLite next to the chunk text, and similarity is computed in application code. For this scope that is the right trade:

- One file, no extra service, transactional with the rest of the data, trivially backed up.
- A full scan over N chunks is O(N·d). With 1536-d vectors, 10,000 chunks (roughly 2,000 saved pages) is ~60 MB of floats and a few tens of milliseconds per query — orders of magnitude below the embedding and LLM latency.
- The model id and dimensionality are stored per chunk, so switching models never silently mixes incompatible vectors.

`sqlite-vec`/`sqlite-vss` were considered and rejected: they add a native extension to load for a corpus size where a scan is already fast. A standalone vector database would be infrastructure for appearance's sake.

### Relevance threshold

`RETRIEVAL_MIN_SCORE` defaults to 0.30. Cosine ranges differ by model: with `text-embedding-3-small`, on-topic passages typically score 0.4–0.7 and unrelated ones 0.05–0.25, so 0.30 is a comfortable cut. With `nomic-embed-text` (Ollama) scores are compressed upwards (unrelated text often scores 0.35–0.5), so set it to roughly 0.5 when using Ollama. The threshold logic is unit-tested with synthetic vectors; the live verification script prints the actual scores so the value can be tuned against real data. Even when a chunk passes the threshold, the model is instructed to declare insufficiency, which is surfaced as `model_reported_insufficient`.

## Security controls

- **Scheme and credential checks**: only `http`/`https`; `user:pass@` rejected; hostnames restricted to DNS-safe characters.
- **SSRF**: literal IPs and every DNS answer are checked against an IPv4/IPv6 policy (loopback, RFC1918, CGNAT, link-local incl. `169.254.169.254`, multicast, reserved, documentation, ULA, IPv4-mapped/NAT64/6to4-embedded addresses). If *any* resolved address is non-public the fetch is blocked. `localhost`, `*.local`, `*.internal`, `*.localhost`, `*.home.arpa`, `*.onion` are blocked by name.
- **DNS rebinding**: the socket is opened to the address that was validated (custom `lookup`), not re-resolved, while `Host` and TLS SNI keep the original hostname.
- **Redirects**: followed manually, max 3, every hop re-validated (including scheme and resolved IP).
- **Limits**: 10 s total timeout, 2 MB cap enforced on `Content-Length` *and* while streaming, HTML/XHTML/plain text only, `Accept-Encoding: identity` to avoid decompression bombs.
- **Prompt injection**: page text is data inside passage tags; the model has no tools; citations are validated server-side so the model cannot invent sources.
- **Secrets and privacy**: the API key only exists in config and the provider client; request logs record method/URL/status/duration and never bodies, so note contents are not written to logs. Error responses never include stack traces or provider payloads.
- **Input**: Zod validation on every endpoint, 1 MB JSON body limit, 50k-char note limit, pagination bounds.

Known gaps: no auth or rate limiting (single-user by requirement); HTTPS certificate validation is Node's default (no pinning); the extractor is heuristic rather than Readability-grade; a hostile DNS server returning a public IP that later proxies internally cannot be detected (no outbound egress filtering).

## What breaks at scale

- **Linear vector scan**: fine to ~10⁴–10⁵ chunks; beyond that query latency and memory (every vector is loaded per query) grow linearly. Fix: an ANN index (`sqlite-vec`, pgvector + HNSW, or a managed vector store) and keeping candidate loading out of the request path.
- **SQLite write contention**: one writer at a time. Concurrent ingestion workers or many users would serialise on the DB. Fix: Postgres.
- **Single in-process worker**: no horizontal scaling, no cross-instance claim safety beyond the atomic UPDATE, work lost on a hard kill is only recovered on the next boot. Fix: a real job queue (BullMQ/Redis, SQS, pg-boss) with visibility timeouts and dead-letter handling.
- **Embedding cost and rate limits**: each page is embedded fully on every (re)ingest; the SDK retries are bounded but there is no global concurrency limiter or budget. Fix: content hashing to skip unchanged chunks, a token-bucket per provider, batch queues.
- **Source extraction**: heuristic HTML stripping fails on JS-rendered pages, PDFs, paywalls and sites that block bots. Fix: headless rendering, Readability/trafilatura, PDF parsers, per-domain rules.
- **Context assembly**: character budgets approximate tokens; long questions or very wide chunks can exceed model limits with a different tokenizer. Fix: count tokens with the model's tokenizer.
- **Multi-user**: there is no tenant column; everything is one inbox. Fix: `user_id` on items/chunks, auth, row-level filtering before ranking.

## Sensible production changes

Postgres + pgvector (or a managed vector DB) with an ANN index; a durable queue with retries, dead-letter and idempotency keys; object storage for raw HTML; a proper extractor pipeline; token-accurate budgeting and reranking (hybrid BM25 + vector, cross-encoder rerank); an evaluation set with retrieval/answer metrics and threshold tuning; OpenTelemetry traces and metrics on provider latency and cost; auth and per-user isolation; outbound egress policy for the fetcher; secrets manager; CI running the test suites.

## Debugging a failed ingestion or query

Logs are newline-delimited JSON (pretty-printed in development). Useful fields:

- Every request: `req.id` (also returned as `x-request-id`), method, URL, status, `responseTime`.
- Ingestion: `component:"worker"`, `itemId`, `attempt`, then `ingestion started` → `fetched and extracted page` (bytes, redirects, extraction strategy, chars) → `embeddings generated` (chunks, dims, ms) → `ingestion completed` or `ingestion failed` (`code`, `message`, `willRetry`).
- Query: `component:"query"`, `retrieval completed` (candidates, aboveThreshold, selected, topScore, minScore), `answer generated` (sufficient, cited numbers, `parseFallback`).
- Provider: `component:"ai"`, status/type/code of provider failures (never the key or payloads).

Persisted state complements the logs: `GET /items/:id` shows `status`, `attempts`, `error.code/message`, `startedAt/completedAt`; the SQLite file can be opened directly (`sqlite3 server/data/inbox.db "select id,status,attempts,error_code from items"`). A typical diagnosis: find the item's `itemId` in the UI, grep the logs for it, read the last `ingestion failed` line for the error code, check `GET /health` for the configured models if it is a `provider_error`.

## Tests

```bash
npm test                 # all
npm run test -w server   # 150 tests: unit (chunker, retrieval, answer parsing, IP policy), API integration (supertest, in-memory SQLite, fake AI), security (SSRF, redirects, timeouts, size caps, injection)
npm run test -w web      # 13 tests: add note/URL flows, processing/failed states, retry, ask flow, citations, insufficient evidence, errors
```

Automated tests never call a real provider: `FakeAiProvider` produces deterministic bag-of-words embeddings and scripted JSON answers, so threshold/ranking/citation behaviour is reproducible. Live provider behaviour is verified separately with [`scripts/live-verify.mjs`](scripts/live-verify.mjs), which runs the end-to-end scenario (note → index → answer with citation → unrelated question → restart persistence → failure state) against a running server. See [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for the recorded results.

## Project layout

```
server/src
  index.ts          bootstrap (env, provider, listen, graceful shutdown)
  app.ts            composition root: db, repos, worker, routes, middleware
  config.ts         env schema (Zod)            logger.ts  pino        errors.ts  AppError + codes
  db/               schema.ts (migrations) · connection.ts · itemsRepo.ts · chunksRepo.ts
  routes/           schemas.ts (requests) · contracts.ts (responses) · ingest/items/query/health
  middleware/       validate.ts · errorHandler.ts
  services/         ingestionService · chunker · textNormalizer · urlFetcher · ipPolicy · htmlExtractor
                    retrieval · similarity · answerGenerator · queryService
  providers/        aiProvider.ts (interface) · openAiProvider.ts
  worker/           ingestionWorker.ts
server/test         unit, integration and security tests (+ helpers/fakeAi.ts)
web/src             App.tsx · api/ (client, types) · hooks/ (useItems, useAsk) · components/
web/test            component tests (Testing Library + jsdom)
docs/               TRACEABILITY.md · VERIFICATION.md · WALKTHROUGH.md
scripts/            live-verify.mjs
```

## Current limitations

- Single user, no auth, no rate limiting (per the brief).
- Retrieval is a linear scan; no hybrid/keyword search, no reranker.
- HTML extraction is heuristic; JS-only pages and PDFs are not supported (they fail with a clear `url_unsupported_content` / `extraction_failed`).
- Chunk sizes are character-based approximations of tokens.
- Items cannot be edited or deleted from the UI (not required; `DELETE` would be a small addition and chunks already cascade).
- The relevance threshold is a configured constant, tuned by hand rather than from an evaluation dataset.
