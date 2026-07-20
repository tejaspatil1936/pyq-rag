# PROJECT: MITAoE PYQ Analytics + RAG

## Goal
A web app where students select a subject and ask questions about previous-year
question papers. Two query types:
1. ANALYTICS: "most frequently asked questions/topics" → answered by SQL over
   clustered questions with REAL COUNTS. Never answered by the LLM guessing.
2. SEMANTIC: open-ended questions → pgvector similarity search + Gemini synthesis,
   with citations to source papers.

## Non-negotiable rules
- The atomic unit is an individual QUESTION, never a page chunk or whole PDF.
- Subject isolation is enforced with a SQL WHERE clause on standard_subject,
  applied BEFORE vector search. Never rely on the LLM or prompt to keep
  subjects separate.
- Everything runs on free tiers: Neon Postgres (pgvector), Gemini Flash free
  tier, GitHub Actions for all heavy compute, Vercel for hosting,
  sentence-transformers locally in Actions for embeddings (NO paid embedding API).
- The user's PC never downloads or processes PDFs. All ingestion happens in
  GitHub Actions.
- PDFs are processed streaming: download one → extract → parse → save to DB →
  DELETE the PDF → next. Never store PDFs.

## Data source
- Metadata API: https://mitaoe-pyqs.vercel.app/api/papers
  Returns ~4,664 papers with fields: fileName, url, year, branch, semester,
  examType (ESE/MSE/CAT), subject, standardSubject.
- PDFs are served from a Cloudflare Worker (mitaoe-pyqs.c122.workers.dev). They
  are directly downloadable with a plain GET. Be polite: ≤2 concurrent
  downloads, small delay between requests.
- Most 2018–2024 PDFs have text layers (use pdfplumber / PyMuPDF).
  2016 and some 2025 PDFs are scanned images → OCR fallback with Tesseract
  (installed via apt in the Actions runner).

## Pipeline (GitHub Actions workflow: ingest.yml)
1. Fetch /api/papers → upsert all paper metadata into `papers` table with
   status = 'pending'.
2. Batch loop (default 300 papers per run):
   For each pending paper: download PDF → extract text → if <100 chars of
   text, OCR → send text to Gemini Flash with a strict JSON-output prompt:
   "Extract every question as JSON: [{question_text, marks, sub_question_label}]"
   → validate JSON → insert rows into `questions` → mark paper status='done'
   (or 'failed' with error message; never crash the run on one bad paper).
3. Rate limiting + KEY ROTATION: GEMINI_API_KEYS is a comma-separated list of
   free-tier keys, ALL shared between the pipeline and the runtime app. The
   pipeline rotates through the full set:
   sleep between calls to stay under per-minute limits; on 429 or daily-quota
   errors, mark that key exhausted (with a cooldown timestamp) and switch to
   the next key; when ALL keys are exhausted, exit cleanly — cron
   resumes later. Implement rotation as a small KeyManager class so both the
   extraction and any other Gemini call in the pipeline share it. Log which
   key index served each call (never log the key itself).
4. Embedding step: for all questions without embeddings, run
   sentence-transformers 'all-MiniLM-L6-v2' (CPU) and store 384-dim vectors
   in pgvector column.
5. Clustering step: per standard_subject, cluster questions by embedding
   similarity (agglomerative, cosine threshold ~0.80 to start; make it a
   config constant). Store cluster_id on questions, and a `clusters` table
   with representative_text and count.
6. Workflow is idempotent and resumable: progress lives in the DB, so re-runs
   only touch pending work. Schedule: cron every 4 hours until backlog is
   empty; then monthly for new papers.

## Database schema (Postgres + pgvector)
- papers(id, file_name, url, year, branch, semester, exam_type, subject,
  standard_subject, status, error, created_at)
- questions(id, paper_id FK, question_text, marks, sub_label,
  embedding vector(384), cluster_id, created_at)
- clusters(id, standard_subject, representative_text, question_count,
  papers_count, years_spanned)
- Indexes: questions(cluster_id), papers(standard_subject, status),
  ivfflat index on embedding.

## Backend (Next.js API routes, deployed on Vercel)
- POST /api/ask { subject, question }
  1. Classify query intent with one cheap Gemini call: ANALYTICS or SEMANTIC.
  2. ANALYTICS → SQL over clusters filtered by subject → format ranked list
     with counts and source paper links. LLM only formats, never invents.
  3. SEMANTIC → embed the query (use Gemini embedding OR precomputed via a
     tiny serverless-friendly approach; if sentence-transformers won't run on
     Vercel, use Gemini's free embedding endpoint for QUERY-TIME only) →
     pgvector search WHERE standard_subject = $1 → top 10 questions with
     paper metadata → Gemini Flash writes the answer citing papers.
- GET /api/subjects → distinct standard_subject list with question counts.

## Frontend (Next.js + Tailwind, same repo)
- Landing page: subject picker (searchable dropdown) → chat interface.
- Chat shows answers with expandable citations (paper name, year, exam type,
  link to original PDF on the worker URL).
- Prebuilt quick-action buttons: "Most repeated questions", "Topic-wise
  weightage", "Year-wise trend".
- Simple, fast, mobile-first. No login.

## Quality gates (do not skip)
- After first 300 papers processed: script that samples 20 random papers and
  prints extracted questions next to the PDF URL for manual comparison.
- A /api/stats endpoint showing papers done/failed/pending, question counts
  per subject.
- Log every Gemini JSON parse failure; retry once with a repair prompt.

## Env vars / GitHub secrets
- DATABASE_URL (Neon)
- GEMINI_API_KEYS (comma-separated list of 1..N keys; may change at any
  time. ALL keys are shared by both the runtime app and the pipeline: the
  runtime rotates per request (random start per instance, cooldown on
  per-minute 429s, benched until the next UTC day on daily-quota 429s), and
  the pipeline rotates over the same set — it runs briefly on a schedule,
  so collisions are acceptable. The code must read this dynamically — never
  hardcode a key count anywhere; a single-key deployment must work.)
- Backend /api/ask degrades gracefully only when every key is benched.

## Open source
This repo is public/open source. Therefore:
- NEVER commit keys, .env files, or connection strings. Ship a .env.example
  with placeholder values and add .env* to .gitignore from the first commit.
- Add a proper README (what it does, architecture diagram, how to self-host
  with your own free keys) and an MIT license.
- Contributors run the same pipeline with their own GEMINI_API_KEYS — nothing
  in the code may assume a specific number of keys (1..N must all work).