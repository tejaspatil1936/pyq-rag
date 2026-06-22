/** Response shapes of the API routes, shared by the UI and its tests. */

export interface SubjectRow {
  subject: string;
  question_count: number;
  paper_count: number;
}

export interface PaperSource {
  file_name: string;
  year: string | null;
  exam_type: string | null;
  url: string;
}

export interface ClusterResult {
  cluster_id: number;
  representative_text: string;
  question_count: number;
  exam_count: number;
  years_spanned: string | null;
  /** Present only on TOPIC_ANALYTICS results. */
  topic_similarity?: number;
  sources: PaperSource[];
}

export interface Citation {
  ref: number;
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

export type Intent =
  | "ANALYTICS"
  | "TOPIC_ANALYTICS"
  | "TOPIC_WEIGHTAGE"
  | "STUDY_GUIDE"
  | "SEMANTIC"
  | "REFUSED";

export interface TopicResult {
  topic: string;
  exam_count: number;
  total_marks: number | null;
  cluster_count: number;
  years: string[];
  questions: { text: string; exam_count: number }[];
}

export interface AskResponse {
  intent: Intent;
  answer: string;
  topic?: string;
  clusters?: ClusterResult[];
  citations?: Citation[];
  topics?: TopicResult[];
  total_exams?: number;
  /** True when served from the response cache. */
  cached?: boolean;
  /** True when retrieval couldn't support an answer (honest no-answer path). */
  no_answer?: boolean;
  /** True when Gemini quota is exhausted and raw retrieval was returned. */
  degraded?: boolean;
}

export interface StatsResponse {
  papers: Record<string, number>;
  questions: { total: number; embedded: number; clustered: number };
  clusters: number;
  subjects: SubjectRow[];
}

/** "2019,2020,2023" -> "2019–2023"; single year stays as-is. */
export function yearSpan(yearsSpanned: string | null): string | null {
  if (!yearsSpanned) return null;
  const years = yearsSpanned
    .split(",")
    .map((y) => y.trim())
    .filter(Boolean);
  if (years.length === 0) return null;
  if (years.length === 1) return years[0];
  return `${years[0]}–${years[years.length - 1]}`;
}
