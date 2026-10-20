# Requirement → implementation → verification

Source of truth: `Turium_AI_Interview_Assignment.pdf`. Each row maps a requirement to where it is implemented and how it is verified. "Unit/API" rows run under `npm test` with a fake provider; "Live" rows are exercised by `node scripts/live-verify.mjs` against a real provider (results in `VERIFICATION.md`).

## Functional requirements

| # | Requirement (PDF) | Implementation | Verification |
| --- | --- | --- | --- |
| 1.1 | Add text notes | `routes/ingest.ts`, `services/ingestionService.ts#createNoteItem`, `textNormalizer.ts` | API: `POST /ingest (notes)` suite; Web: `AddContentForm.test.tsx`; Live step 1 |
| 1.2 | Add URLs, fetch page content server-side | `services/urlFetcher.ts`, `htmlExtractor.ts`, `ingestionService.ts#processItem` | API: `POST /ingest (urls)`; Unit: `urlFetcher.test.ts`, `htmlExtractor.test.ts`; Live step 5 |
| 1.3 | Store raw content + metadata (timestamp, source type) | `db/schema.ts` (`items`: `content`, `created_at`, `source_type`, …), `db/itemsRepo.ts` | API: item fields asserted in list/detail tests; Live step 6 (persistence across restart) |
| 2.1 | Intentional chunking strategy | `services/chunker.ts` (paragraph/sentence-aware window with overlap); README "Chunking strategy" | Unit: `chunker.test.ts` (boundaries, overlap, size cap, determinism, no duplicates) |
| 2.2 | Embeddings generation | `providers/openAiProvider.ts#embed` (batched, dimension-validated) | Unit/API via `FakeAiProvider`; Live step 1 (real `nomic-embed-text` / OpenAI) |
| 2.3 | Vector storage | `chunks.embedding` Float32 BLOB + `embedding_model`/`embedding_dims`, `db/chunksRepo.ts` | API: chunk counts, retry idempotency; `countIncompatible` guard |
| 2.4 | Enter a question, retrieve top relevant chunks | `services/retrieval.ts` (`rankChunks`, `selectContext`), `queryService.ts` | Unit: `retrieval.test.ts`; API: `POST /query` suite |
| 2.5 | Pass context + question to LLM | `services/answerGenerator.ts#buildMessages`, `openAiProvider.ts#completeJson` | Unit: `answerGenerator.test.ts` (prompt shape); API: prompt content asserted; Live step 2 |
| 2.6 | Return answer with cited sources | `queryService.ts` citations (validated against sent passages) | Unit: fabricated-citation tests; API: "validated citations pointing at real chunks"; Live step 2 |
| 3.1 | Add note / URL input | `web/src/components/AddContentForm.tsx` | `AddContentForm.test.tsx` |
| 3.2 | List saved items | `ItemList.tsx`, `ItemCard.tsx`, `StatusBadge.tsx`, `hooks/useItems.ts` (polls while processing) | `ItemList.test.tsx` |
| 3.3 | Ask question interface | `AskPanel.tsx`, `hooks/useAsk.ts` (abort stale requests) | `AskPanel.test.tsx` |
| 3.4 | Display answer + source snippets | `AnswerView.tsx` (markers → citations, snippets, open item) | `AskPanel.test.tsx` |
| 3.5 | React with hooks, reasonable state management | Hooks own API state; components are presentational | All web tests |
| 3.6 | Clarity over beauty | Plain CSS, two-column responsive layout, explicit states | Manual |
| 4.1–4.3 | `POST /ingest`, `GET /items`, `POST /query` | `routes/ingest.ts`, `items.ts`, `query.ts` | `api.test.ts` |
| 4.4 | Request/response shape, error handling, validation, naming | `routes/schemas.ts` (Zod), `routes/contracts.ts`, `middleware/errorHandler.ts`, `errors.ts` | `api.test.ts` validation + error-mapping tests |

## Non-functional expectations

| Expectation | Where addressed | Verification |
| --- | --- | --- |
| Chunking rationale | README "Chunking strategy" | — |
| Vector store choice | README "Vector storage rationale" | — |
| What breaks at scale | README "What breaks at scale" | — |
| Production changes | README "Sensible production changes" | — |
| Structured logging | `logger.ts` (pino JSON), `app.ts` (pino-http, request ids), per-stage worker/query logs | Smoke run output in `VERIFICATION.md` |
| Clear error messages | `errors.ts` codes + human messages; UI surfaces them | `api.test.ts`, web tests |
| Sensible HTTP status codes | 202 accepted, 200, 400, 404, 409, 413, 422, 500, 502, 503 | `api.test.ts` |
| Separation of concerns / no god files / no copy-paste / clear naming | routes → services → repos → providers; largest source file ≈ 200 lines | Code review |

## Additional behaviour from the execution plan

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Async ingestion with persisted status, 202 response | `items.status`, `worker/ingestionWorker.ts`, `POST /ingest` → 202 | API: ingestion suites |
| Retries without duplicate chunks | `chunksRepo.replaceForItem` in one transaction, `UNIQUE(item_id, chunk_index)`, deterministic ids | API: "does not duplicate chunks on reprocessing" |
| Interrupted jobs recovered after restart | `itemsRepo.recoverInterrupted` on `worker.start()` | API: "requeues items left in processing after a restart" |
| Manual retry | `POST /items/:id/retry`, UI Retry button | API + `ItemList.test.tsx` |
| SSRF: private/loopback/link-local/IPv6 rejected | `services/ipPolicy.ts`, `urlFetcher.ts#validateUrl/resolveValidatedAddress` | Unit: `ipPolicy.test.ts` (40+ addresses), `urlFetcher.test.ts`; Live step 4 |
| DNS rebinding mitigation | connection pinned to validated IP via custom `lookup` | `urlFetcher.test.ts` "sends the original Host header while connecting to the pinned IP" |
| Redirect re-validation, timeouts, size + content-type limits | `urlFetcher.ts` | `urlFetcher.test.ts` |
| Page content treated as untrusted | `answerGenerator.ts` system prompt + `<passage>` wrapping; no tools | `htmlExtractor.test.ts`, `answerGenerator.test.ts` |
| Relevance threshold + context budget + dedupe | `retrieval.ts#selectContext` | `retrieval.test.ts` |
| Insufficient-evidence state, machine readable | `queryService.ts` `insufficientReason`; `AnswerView.tsx` | API: three reasons tested; `AskPanel.test.tsx`; Live step 3 |
| Embedding model identity + dimensions stored, never mixed | `chunks.embedding_model/embedding_dims`, `listForRetrieval` filter, `rankChunks` length guard | `retrieval.test.ts`, provider dimension validation |
| Provider failures → 502/503, no secret leakage | `openAiProvider.ts#call`, `errorHandler.ts` | API: "maps provider failures to 502/503 with safe messages" |
| Secrets/private content kept out of logs | request serializers log method/url/status only; key never logged | Code review; smoke log |
| Health endpoint | `routes/health.ts` | API + live |
| Duplicate submission protection, stale response protection | `AddContentForm` disabled while submitting; `useAsk` aborts previous | `AddContentForm.test.tsx`, `AskPanel.test.tsx` |
| Item not implied searchable before indexing | `listForRetrieval` only joins `indexed` items; UI shows Queued/Processing and hint text | API: retrieval join; `AskPanel.test.tsx` empty-state hints |
