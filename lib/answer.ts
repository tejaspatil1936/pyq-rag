import type { ClusterRow, PaperSource } from "./analytics";
import { generateText } from "./gemini";
import type { SearchHit } from "./search";

/**
 * ANALYTICS answers are formatted deterministically in code from real SQL
 * counts. Per the spec the LLM "only formats, never invents" — formatting in
 * code goes one step further: zero hallucination risk and zero quota spent.
 */
export function formatAnalyticsAnswer(
  subject: string,
  clusters: ClusterRow[],
  sources: Map<number, PaperSource[]>,
): string {
  return formatClusterList(
    `**Most frequently asked questions in ${subject}** (counted over distinct exams; repeated uploads of the same paper count once):`,
    clusters,
    sources,
  );
}

/** TOPIC_ANALYTICS heading; the ranked list itself is identical machinery. */
export function formatTopicAnalyticsAnswer(
  subject: string,
  topic: string,
  clusters: ClusterRow[],
  sources: Map<number, PaperSource[]>,
): string {
  return formatClusterList(
    `**Questions about "${topic}" in ${subject}** (${clusters.length} matching cluster${clusters.length === 1 ? "" : "s"}, ranked by how often they were asked):`,
    clusters,
    sources,
  );
}

function formatClusterList(
  heading: string,
  clusters: ClusterRow[],
  sources: Map<number, PaperSource[]>,
): string {
  const lines = [heading, ""];
  clusters.forEach((c, i) => {
    const text =
      c.representative_text.length > 220
        ? `${c.representative_text.slice(0, 220)}…`
        : c.representative_text;
    lines.push(
      `${i + 1}. "${text}" — asked in **${c.exam_count}** exam${c.exam_count === 1 ? "" : "s"}${formatYears(c.years_spanned)}`,
    );
    const src = sources.get(c.cluster_id) ?? [];
    if (src.length > 0) {
      lines.push(
        `   Sources: ${src
          .map((s) => `[${[s.year, s.exam_type].filter(Boolean).join(" ") || s.file_name}](${s.url})`)
          .join(", ")}`,
      );
    }
  });
  return lines.join("\n");
}

function formatYears(yearsSpanned: string | null): string {
  if (!yearsSpanned) return "";
  const years = yearsSpanned.split(",").map((y) => y.trim()).filter(Boolean);
  if (years.length === 0) return "";
  if (years.length === 1) return ` (${years[0]})`;
  return ` (${years[0]}–${years[years.length - 1]})`;
}

/** SEMANTIC answers: Gemini synthesizes from retrieved questions, citing [n]. */
export async function synthesizeAnswer(
  subject: string,
  question: string,
  hits: SearchHit[],
): Promise<string> {
  const excerpts = hits
    .map((h, i) => {
      const meta = [h.year, h.exam_type, h.file_name].filter(Boolean).join(", ");
      const marks = h.marks != null ? `, ${h.marks} marks` : "";
      return `[${i + 1}] (${meta}${marks}) ${h.question_text}`;
    })
    .join("\n\n");

  const prompt = `You are a study assistant for MITAoE engineering students. Answer the student's question using ONLY the numbered excerpts below — they are real questions extracted from previous-year exam papers for the subject "${subject}".

Excerpts:
${excerpts}

Student's question: ${question}

Rules:
- Ground every claim in the excerpts and cite them inline like [1] or [2][5].
- Never invent questions, frequencies, years, or marks that are not in the excerpts.
- If the excerpts are not relevant to the question, say so plainly instead of guessing.
- Answer in concise markdown.`;

  return generateText(prompt, { timeoutMs: 45_000 });
}
