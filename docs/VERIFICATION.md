# Verification record

This file records only results that were actually observed. Everything not listed under a "verified" heading has not been verified. Each section names the kind of evidence, because a test against the fake provider proves something different from a live model call.

Environment for every run below: macOS on Apple M2 with 8 GB RAM, Node 26.7, npm 11.19. Recorded on 2026-10-21.

## 1. Automated checks

Run from the repository root.

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0, both packages, strict mode |
| `npm test` | exit 0. Server: 9 files, 249 tests passed. Web: 3 files, 15 tests passed |
| `npm run build` | exit 0. Server compiled with `tsc`; web bundle built by Vite |

The timing-sensitive files (`urlFetcher.test.ts`, `worker.test.ts`) were also run three times in a row, and all 83 tests passed each time.

Lint is not configured, so there is no lint result.

`npm run typecheck` runs `tsc --noEmit` with each package's own config. The server config includes only `src/`, so server test files are transpiled by Vitest without type checking. The web config includes `src/`, `test/` and `vite.config.ts`, so web tests are type-checked. A one-off type check of the server tests found one pre-existing strict-mode error in `server/test/helpers/fakeAi.ts` (an array index that may be undefined); it does not affect test behaviour.

### What the automated tests do and do not prove

- **No real AI provider is called.** `server/test/helpers/fakeAi.ts` produces deterministic bag-of-words embeddings and scripted chat replies. Ranking, threshold, citation and failure logic are therefore tested against synthetic vectors, not real embedding geometry.
- **The provider adapter is tested on the real OpenAI SDK with a stubbed `fetch`.** `openAiProvider.test.ts` checks request shape, truncation detection and empty-response handling. It does not contact OpenAI.
- **Database behaviour is real.** Tests use in-memory SQLite through `node:sqlite`, so transactions, constraints, `RETURNING` and claim semantics are exercised for real.
- **URL fetching is real against local HTTP servers.** Tests use a local fixture server with a fake DNS resolver and an IP policy that permits only `127.0.0.1`. This exercises the socket pinning, redirects, deadlines and size limits. It does not exercise public DNS or TLS.
- **Frontend tests mock at the props boundary.** They do not exercise the `useItems` and `useAsk` hooks or the fetch client.

### Regression tests and what they guard

Two different kinds of evidence are recorded here, and they should not be confused.

**Compared against pre-fix code.** The source file for that fix was temporarily reverted (the fetcher, worker and repository files to their committed versions; the answer parser and the worker sweep by removing the fix), the tests were run and the failures observed, then the fixed file was restored and confirmed byte-identical with `cmp`.

| Test | Result against pre-fix code |
| --- | --- |
| `urlFetcher.test.ts` "enforces a total deadline against a slow-drip body" | Failed: a server sending one byte every 50 ms kept a 400 ms fetch alive until the test timed out at 15 s |
| `urlFetcher.test.ts` "times out a DNS lookup that never answers" | Failed: it waited until the test timed out at 15 s |
| `urlFetcher.test.ts` "closes redirect and error responses" | Failed: the server connections for redirect and error bodies were not closed |
| `urlFetcher.test.ts` "counts time spent across redirect hops" | Passed before and after. It guards existing behaviour and does not prove the fix |
| `worker.test.ts`, first 10 tests (loop resilience, bounded shutdown, restart attempt limit) | All 10 failed. The run also reported unhandled promise rejections from the worker loop. Some of these failed only because methods they use did not exist yet: the status snapshot, the boolean returned by `stop()` and the shape returned by recovery. The unhandled rejections and the crash-loop test are the meaningful failures |
| `answerGenerator.test.ts` and `api.test.ts`, strict `sufficient` tests (14) | All 14 failed with the strict check removed: a string, number, null or missing `sufficient` accompanied by a valid citation was returned as an answer |
| `worker.test.ts`, runtime orphan recovery (added as 7 tests) | 4 failed with the sweep disabled: the two recovery tests (final-failure and retry writes), the attempt-limit test and the backoff test. The other 3 passed either way and guard against recovery that is too eager. One of those 3 asserted an "active item" exclusion that the worker never reaches, and was replaced when that parameter was removed |
| `worker.test.ts`, "only processing rows" and "sweeps only while the worker is idle" | Not compared. They pass with or without the fix and document the real invariant: recovery touches only `processing` rows and runs only while no job is in flight |
| `worker.test.ts`, outcome writes conditional on `processing` (repository and worker level) | 10 failed with the status guards removed: late failure after indexing, stale success after failure, no-op writes on pending, indexed and failed rows, late final and retryable failures, stale success rolling back its chunks, and the lost race not counting as a failure |
| `answerGenerator.test.ts`, `api.test.ts` and `AskPanel.test.tsx`, model-reported insufficiency carries no model text | 5 failed with the pre-patch parser, query service and view: three parser assertions and one API test (the model's unsupported claim reached the response), and one UI test (it was shown as a "Model note") |
| `worker.test.ts`, worker lifecycle (4 tests) | 3 failed against the unfixed worker: restart after a timed-out stop was accepted (a probe showed the live job reset to `pending` and run twice, with two provider calls), a second `start()` re-ran recovery, and repeated `start()` calls produced 4 provider calls for 3 items. The clean stop-and-restart test passed either way |
| `api.test.ts` and `worker.test.ts`, conditional `setContent` | 2 failed with the unconditional write: a stale URL fetch replaced the content of an item another writer had finished, and the repository write applied outside `processing` |
| `api.test.ts`, manual retry when the item changes between check and write | Failed with the unconditional retry write: a `processing` item was flipped to `pending` with its attempts reset, and the route returned 202 |
| `answerGenerator.test.ts` and `api.test.ts`, ordinary bracketed numbers | 3 failed under the old rule that stripped every out-of-range marker: ordinary `[0]` and `[9]` kept (parser and API) and an undeclared out-of-range number left in the text. The other bracket tests pass either way and guard behaviour that was meant to be preserved |

For every row added after the first patch (strict `sufficient`, runtime recovery, status guards, bracketed numbers), "pre-fix" means the uncommitted code immediately before that change, not the committed HEAD.

**Run against the current code only. No comparison with pre-fix code was performed.** These tests pass now. Whether they would fail on the older code has been inferred from reading it, not observed.

| Test | What it covers |
| --- | --- |
| `answerGenerator.test.ts`: 4-digit numbers such as `[2026]` and malformed markers (`[1a]`, `[ 1 ]`, `[-1]`, `[1.5]`, `[]` and others) treated as ordinary text | Characterise behaviour that already held: these are neither citations nor stripped |
| `worker.test.ts`: `requeue` option matrix and attempt reset | Characterise existing SQL behaviour for every combination of current status and `onlyIfStatus` |
| `answerGenerator.test.ts`: unparseable output, truncated JSON, empty or non-string answers, uncited `sufficient: true`, invalid-marker stripping, truncated completion rejected | Model output that is malformed, truncated or cites nothing valid must not be reported as an answer |
| `api.test.ts`: "never reports sufficient evidence when the model …" (uncited claim, prose, truncated JSON) and the token-limit 502 | The same behaviour through `POST /query` |
| `openAiProvider.test.ts` | Truncation flag, empty completion and request shape, on the real SDK with a stubbed `fetch` |
| `AskPanel.test.tsx` unverifiable-answer state | The UI shows no answer or sources for that state |

## 2. Live checks with Ollama

Command, run from the repository root:

```bash
AI_BASE_URL=http://127.0.0.1:11434/v1 AI_API_KEY=ollama \
EMBEDDING_MODEL=nomic-embed-text CHAT_MODEL=qwen2.5:1.5b \
AI_TIMEOUT_MS=180000 AI_MAX_RETRIES=0 \
node scripts/live-verify.mjs --min-score 0.5
```

The script starts its own server on a temporary database, which it deletes afterwards. It calls the local Ollama server, plus one public fetch of `https://example.com/`.

### Latest run, on the current code including the worker lifecycle fix: 15 of 15 checks passed

| Check | Observed |
| --- | --- |
| Server starts, health reports models | `nomic-embed-text` / `qwen2.5:1.5b` |
| `POST /ingest` note returns 202 pending | yes |
| Note reaches `indexed` | 1 chunk, about 3.0 s |
| "What is the name of the office plant?" | answer `Gerald`, sufficient evidence, cites the note, score 0.751 |
| "Who waters the office plant?" | answer `Priya`, sufficient evidence, cites the note, score 0.719 |
| "What is the boiling point of tungsten in kelvin?" | `sufficientEvidence: false`, reason `no_relevant_chunks`, top score 0.385, no citations |
| Metadata-service URL `http://169.254.169.254/…` | rejected at submission with 422 `url_blocked` |
| Unresolvable host | item ends `failed` with `url_fetch_failed: Could not resolve hostname …` |
| `https://example.com/` | fetched, extracted (title "Example Domain", 156 chars) and indexed |
| Restart | note still `indexed`; "Who waters the office plant?" again answered `Priya` with a citation to the note |

### Earlier runs, kept for the record

- **Chat model `llama3` (8B), 7 of 12 checks passed.** The model could not run usefully in 8 GB of RAM; chat requests exceeded the 30 s provider timeout. Embeddings, URL checks and persistence passed. Every query returned `502 provider_error` with a safe message, which incidentally verified the provider-timeout path. This was a resource limit, not an application defect.
- **Chat model `qwen2.5:1.5b`, before the fixes, 11 of 12 checks passed.** The failing check asked one question about both the plant's name and who waters it. The model answered "a fiddle-leaf fig … watered by Priya": it gave the species, not the name. The question was ambiguous and the model also missed a fact, so the script now asks two single-fact questions. Each answer must still state its fact and cite the note.

After the strict `sufficient` change (same command): 15 of 15 checks passed again, with the same answers (`Gerald`, `Priya`) and scores (0.751, 0.719, unrelated 0.385). One run on one small model: it shows `qwen2.5:1.5b` emitted a boolean `sufficient`, not that every model will.

Re-run after the outcome-write status guards and the bracketed-number change (same command): 15 of 15 checks passed again. Re-run again after insufficient answers stopped carrying model text and the content and manual-retry writes became conditional: 15 of 15 passed. Re-run once more after the worker lifecycle fix, the latest run: 15 of 15 passed with the same answers and scores shown in the table above.

### What the live run shows about the relevance threshold

With `nomic-embed-text`, on-topic questions scored 0.72 to 0.76 and the unrelated question scored 0.39. The default threshold of 0.30 would have let the unrelated question through to the chat model, so the run used 0.5. This is one note and three questions, not a calibration.

## 3. Manual checks

These were run by hand during development, against a server on a scratch database.

- `GET /health` returned 200 with an `x-request-id` header.
- An unknown route returned the JSON 404 envelope with a `requestId`.
- A malformed JSON body returned 400 `validation_error` "Request body is not valid JSON".
- Server logs were newline-delimited JSON with request ids, status and response time, and no request bodies.
- The built frontend was served from the API port.
- With `npm run dev`, the Vite dev server proxied `/health` to the backend.
- Headless Chrome screenshots of the built UI were reviewed at 1280 px and 390 px wide. They showed the failed, ready and URL item states with no horizontal overflow.
- Two SQLite connections to one database file (two application contexts inside one Node process, via throwaway scripts that are not in the repository). Before the status guards, a late failure from the first connection turned an item the second had already indexed into `failed`, with its chunks still stored. After the guards, the item stayed `indexed` with no error. In the same setup the second connection still reclaimed and re-processed a running job, so both called the embedding provider once. The guards protect stored state and do not prevent duplicate work. Two separate operating-system processes were not run.
- Real-process shutdown and restart recovery, run once with `INGEST_MAX_ATTEMPTS=2`. A throwaway server was pointed at a local stub endpoint that accepted connections and never answered. After one note was ingested: SIGTERM exited with code 0 after about 10 s, logged that it stopped without waiting for the in-flight item, and left the item `processing` with 1 attempt. On the second boot the item was requeued and claimed as attempt 2, and SIGTERM was sent again. On the third boot it was marked `failed` with code `interrupted` and the attempt-limit message. This ran before the runtime orphan recovery was added and has not been repeated since.

## 4. Real OpenAI API

The app was run locally with `npm run dev` against the real OpenAI API, using the defaults from `server/.env`: `AI_BASE_URL=https://api.openai.com/v1`, `EMBEDDING_MODEL=text-embedding-3-small`, `CHAT_MODEL=gpt-4o-mini`, `RETRIEVAL_MIN_SCORE=0.30`, 2 retries and a 30 s timeout.

**Observed by the author in the UI.** None of this is stored in the repository.
- A saved note was answered correctly with a citation to it.
- An unrelated question returned the insufficient-evidence state.
- A Wikipedia article was ingested and indexed, and a question about it was answered with a citation.

**Verified afterwards from the local database,** opened read-only:
- Two items, a note and `https://en.wikipedia.org/wiki/Retrieval-augmented_generation`, are both `indexed` after 1 attempt each. The article's extracted text is 16,446 characters.
- All 9 stored chunks, 1 for the note and 8 for the article, are `text-embedding-3-small` vectors of 1,536 dimensions. That is OpenAI's model and dimension; the Ollama embedding model used elsewhere produces 768.

**Verified with a non-billable call:** `GET https://api.openai.com/v1/models` with the configured key returned 200, and both `text-embedding-3-small` and `gpt-4o-mini` were listed.

**Not observed:**
- Server logs from those sessions. The dev server logs to its terminal only, and nothing was retained.
- The chat responses themselves. Answers are not persisted, so the chat calls are inferred from the author's observations and the single configured provider.
- The relevance scores, and which insufficient-evidence reason the unrelated question produced.
- `scripts/live-verify.mjs` was not run against OpenAI.

## 5. Not verified

- **OpenAI error responses.** Rate limits (429), invalid credentials (401) and model errors are mapped in code but were not exercised against the real API. The 0.30 threshold has not been calibrated against recorded OpenAI scores.
- **Provider error mapping in tests.** `OpenAiProvider.call` is not covered by an automated test for 429, 401, 400 or 5xx responses.
- **Truncation against a real model.** Truncation is unit-tested with stubbed responses. No real model was driven to `finish_reason: "length"`.
- **Process-level fatal handlers.** The `unhandledRejection` and `uncaughtException` handlers in `server/src/index.ts` were checked by reading the code only.
- **Graceful shutdown with a hung URL fetch.** Shutdown was exercised against a hung AI provider (see Manual checks), not a hung URL fetch.
- **Runtime orphan recovery against a real database failure.** It is tested by making repository methods throw once or repeatedly. It has not been exercised with a genuinely locked or full database file. It relies on exactly one in-process worker owning the table, assumed and not enforced, because the schema has no lease or owner column to tell active work from orphaned work.
- **Public DNS and TLS edge cases.** The SSRF policy is tested with a fake resolver. The only public fetch was `https://example.com/`.
- **Frontend hooks and browser interaction.** Polling, stale-response guards and the detail dialog were not driven end to end in a browser.
- **Scale.** No load, concurrency or large-corpus testing was done.
