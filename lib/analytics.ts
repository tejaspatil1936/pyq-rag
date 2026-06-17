import { getPool } from "./db";

export interface ClusterRow {
  cluster_id: number;
  representative_text: string;
  question_count: number;
  papers_count: number;
  years_spanned: string | null;
}

export interface PaperSource {
  file_name: string;
  year: string | null;
  exam_type: string | null;
  url: string;
}

/**
 * Ranked "most frequently asked" clusters for one subject — real SQL counts
 * produced by the clustering step, never LLM guesses (see CLAUDE.md).
 */
export async function topClusters(subject: string, limit = 10): Promise<ClusterRow[]> {
  const res = await getPool().query(
    `SELECT id AS cluster_id,
            representative_text,
            question_count::int AS question_count,
            papers_count::int AS papers_count,
            years_spanned
       FROM clusters
      WHERE standard_subject = $1
      ORDER BY question_count DESC, papers_count DESC, id
      LIMIT $2`,
    [subject, limit],
  );
  return res.rows as ClusterRow[];
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
