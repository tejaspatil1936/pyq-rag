# PROJECT: MITAoE PYQ Analytics + RAG — as-built

This document describes the system as it exists in the code today. It is
regenerated from the codebase, not maintained as a spec — if you change
behavior, update this file in the same commit.

## 1. What this is

A Next.js (App Router) web app where a student picks a subject and asks
questions about MITAoE's previous-year exam papers. A Python pipeline
(GitHub Actions only) streams ~4,700 papers through download → text
extraction → Gemini question extraction → embedding → clustering → topic
labeling, storing everything in Neon Postgres/pgvector. The runtime
(`/api/ask`, Vercel) classifies each query into one of six intents plus a
greeting/refusal path, answers frequency and topic-ranking questions
deterministically from real SQL counts, and answers open-ended questions
with pgvector retrieval + Gemini synthesis grounded in cited source
questions. A response-invariants layer checks every outgoing answer before
the client sees it. Everything runs on free tiers.

## 2. Architecture as-built

### 2.1 Data pipeline (`pipeline/*.py`, orchestrated by `.github/workflows/ingest.yml`)

Steps run in this order, every ingest cron tick:

1. **`apply_schema.py`** — applies `schema.sql`, idempotent.
2. **`fetch_metadata.py`** — `GET https://mitaoe-pyqs.vercel.app/api/papers`,
   upserts into `papers` by `url` (`ON CONFLICT DO UPDATE`); new rows land
   `status='pending'`, existing rows keep their processing status.
3. **`ingest.py`** — batch loop, default 300 papers/run (`--limit`). Per
   pending paper, streaming: download PDF (≤40 MB, 120 s timeout) →
   `extract_text.py` (PyMuPDF text layer; under `MIN_TEXT_CHARS=100`, OCR
   fallback — PyMuPDF rasterizes each page at 200 DPI, Tesseract reads it)
   → PDF deleted in a `finally` block regardless of outcome → Gemini
   extraction through the shared key pool → questions saved (delete-then-
   insert, one transaction) → paper marked `done`/`failed`. One bad paper
   never aborts the run (`mark_failed`, continue); when every pool key is
   exhausted the run exits **cleanly (code 0)** for the next cron tick; an
   unusable model (`ModelNotFound`/`ModelHasNoFreeTier`) aborts loudly
   (exit 1) since key rotation can't fix that. `extract_method`
   (`'text'`\|`'ocr'`) is saved per paper — added after the original
   ingest, so it's `NULL` for papers processed before that (see §5).
4. **`embed.py`** — `sentence-transformers/all-MiniLM-L6-v2` on CPU,
   384-dim, `normalize_embeddings=True`, 256 questions/round-trip, loops
   until no `NULL` embeddings remain.
5. **`cluster.py`** — agglomerative clustering (average linkage, cosine
   distance) per `standard_subject`, threshold `CLUSTER_COSINE_THRESHOLD =
   0.80` with per-subject overrides in `CLUSTER_THRESHOLD_OVERRIDES`
   (`Network Analysis Techniques`, `Structural Analysis`, `Solid Mechanics`
   → `0.88` — formula/figure-heavy subjects the default over-merges). Only
   subjects with new unclustered questions rerun by default (`--all` forces
   a full rebuild); `MAX_CLUSTER_SUBJECT_SIZE = 12,000` guards O(n²) memory
   blowup. Each subject rebuilds atomically (clusters replaced, every
   `cluster_id` reassigned in one transaction); the representative question
   is the member closest to the centroid.
6. **`label_topics.py`** — Gemini labels clusters `WHERE topic IS NULL` in
   batches of 40 (`TOPIC_LABEL_BATCH`), then greedily merges near-duplicate
   labels per subject: labels whose embeddings are
   ≥`TOPIC_MERGE_THRESHOLD=0.85` cosine-similar to an already-kept (higher
   `question_count`-weighted) label are remapped to it.
7. **`stats.py`** — prints a run summary into the job log; the same
   numbers back `/api/stats`.

**Not in the cron.** `pipeline/audit_subjects.py` (rebuilds `subject_stats`
— the small-corpus/figure-heavy/text-twin-risk signals the runtime reads)
and `pipeline/quality_check.py` (manual spot-check sampler, wired to
`quality-check.yml` via `workflow_dispatch` only) are **not** steps of
`ingest.yml`. `subject_stats` is only as fresh as the last manual
`python pipeline/audit_subjects.py` run against `DATABASE_URL`.

**Key rotation.** `GEMINI_API_KEYS` (comma-separated, 1..N, dynamic count —
never hardcoded) is shared between pipeline and runtime. Pipeline
(`pipeline/key_manager.py`, `KeyManager`): synchronous round-robin; a
per-minute 429 cools that key for `RATE_LIMIT_COOLDOWN_S` (60 s, or the
API's own `retryDelay`); a daily-quota 429 (or 401/403) benches it for
`QUOTA_COOLDOWN_S` (24 h); once every key's cooldown exceeds `MAX_WAIT_S`
(300 s), `AllKeysExhausted` is raised and the run exits cleanly. Runtime
(`lib/key-rotator.ts`, per Vercel instance, no shared state): each cold
instance starts at a **random** index (spreads load with no coordination)
and advances per request, with identical cooldown/daily-bench semantics;
only when every key is benched does a caller see `GeminiUnavailable`. Key
**values** are never logged anywhere, only their index. Model:
`GEMINI_MODEL` env, default `gemini-3.1-flash-lite`; both sides send a
minimal-thinking config and step down a fallback ladder when the model
rejects it, then stick with what worked. Extraction/labeling JSON parse
failures are logged and retried once with a repair prompt; a second
failure fails only that unit (one paper, one label batch) — never the
whole run.

### 2.2 Database schema (`pipeline/schema.sql`)

- `papers(id, file_name, url UNIQUE, year, branch, semester, exam_type,
  subject, standard_subject, status, error, extract_method, created_at)` —
  `extract_method` (`'text'`\|`'ocr'`) added after the original ingest.
- `questions(id, paper_id FK, question_text, marks, sub_label, embedding
  vector(384), cluster_id, has_figure, created_at)` — `has_figure` is
  regex-backfilled by `audit_subjects.py`, not set at extraction time.
- `clusters(id, standard_subject, representative_text, question_count,
  papers_count, years_spanned, topic)` — `topic` is the canonical label
  assigned by `label_topics.py`.
- `subject_stats(standard_subject PK, papers, exams, questions, clusters,
  pct_labeled, distinct_years, years JSONB, pct_ocr, pct_figure,
  max_cluster_size, max_cluster_texts, text_twin_risk, label_contamination,
  computed_at)` — not in the original design; powers every adaptive-honesty
  behavior below. `pct_ocr` is `NULL` until a subject has a tracked
  `extract_method`.
- Indexes: `questions(cluster_id)`, `questions(paper_id)`,
  `papers(standard_subject, status)`, `clusters(standard_subject)`,
  `clusters(standard_subject, topic)`, ivfflat on `questions.embedding`
  (cosine ops, `lists=100`).

### 2.3 Runtime API — `POST /api/ask` (`app/api/ask/route.ts`)

Request: `{ subject, question, history? }`. `history` is capped server-side
(≤6 turns, ≤1200 chars/turn, ≤6000 chars total — the client's stated size
is never trusted). Pipeline, in order:

1. **Normalize** (`lib/normalize.ts`): expands study shorthand (`imp` →
   `important`, `ques`/`qs`/`qstn` → `questions`, `freq`, `yr`, `sem`,
   `defn`, `expln`, `w/o`, `b/w`, `diff`, …) and edit-distance-repairs
   typos in 8 high-value routing tokens (`important`, `questions`,
   `topics`, `study`, `repeated`, `weightage`, `explain`, `asked`).
2. **Rate-limit gate** (total tier — §2.7) → 429 before any DB/LLM work.
3. **Cache lookup** (single-turn only — §2.6).
4. **`subjectExists`** → 404 if unknown; **`getSubjectStats`** feeds
   small-corpus/figure-heavy adaptive behavior, `null`-safe when
   `audit_subjects.py` has never run.
5. **`GREETING`** — a bare `"hi"`/`"?"`/similar (regex, `lib/scope.ts`)
   short-circuits to a capabilities nudge before the classifier runs.
   **Abuse prefilter** (`prefilterAbuse`, layer 0) — zero-cost regex
   catches unambiguous jailbreak/persona/off-topic-task patterns →
   `REFUSED`, free, before spending a Gemini call. **Unresolved bare
   reference** ("explain this" with zero history) → a clarification
   response, never a guessed substitution.
6. **`classifyIntent`** — one Gemini call (JSON mode, 15 s timeout) returns
   `{in_scope, intent, topic, rewritten, top_n, solving, predictive, year,
   exam_type}` together (never two calls). On any Gemini failure it falls
   back to `classifyHeuristic` — pure regex — so **both analytics paths
   keep working with zero LLM dependency**. An out-of-scope verdict for an
   archive-referential phrasing ("what gets asked about X") is rescued
   into `TOPIC_ANALYTICS` instead of refused (honest-zero: "0 of N exams").
7. **`coerceClassification`** — deterministic corrections for classifier
   drift observed in testing: skip/deprioritize phrasing → `STUDY_GUIDE`
   (only that path carries the rarely-asked tail); a query that's *only* a
   year/exam-type filter ("last year's ESE") → `ANALYTICS`; "how many
   times/often" phrasing → `TOPIC_ANALYTICS`; a detected solve request
   (`SOLVING_RE`) → `SEMANTIC` unless it's actually a count question.

**The six classifier intents, plus `GREETING` and `REFUSED`:**

- **`ANALYTICS`** — `topClusters()`: SQL ranked by distinct-exam count
  (`EXAM_KEY_SQL` dedupes re-uploaded exam sittings — §2.3.1), optional
  year/exam-type filter. Zero LLM calls; prose formatted in code
  (`formatAnalyticsAnswer`). Small-corpus and figure-heavy
  (`FIGURE_HEAVY_SHARE=0.25`) caveats appended when applicable; filtered
  to zero → honest-empty with nearest year on file.
- **`TOPIC_ANALYTICS`** — label-first: `matchTopicLabel()` matches the
  query phrase against the subject's canonical topic labels by token-set
  containment; on a hit, `labelClusters()`/`labelExamCount()` answer from
  exactly that label so the count agrees with the weightage table. No
  match (or an ambiguous tie) falls back to `topicClusters()` — embedding
  similarity between the topic phrase and each cluster centroid, threshold
  `TOPIC_MATCH_THRESHOLD=0.4`. Zero LLM calls. A zero-match answer
  unconditionally leads "appeared in **0** of M exams". Capped lists
  (`MAX_TOPIC_CLUSTERS=150` ceiling) say "Showing top K of N" unless the
  query asked for "all questions" (`isExhaustiveQuery`).
- **`TOPIC_WEIGHTAGE`** — `topicWeightage()`: topics ranked by
  distinct-exam coverage, then summed marks. Zero LLM calls; prose
  formatted in code (`formatTopicWeightageAnswer`).
- **`YEAR_TREND`** — `yearTrend()`: per-year distinct-exam counts per
  topic; `rising`/`staple`/`fading` computed relative to the newest year on
  file (rising = first appeared within 2 years and still current; fading =
  absent 2+ years; staple = long-standing and current); labels suppressed
  entirely below `TREND_MIN_YEARS=3` distinct years. Zero LLM calls. Falls
  back to `ANALYTICS` if the subject has no labeled topics yet.
- **`STUDY_GUIDE`** — the only analytics-family intent that calls Gemini.
  `synthesizeStudyGuide()` injects the deterministic weightage table into a
  `<topic_weightage_data>` block (rules stated once outside; all corpus/
  user-derived content sits inside delimited, explicitly untrusted blocks —
  the structural defense against prompt injection). The rarely-asked tail
  (`topicTail()`, `SKIP_TAIL_MAX_EXAMS=3`) is attached only when
  `isSkipQuery()` is true. Server-side, independent of the prompt:
  `skipContractViolation()` checks the draft names no >3-exam topic as
  skippable and contains "not skippable"; one corrective retry, then a
  deterministic fallback (`formatSkipFallback`) if it still violates.
- **`SEMANTIC`** — `embedQuery()` (transformers.js, quantized ONNX port of
  the *same* `all-MiniLM-L6-v2` weights the pipeline uses, in-process on
  Vercel, cached in `/tmp`) → `semanticSearch()` (pgvector cosine,
  `WHERE standard_subject = $1` in SQL before any vector op, `DISTINCT ON`
  de-duplicating repeat uploads) → grounding floor
  (`SEMANTIC_MIN_SIMILARITY=0.45`, `MIN_GROUNDING_HITS=2`). Below the floor:
  honest no-answer with topic suggestions (a safety net re-routes core
  study-vocabulary queries to `TOPIC_WEIGHTAGE` instead of dead-ending).
  Above it: `synthesizeAnswer()` cites `[n]`; conceptual "explain X"
  questions may draw on general subject knowledge but anchor it to
  retrieved questions, everything else is retrieval-only. Numbered
  references ("solve question 2") resolve against the last numbered list
  in `history`, or the route asks rather than guesses. **Gemini is never
  used for embeddings** — superseded by the local model, which runs fine
  on Vercel.
- **`GREETING`** / **`REFUSED`** — not classifier outputs; short-circuits
  around classification (step 5 above), plus `REFUSED` from `guardOutput()`
  tripping on a leaked persona-switch/jailbreak marker.

All synthesized (Gemini) prose passes through `synthesizeWithQuality()`:
draft → `checkAnswerQuality()` (word cap — 150 for `STUDY_GUIDE`, 200 for
`SEMANTIC`; banned filler/consultant-speak phrases; bold-verdict-first
shape) → one corrective retry listing the concrete violations → serve the
better draft either way (availability over polish), logging a failure.
Post-synthesis every answer is scrubbed: `guardOutput` (injection-leak
detector) → `stripContradictoryPreamble` (drops a non-coverage refusal the
model bolted onto an answer it then gave anyway) → `stripInternalNames`
(backup scrub for prompt-vocabulary leaks) → `normalizeCitations`
(`SEMANTIC` only — repairs `[1, 5]`/`(1,2,4)`/"as seen in 3" into `[1][5]`).

**2.3.1 Exam-sitting dedup** (`EXAM_KEY_SQL`, `lib/analytics.ts`): one exam
is often uploaded multiple times ("(2).pdf", filename typos), so every
frequency count above is `COUNT(DISTINCT (standard_subject, year,
exam-session-parsed-from-filename, exam_type, semester, branch))`, computed
at query time — never migrated into stored counts — so it stays correct
after every future ingest/recluster with no pipeline change needed.

### 2.4 Invariants layer (`lib/invariants.ts`)

`checkResponseInvariants()` runs on every `/api/ask` response body right
before it returns (`respond()` in the route). Checks: non-empty answer, no
internal prompt-vocabulary leakage, denominator integrity (no shown count
exceeds `total_exams`), nested-total integrity (previews never exceed
their true totals), scope fidelity ("Showing top K of N" on capped lists),
filter propagation (an active filter is echoed in `body.filters`), skip
safety (every `skip_candidates` entry ≤3 exams, "not skippable" present),
and small-corpus humility (`small_corpus` flag + caveat under threshold).
Violations are **logged loudly** (`evt: invariant_violation`) as bugs to
fix at the source — deterministic paths should never trip this — but the
response is still served; availability wins over blocking on a self-check.
LLM-path issues (quality, skip contract) have their own reject/retry
upstream, so this is the final residual catch.

### 2.5 Degraded mode, caching, rate limiting

**Degraded mode:** `GeminiUnavailable` (all keys benched, network/timeout)
never 500s the app. `classifyIntent` silently falls back to
`classifyHeuristic` (regex). `STUDY_GUIDE` falls back to the deterministic
`TOPIC_WEIGHTAGE` answer with `degraded: true`; `SEMANTIC` falls back to
raw retrieval (citations, no prose) with `degraded: true` (not cached).
`ANALYTICS`/`TOPIC_ANALYTICS`/`TOPIC_WEIGHTAGE`/`YEAR_TREND` never touch
Gemini, so they're immune to key exhaustion entirely. `/api/health`
reports `gemini.{configured, keys, available, benched, model}` plus DB
liveness, for uptime monitoring.

**Caching** (`lib/cache.ts`): in-memory `Map` on `globalThis`, per warm
Vercel instance (a cache row is worthless without a warm instance anyway,
and a DB-backed cache costs a round-trip on every hit). Key: `subject +
normalized question`. TTL 6 h, capped at 500 entries, insertion-order
eviction. Only single-turn (history-free) requests are cached; degraded
and clarification responses opt out explicitly.

**Rate limiting** (`lib/ratelimit.ts`): in-memory sliding-window counters
per warm instance, keyed on `sha256(salt + ip)` truncated to 16 hex chars
(`RATE_LIMIT_SALT`) — raw IPs are never stored or logged. Two tiers: a
total cap on every `/api/ask`/`/api/topic-questions` call
(`RATE_LIMIT_TOTAL_PER_HOUR`, default 120/h) and a strict cap on Gemini
**synthesis** calls only (`RATE_LIMIT_SYNTH_PER_HOUR`, default 10/h) —
SQL-only analytics paths are effectively uncapped. IP is read from
`x-forwarded-for`'s first entry, `"local"` otherwise.

## 3. Non-negotiable rules

Carried forward, verified true in the current code:

- **Question-level atomicity.** The atomic unit is one extracted question
  row; no page-chunk or whole-PDF representation exists anywhere.
- **SQL subject isolation.** Every retrieval path (`semanticSearch`,
  `topicClusters`, `topClusters`, …) filters `standard_subject` in the SQL
  `WHERE` clause before any vector or LLM operation — never LLM-enforced.
- **Scope-fidelity, denominator integrity, filter propagation, skip
  safety, grounding, honest emptiness, small-corpus humility, no internal
  vocabulary** — all machine-enforced by `lib/invariants.ts` (§2.4) on
  every response, not just prompted for.
- **Free-tier only.** Neon Postgres+pgvector, Gemini free tier, GitHub
  Actions for all pipeline compute, Vercel for hosting. The corpus is
  embedded by `sentence-transformers` (Python, CPU, in Actions); the
  runtime embeds *queries* with `transformers.js` (an ONNX port of the same
  model, in-process on Vercel) — **not** a paid embedding API and, contrary
  to the original plan, not a Gemini embedding call either, since the local
  model runs fine on Vercel.
- **The user's machine never touches a PDF.** All ingestion happens in
  GitHub Actions; PDFs are deleted immediately after extraction (`finally`
  block in `ingest.py`), win or lose, never stored anywhere.
- **Secrets hygiene.** `.env*` is gitignored except `.env.example`;
  `GEMINI_API_KEYS` count is read dynamically everywhere — nothing assumes
  a specific number of keys; key values are never logged, only their index.

Superseded by the as-built behavior (do not reintroduce):

- "LLM only formats, never invents" for analytics — the code goes further:
  `ANALYTICS`, `TOPIC_ANALYTICS`, `TOPIC_WEIGHTAGE`, and `YEAR_TREND` never
  call an LLM at all; only `STUDY_GUIDE` and `SEMANTIC` touch Gemini.
  Keeping every analytics intent LLM-free is the load-bearing invariant.
- "Gemini's free embedding endpoint for query-time" — dropped; see above.
- The original two-intent model (`ANALYTICS`/`SEMANTIC`) — superseded by
  six classifier intents plus the `GREETING` short-circuit and `REFUSED`
  outcome.

## 4. Key numbers

Corpus (live, queried 2026-07-21): 4,664 papers total — 4,655 `done`, 9
`failed`, **0 pending** (backlog clear; the ingest cron should move to its
monthly cadence per the comment in `ingest.yml`). 50,704 extracted
questions, 100% embedded and clustered, into 23,517 clusters across 230
subjects, 100% topic-labeled. 93 of 230 subjects (~40%) are below the
small-corpus thresholds. `extract_method` is tracked for **0 of 4,664**
papers — tracking landed after the whole corpus was already ingested (see
§5). This deployment is configured with 3 Gemini API keys (deployment-
specific; must never be assumed elsewhere in code).

Thresholds and their calibration basis:
- `CLUSTER_COSINE_THRESHOLD = 0.80`, overridden to `0.88` for `Network
  Analysis Techniques`, `Structural Analysis`, `Solid Mechanics` (formula/
  figure-heavy subjects the default over-merges — flagged by
  `audit_subjects.py`'s text-twin-risk metric). `TOPIC_MERGE_THRESHOLD =
  0.85` (label-embedding similarity for collapsing near-duplicate names).
- `TOPIC_MATCH_THRESHOLD = 0.4` — calibrated live: "hashing" scores
  0.39–0.61 against Data Structures' own hash clusters, 0.33 against the
  nearest off-topic cluster, cross-subject noise stays <0.15.
- `SEMANTIC_MIN_SIMILARITY = 0.45`, `MIN_GROUNDING_HITS = 2` — calibrated
  live with production full-scan search: on-topic queries score 0.68–0.88
  top-1 (weakest observed: 0.680); obscure/adjacent queries top out at
  0.418; cross-domain noise sits below 0.27.
- `SMALL_CORPUS_EXAMS = 8`, `SMALL_CORPUS_QUESTIONS = 100`,
  `TREND_MIN_YEARS = 3`, `FIGURE_HEAVY_SHARE = 0.25`,
  `SKIP_TAIL_MAX_EXAMS = 3`.
- `PRIORITY_MUST_RATIO = 0.35`, `PRIORITY_SHOULD_RATIO = 0.15` (fraction of
  a subject's exams — client-side tier badges in `AnswerView.tsx`).
- `PROSE_WORDS_STRATEGY = 150`, `PROSE_WORDS_EXPLAIN = 200`;
  `MAX_TOPIC_CLUSTERS = 150` (exhaustive-query ceiling / "top K of N"
  denominator).

Quota / pipeline limits: ingest batch 300 papers/run (`--limit`); topic
labeling 40 clusters/Gemini call; embedding 256 questions/DB round-trip;
`MAX_CLUSTER_SUBJECT_SIZE = 12,000` (O(n²) memory guard); per-minute
cooldown 60 s (or the API's `retryDelay`); daily-quota bench 24 h
(pipeline) / next UTC midnight+30s (runtime); rate limits 120 requests/h
total, 10 synthesis calls/h per salted-IP-hash (both env-overridable);
cache 6 h TTL, 500 entries, per warm instance.

## 5. Known limitations

Pulled from `FINDINGS.md` — deliberately unfixed taxonomy/data-source
issues, not code defects:

- **Subject taxonomy split twins** likely belong merged: `Data Structures`
  (927 q)/`Advanced Data Structures` (137 q); `Materials Engineering`
  (1,010 q)/`Material Engineering` (6 q, 1 exam); `Solid Mechanics`
  (737 q)/`Mechanics of Solids` (290 q); `Robot Fundamentals and
  Kinematics`/`Kinematics and Dynamics of Robots`. Needs an owner decision
  plus a `standard_subject` update and recluster.
- **`Science of Nature` is a mega-merge** — spans Engineering Physics,
  Statistics & Integral Calculus, and Basics of Civil Engineering under one
  label because the raw `subject` metadata can't be split reliably.
- **Tiny, possibly misfiled subjects** (`Network Security`: 1 exam, 4
  questions, reads like Computer Networks content; ~10 others with a
  single exam on file) — small-corpus mode covers the UX; whether they
  should exist as subjects is unresolved.
- **OCR share is unmeasurable for the existing corpus** — `extract_method`
  was added after the original ingest (confirmed live at 0 of 4,664 papers
  tracked); backfilling means re-downloading and re-processing every PDF.
- **Applied Mathematics has a 127-member cluster (82 distinct texts)** —
  likely a 0.80-threshold over-merge of similar formula phrasings; a
  stricter override would wipe and relabel 570 clusters, parked pending
  approval.
- **Residual text-twin risk after 0.88 reclustering**: `Structural
  Analysis` 7.4%, `Network Analysis Techniques` 6.6% of clusters are
  identical question text with a *different figure* — text embeddings
  can't split these at any threshold; real fix needs figure-aware ingest
  (per-question image hashing), so the serving layer annotates these
  counts instead. `Facility Planning and Design` sits over the same risk
  threshold (4.65%, 43 clusters) but is too small to justify reclustering.
- **Label contamination is measured, not fixed** — the contradicting-
  keyword check finds 12 questions in `Data Structures` (mostly
  singly-linked-list questions filed under "Doubly Linked List
  Operations") and 3 in `Design of Steel Structures`; a relabeling policy
  decision, rechecked on every `audit_subjects.py` pass.
- **Near-duplicate label variants can persist** below the 0.85 merge
  threshold across subjects — spot-checked, not exhaustively audited.

## 6. Operations

### Workflows (`.github/workflows/`)

- **`ingest.yml`** — cron `0 */4 * * *` (every 4 h while backlog exists;
  the workflow's own comment says to switch to monthly `0 3 1 * *` once
  `pending` stays at 0, which it currently does — see §4), plus
  `workflow_dispatch` with a `limit` input (`5` for a smoke test).
  `concurrency: group: ingest, cancel-in-progress: false` — never two
  ingests at once. Installs `tesseract-ocr` via apt, caches the HF model
  dir, installs CPU-only torch, then runs schema → metadata sync → ingest
  → embed → cluster → label → stats in sequence.
- **`api-tests.yml`** — `workflow_dispatch` only; runs `npm test` against
  the **live** Neon `DATABASE_URL` and live `GEMINI_API_KEYS`, not a mock.
- **`quality-check.yml`** — `workflow_dispatch` with a `sample` input
  (default 20); runs `pipeline/quality_check.py` (DB-only) to print
  extracted questions next to their source PDF URL for manual comparison.
- **Not scheduled anywhere:** `pipeline/audit_subjects.py` (`subject_stats`
  refresh) — run it manually against `DATABASE_URL` whenever corpus
  composition changes meaningfully; the adaptive-honesty behaviors in §2.4
  are only as fresh as its last run.

### Env contract

`DATABASE_URL` (Neon, pgvector; use the pooled `-pooler` variant on
Vercel); `GEMINI_API_KEYS` (comma-separated, 1..N, shared by pipeline and
runtime — never assume a count anywhere); `GEMINI_MODEL` (optional,
default `gemini-3.1-flash-lite`); `RATE_LIMIT_TOTAL_PER_HOUR`,
`RATE_LIMIT_SYNTH_PER_HOUR`, `RATE_LIMIT_SALT` (optional — §2.5);
`TOPIC_MATCH_THRESHOLD`, `SEMANTIC_MIN_SIMILARITY` (optional, override the
calibrated defaults in §4); `TRANSFORMERS_CACHE_DIR` (optional, default
`/tmp/transformers-cache`); `API_BASE_URL`, `SUBJECTS` (test-only — point
the black-box suites at a deployed instance / scope the battery).

### Fresh-server testing ritual

1. `npm run dev` in one terminal (leave it running).
2. `npm run test:api` — black-box suite (`tests/api/`) against
   `http://localhost:3000` (or `API_BASE_URL`); exercises the full
   `/api/ask` contract including live Gemini prose quality (word caps,
   banned phrases, verdict-first shape).
3. `SUBJECTS="Data Structures,Computer Networks" npm run test:subjects` —
   the cross-subject battery (`tests/battery/`) asserts **structural**
   invariants only (intents, denominators, caveats, contracts), never
   content; sequential so it doesn't hammer Gemini; tolerates degradation
   where degrading is the designed behavior.

Separately, `npm test` (`vitest.config.ts`) runs integration tests directly
against `DATABASE_URL` — no running server required — and excludes
`tests/api/` and `tests/battery/`.

## 7. Git workflow

- Small, granular commits in conventional-commit form with a scope, e.g.
  `feat(api): ...`, `fix(ui): ...`, `test: ...`, `docs: ...` — one logical
  change per commit (see `git log` for the established style).
- Never push to the remote unless explicitly asked.
