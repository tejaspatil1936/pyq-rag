import { TOPIC_MATCH_THRESHOLD } from "./config";
import { getPool } from "./db";
import { toVectorLiteral } from "./embed";

export interface ClusterRow {
  cluster_id: number;
  representative_text: string;
  /** Raw extracted-question members (may include duplicate uploads). */
  question_count: number;
  /** Distinct exam sittings the cluster's question appeared in — the honest
   *  frequency number shown to students. */
  exam_count: number;
  years_spanned: string | null;
}

/**
 * One exam sitting is often uploaded several times ("... (2).pdf", filename
 * typos), which would inflate every frequency count. An exam is therefore
 * identified as (standard_subject, year, exam session, exam_type, semester,
 * branch); the session month exists only inside file_name ("_APR 2024",
 * "APRIL2024", "Dec 2023"), matched as a month token directly followed by a
 * year so subject words like "Marketing" can't false-positive.
 *
 * Dedup happens at QUERY TIME rather than by migrating clusters counts:
 * stored counts stay raw, the Python pipeline needs no lock-step change, and
 * the numbers stay correct automatically after every future ingest/cluster
 * rerun. The aggregate spans a single subject's questions (~2k rows) — cheap.
 */
const EXAM_SESSION_SQL = `COALESCE(substring(upper(p.file_name) from '(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*[ ._-]*[0-9]{2,4}'), '')`;

export const EXAM_KEY_SQL = `(p.standard_subject, COALESCE(p.year, ''), ${EXAM_SESSION_SQL}, COALESCE(p.exam_type, ''), COALESCE(p.semester, ''), COALESCE(p.branch, ''))`;

/** Optional year / exam-type narrowing for the frequency paths. */
export interface ExamFilters {
  year?: string | null;
  examType?: string | null;
}

// Appended to the WHERE clause of every filtered aggregate; the two extra
// parameters are always bound (NULL = no filter).
export const FILTER_SQL = (yearParam: string, examParam: string) =>
  ` AND (${yearParam}::text IS NULL OR p.year = ${yearParam})
    AND (${examParam}::text IS NULL OR UPPER(COALESCE(p.exam_type, '')) = ${examParam})`;

/** "MSE 2024" / "2024" / "ESE" — for headings and honest-empty messages. */
export function filterLabel(filters: ExamFilters): string | null {
  const parts = [filters.examType, filters.year].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Distinct years present for a subject — shown when a year filter misses. */
export async function availableYears(subject: string): Promise<string[]> {
  const res = await getPool().query(
    `SELECT DISTINCT p.year FROM papers p
      WHERE p.standard_subject = $1 AND p.status = 'done'
        AND COALESCE(p.year, '') NOT IN ('', 'Unknown')
      ORDER BY p.year`,
    [subject],
  );
  return (res.rows as { year: string }[]).map((r) => r.year);
}

/** Distinct exams touched by any of these clusters (topic totals). */
export async function examCountForClusters(
  clusterIds: number[],
  filters: ExamFilters = {},
): Promise<number> {
  if (clusterIds.length === 0) return 0;
  const res = await getPool().query(
    `SELECT COUNT(DISTINCT ${EXAM_KEY_SQL})::int AS n
       FROM questions q
       JOIN papers p ON p.id = q.paper_id
      WHERE q.cluster_id = ANY($1::int[])${FILTER_SQL("$2", "$3")}`,
    [clusterIds, filters.year ?? null, filters.examType ?? null],
  );
  return res.rows[0].n as number;
}

export interface PaperSource {
  file_name: string;
  year: string | null;
  exam_type: string | null;
  url: string;
}

/**
 * Ranked "most frequently asked" clusters for one subject — real SQL counts
 * over DISTINCT exams, never LLM guesses (see CLAUDE.md).
 */
export async function topClusters(
  subject: string,
  limit = 10,
  filters: ExamFilters = {},
): Promise<ClusterRow[]> {
  const res = await getPool().query(
    `SELECT c.id AS cluster_id,
            c.representative_text,
            c.question_count::int AS question_count,
            COUNT(DISTINCT ${EXAM_KEY_SQL})::int AS exam_count,
            c.years_spanned
       FROM clusters c
       JOIN questions q ON q.cluster_id = c.id
       JOIN papers p ON p.id = q.paper_id
      WHERE c.standard_subject = $1${FILTER_SQL("$3", "$4")}
      GROUP BY c.id, c.representative_text, c.question_count, c.years_spanned
      ORDER BY exam_count DESC, c.question_count DESC, c.id
      LIMIT $2`,
    [subject, limit, filters.year ?? null, filters.examType ?? null],
  );
  return res.rows as ClusterRow[];
}

export interface TopicClusterRow extends ClusterRow {
  topic_similarity: number;
}

/**
 * TOPIC_ANALYTICS: this subject's clusters that are actually about the named
 * topic, ranked by real question_count. A cluster matches when the cosine
 * similarity between the topic-phrase embedding and the cluster's centroid
 * (average of member embeddings — the representative question is the member
 * closest to that centroid) clears TOPIC_MATCH_THRESHOLD. Subject isolation
 * stays a SQL WHERE clause, same as everywhere else.
 */
export async function topicClusters(
  subject: string,
  topicVec: number[],
  limit = 10,
  filters: ExamFilters = {},
): Promise<TopicClusterRow[]> {
  const res = await getPool().query(
    `SELECT c.id AS cluster_id,
            c.representative_text,
            c.question_count::int AS question_count,
            COUNT(DISTINCT ${EXAM_KEY_SQL})::int AS exam_count,
            c.years_spanned,
            1 - (AVG(q.embedding) <=> $1::vector) AS topic_similarity
       FROM clusters c
       JOIN questions q ON q.cluster_id = c.id
       JOIN papers p ON p.id = q.paper_id
      WHERE c.standard_subject = $2
        AND q.embedding IS NOT NULL${FILTER_SQL("$5", "$6")}
      GROUP BY c.id, c.representative_text, c.question_count, c.years_spanned
     HAVING 1 - (AVG(q.embedding) <=> $1::vector) >= $3
      ORDER BY exam_count DESC, topic_similarity DESC, c.id
      LIMIT $4`,
    [
      toVectorLiteral(topicVec),
      subject,
      TOPIC_MATCH_THRESHOLD,
      limit,
      filters.year ?? null,
      filters.examType ?? null,
    ],
  );
  return res.rows as TopicClusterRow[];
}

/**
 * Up to `perCluster` distinct source papers for each cluster id, newest
 * years first — the citation links for the analytics answer.
 */
export async function clusterSources(
  clusterIds: number[],
  perCluster = 3,
): Promise<Map<number, PaperSource[]>> {
  const sources = new Map<number, PaperSource[]>();
  if (clusterIds.length === 0) return sources;

  const res = await getPool().query(
    `SELECT DISTINCT q.cluster_id, p.file_name, p.year, p.exam_type, p.url
       FROM questions q
       JOIN papers p ON p.id = q.paper_id
      WHERE q.cluster_id = ANY($1::int[])
      ORDER BY p.year DESC NULLS LAST, p.file_name`,
    [clusterIds],
  );

  for (const row of res.rows as ({ cluster_id: number } & PaperSource)[]) {
    const list = sources.get(row.cluster_id) ?? [];
    if (list.length < perCluster) {
      list.push({
        file_name: row.file_name,
        year: row.year,
        exam_type: row.exam_type,
        url: row.url,
      });
      sources.set(row.cluster_id, list);
    }
  }
  return sources;
}
