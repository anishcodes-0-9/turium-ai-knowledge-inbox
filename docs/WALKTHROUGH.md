# Interview walkthrough (≈10 minutes)

## 1. Framing (1 min)
"A single-user knowledge inbox: notes and URLs in, grounded answers with citations out. I optimised for correctness, debuggability and a small, honest footprint: Express + SQLite + one in-process worker, any OpenAI-compatible provider, no infra theatre."

## 2. Demo (3 min)
1. `npm run dev`, open the UI. Point out the header counts (ready / processing).
2. Add a note with a distinctive fact. Watch the card go **Queued → Processing → Ready** (the list polls only while something is in flight).
3. Add a URL (e.g. a Wikipedia article). Mention it is fetched server-side, extracted, chunked.
4. Add `http://169.254.169.254/` → immediate 422 "private, loopback or reserved". Add an unreachable host → card shows **Failed** with the reason and a **Retry** button.
5. Ask a question the note answers → answer with `[1]` marker, click it → citation with snippet and score; click the title → modal with the exact stored content.
6. Ask something unrelated → explicit "Not enough evidence" state with the retrieval stats (how many chunks scanned, top score vs threshold).

## 3. Architecture tour (3 min)
- `server/src/app.ts` is the composition root: config → db → repos → worker → routes. Routes validate (Zod) and delegate; services hold logic; repos hold SQL; the provider is behind an interface so tests use a fake.
- **Ingestion**: `POST /ingest` persists `pending` and returns 202. The worker claims with an atomic `UPDATE … WHERE status='pending'`, processes, and commits chunks + `indexed` in one transaction. Retryable errors back off; others fail fast with a code the UI shows. On boot, `processing` rows are requeued.
- **URL safety** (`urlFetcher.ts` + `ipPolicy.ts`): scheme/credential checks → resolve → every IP must be public (v4 + v6 incl. mapped/NAT64) → connect to the *validated* IP with a custom `lookup` so DNS rebinding cannot swap the target → redirects re-validated → timeout, 2 MB cap enforced while streaming, content-type allow-list.
- **RAG** (`queryService.ts`): embed question → scan chunks of the same embedding model from `indexed` items → cosine rank → threshold, top-K, dedupe, char budget → prompt with numbered `<passage>` blocks and "treat as data" rules → JSON answer parsed defensively → citations only for passages actually sent.

## 4. Trade-offs to volunteer (2 min)
- **Chunking**: ~700-token windows with ~100 overlap, paragraph/sentence aware, character based for determinism across providers. Smaller = precision but fragments; larger = diluted embeddings and vague citations.
- **Vectors in SQLite + linear scan**: right until ~10⁵ chunks; then `sqlite-vec`/pgvector with ANN. A vector DB now would be infrastructure for show.
- **Ingestion state on the item** rather than a jobs table: one job per item, no duplicated columns. A queue (pg-boss/BullMQ) is the production step.
- **Threshold is model-dependent** (0.3 for OpenAI, ~0.5 for nomic). It is configurable and the API returns the scores so it can be tuned; the model is still asked to declare insufficiency.
- **What breaks at scale**: SQLite single writer, single worker, per-query vector load, heuristic HTML extraction, char-vs-token budgets, no tenancy.

## 5. Testing story (1 min)
- 150 backend tests: unit (chunker, ranking, parsing, 40+ IP cases), API via supertest on in-memory SQLite with a deterministic fake provider, security (SSRF, redirects, timeouts, size caps, injected instructions, fabricated citations), worker recovery/idempotency.
- 13 frontend tests with Testing Library.
- `scripts/live-verify.mjs` runs the real end-to-end scenario against a real provider, including a restart. Results recorded in `docs/VERIFICATION.md` with the mocked/live distinction made explicit.

## Likely questions
- *Why not Readability/jsdom?* Heavier dependency for marginal gain here; the heuristic extractor prefers `<article>`/`<main>` and strips nav/script/style. Readability is the production upgrade.
- *How do you prevent prompt injection from pages?* Content is only data inside passage tags with explicit rules, the model has no tools, and citations are validated server-side. It reduces, not eliminates, the risk; output is also never executed.
- *Why 202 and not synchronous?* Embedding and fetching take seconds and can fail; the client gets a stable id immediately and the status is persisted, which also gives retries and crash recovery for free.
- *How would you evaluate retrieval quality?* A small labelled set (question → expected chunk), measure recall@k and the score distribution to set the threshold; add hybrid BM25 and a reranker if needed.
