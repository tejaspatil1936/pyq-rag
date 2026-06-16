import { getPool } from "./db";
import { toVectorLiteral } from "./embed";

export interface SearchHit {
  question_id: number;
  question_text: string;
  marks: number | null;
  sub_label: string | null;
  file_name: string;
  year: string | null;
  exam_type: string | null;
  url: string;
  standard_subject: string;
  similarity: number;
}

/**
 * Subject-scoped pgvector similarity search.
 *
 * Subject isolation is the WHERE clause on papers.standard_subject — SQL,
 * applied before vector ordering, never left to the LLM (see CLAUDE.md).
 */
export async function semanticSearch(
  subject: string,
  queryVec: number[],
  limit = 10,
): Promise<SearchHit[]> {
  const client = await getPool().connect();
  try {
    // The ivfflat index probes 1 list by default; with a subject filter on
    // top, that starves recall. 10 probes is still fast at this corpus size.
    await client.query("SET ivfflat.probes = 10");
    const res = await client.query(
      `SELECT q.id AS question_id,
              q.question_text,
              q.marks,
              q.sub_label,
              p.file_name,
              p.year,
              p.exam_type,
              p.url,
              p.standard_subject,
              1 - (q.embedding <=> $1::vector) AS similarity
         FROM questions q
         JOIN papers p ON p.id = q.paper_id
        WHERE p.standard_subject = $2
          AND q.embedding IS NOT NULL
        ORDER BY q.embedding <=> $1::vector
        LIMIT $3`,
      [toVectorLiteral(queryVec), subject, limit],
    );
    return res.rows as SearchHit[];
  } finally {
    client.release();
  }
}
