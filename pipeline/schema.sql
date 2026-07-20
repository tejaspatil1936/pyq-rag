-- MITAoE PYQ Analytics + RAG — Postgres schema (Neon + pgvector).
-- Idempotent: safe to run on every pipeline start.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS papers (
    id               SERIAL PRIMARY KEY,
    file_name        TEXT NOT NULL,
    url              TEXT NOT NULL UNIQUE,
    year             TEXT,
    branch           TEXT,
    semester         TEXT,
    exam_type        TEXT,
    subject          TEXT,
    standard_subject TEXT,
    status           TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
    id            SERIAL PRIMARY KEY,
    paper_id      INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    marks         INTEGER,
    sub_label     TEXT,
    embedding     vector(384),
    cluster_id    INTEGER,
    has_figure    BOOLEAN,  -- refers to a provided figure/diagram (audit backfills)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing databases predate these columns.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS has_figure BOOLEAN;
ALTER TABLE papers ADD COLUMN IF NOT EXISTS extract_method TEXT;  -- 'text' | 'ocr' (tracked going forward)

-- Per-subject corpus health, recomputed by pipeline/audit_subjects.py.
CREATE TABLE IF NOT EXISTS subject_stats (
    standard_subject     TEXT PRIMARY KEY,
    papers               INTEGER,
    exams                INTEGER,
    questions            INTEGER,
    clusters             INTEGER,
    pct_labeled          REAL,
    distinct_years       INTEGER,
    years                JSONB,      -- {year: paper_count}
    pct_ocr              REAL,       -- NULL where extract_method was never tracked
    pct_figure           REAL,
    max_cluster_size     INTEGER,
    max_cluster_texts    INTEGER,    -- distinct member texts of that largest cluster
    text_twin_risk       REAL,       -- share of clusters: near-identical text, >=3 exams, figure-dependent
    computed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clusters (
    id                  SERIAL PRIMARY KEY,
    standard_subject    TEXT NOT NULL,
    representative_text TEXT NOT NULL,
    question_count      INTEGER NOT NULL,
    papers_count        INTEGER NOT NULL,
    years_spanned       TEXT,
    topic               TEXT  -- canonical topic name assigned by label_topics.py
);

-- Existing databases predate the topic column.
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS topic TEXT;

CREATE INDEX IF NOT EXISTS idx_questions_cluster ON questions (cluster_id);
CREATE INDEX IF NOT EXISTS idx_questions_paper ON questions (paper_id);
CREATE INDEX IF NOT EXISTS idx_papers_subject_status ON papers (standard_subject, status);
CREATE INDEX IF NOT EXISTS idx_clusters_subject ON clusters (standard_subject);
CREATE INDEX IF NOT EXISTS idx_clusters_subject_topic ON clusters (standard_subject, topic);

-- ANN index for subject-filtered semantic search.
CREATE INDEX IF NOT EXISTS idx_questions_embedding
    ON questions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
