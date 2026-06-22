import { EXAM_KEY_SQL } from "./analytics";
import { getPool } from "./db";

export interface TopicRow {
  topic: string;
  /** Distinct exam sittings any question of this topic appeared in. */
  exam_count: number;
  /** Sum of stated marks across the topic's questions (null if never stated). */
  total_marks: number | null;
  cluster_count: number;
  /** Distinct years, ascending. */
  years: string[];
}

export interface TopicQuestion {
  text: string;
  exam_count: number;
}

/** Distinct exams with extracted questions — the denominator for "9 of 12 exams". */
export async function totalExams(subject: string): Promise<number> {
  const res = await getPool().query(
    `SELECT COUNT(DISTINCT ${EXAM_KEY_SQL})::int AS n
       FROM papers p
       JOIN questions q ON q.paper_id = p.id
      WHERE p.standard_subject = $1`,
    [subject],
  );
  return res.rows[0].n as number;
}

/**
 * Topics ranked by distinct-exam coverage, then summed marks — the
 * deterministic backbone of TOPIC_WEIGHTAGE and STUDY_GUIDE. Empty until
 * label_topics.py has run for the subject.
 */
export async function topicWeightage(subject: string, limit = 10): Promise<TopicRow[]> {
  const res = await getPool().query(
    `SELECT c.topic,
            COUNT(DISTINCT ${EXAM_KEY_SQL})::int AS exam_count,
            SUM(q.marks)::int AS total_marks,
            COUNT(DISTINCT c.id)::int AS cluster_count,
            array_agg(DISTINCT p.year)
              FILTER (WHERE COALESCE(p.year, '') NOT IN ('', 'Unknown')) AS years
       FROM clusters c
       JOIN questions q ON q.cluster_id = c.id
       JOIN papers p ON p.id = q.paper_id
      WHERE c.standard_subject = $1
        AND c.topic IS NOT NULL
      GROUP BY c.topic
      ORDER BY exam_count DESC, total_marks DESC NULLS LAST, c.topic
      LIMIT $2`,
    [subject, limit],
  );
  return (res.rows as (Omit<TopicRow, "years"> & { years: string[] | null })[]).map((r) => ({
    ...r,
    years: [...(r.years ?? [])].sort(),
  }));
}

/** Up to `perTopic` example questions per topic, most-repeated first. */
export async function topicQuestions(
  subject: string,
  topics: string[],
  perTopic = 4,
): Promise<Map<string, TopicQuestion[]>> {
  const out = new Map<string, TopicQuestion[]>();
  if (topics.length === 0) return out;
  const res = await getPool().query(
    `SELECT c.topic,
            c.representative_text,
            COUNT(DISTINCT ${EXAM_KEY_SQL})::int AS exam_count
       FROM clusters c
       JOIN questions q ON q.cluster_id = c.id
       JOIN papers p ON p.id = q.paper_id
      WHERE c.standard_subject = $1
        AND c.topic = ANY($2)
      GROUP BY c.id, c.topic, c.representative_text
      ORDER BY exam_count DESC, c.id`,
    [subject, topics],
  );
  for (const row of res.rows as { topic: string; representative_text: string; exam_count: number }[]) {
    const list = out.get(row.topic) ?? [];
    if (list.length < perTopic) {
      list.push({ text: row.representative_text, exam_count: row.exam_count });
      out.set(row.topic, list);
    }
  }
  return out;
}
