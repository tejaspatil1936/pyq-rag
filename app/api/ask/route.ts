import { NextResponse } from "next/server";

import { clusterSources, topClusters } from "@/lib/analytics";
import { formatAnalyticsAnswer, synthesizeAnswer } from "@/lib/answer";
import { embedQuery } from "@/lib/embed";
import { GeminiUnavailable } from "@/lib/gemini";
import { classifyIntent } from "@/lib/intent";
import { semanticSearch } from "@/lib/search";
import { subjectExists } from "@/lib/subjects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold start: MiniLM ONNX download (~23 MB) + Gemini synthesis must fit.
export const maxDuration = 60;

const MAX_QUESTION_LEN = 1000;
const TOP_K = 10;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const { subject: rawSubject, question: rawQuestion } = (body ?? {}) as Record<string, unknown>;
  const subject = String(rawSubject ?? "").trim();
  const question = String(rawQuestion ?? "").trim();
  if (!subject || !question) {
    return NextResponse.json({ error: "subject and question are required" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LEN) {
    return NextResponse.json(
      { error: `question exceeds ${MAX_QUESTION_LEN} characters` },
      { status: 400 },
    );
  }

  try {
    if (!(await subjectExists(subject))) {
      return NextResponse.json({ error: `unknown subject: ${subject}` }, { status: 404 });
    }

    const intent = await classifyIntent(question);

    if (intent === "ANALYTICS") {
      const clusters = await topClusters(subject, TOP_K);
      if (clusters.length === 0) {
        return NextResponse.json({
          intent,
          answer: `No clustered questions for **${subject}** yet — the pipeline may still be processing this subject.`,
          clusters: [],
        });
      }
      const sources = await clusterSources(clusters.map((c) => c.cluster_id));
      return NextResponse.json({
        intent,
        answer: formatAnalyticsAnswer(subject, clusters, sources),
        clusters: clusters.map((c) => ({ ...c, sources: sources.get(c.cluster_id) ?? [] })),
      });
    }

    // SEMANTIC: embed the query, then pgvector search *already* scoped to the
    // subject in SQL — the LLM only ever sees same-subject questions.
    const queryVec = await embedQuery(question);
    const hits = await semanticSearch(subject, queryVec, TOP_K);
    if (hits.length === 0) {
      return NextResponse.json({
        intent,
        answer: `No embedded questions found for **${subject}** yet.`,
        citations: [],
      });
    }

    const answer = await synthesizeAnswer(subject, question, hits);
    return NextResponse.json({
      intent,
      answer,
      citations: hits.map((h, i) => ({
        ref: i + 1,
        question_text: h.question_text,
        marks: h.marks,
        sub_label: h.sub_label,
        file_name: h.file_name,
        year: h.year,
        exam_type: h.exam_type,
        url: h.url,
        similarity: h.similarity,
      })),
    });
  } catch (err) {
    if (err instanceof GeminiUnavailable) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    console.error("POST /api/ask failed:", err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
