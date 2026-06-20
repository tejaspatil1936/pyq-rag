import { NextResponse } from "next/server";

import { clusterSources, topClusters, topicClusters } from "@/lib/analytics";
import {
  formatAnalyticsAnswer,
  formatTopicAnalyticsAnswer,
  guardOutput,
  synthesizeAnswer,
} from "@/lib/answer";
import { MIN_GROUNDING_HITS, SEMANTIC_MIN_SIMILARITY } from "@/lib/config";
import { embedQuery } from "@/lib/embed";
import { GeminiUnavailable } from "@/lib/gemini";
import { classifyIntent } from "@/lib/intent";
import { prefilterAbuse, refusalMessage } from "@/lib/scope";
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

    // Scope gate layer 0: obvious abuse dies here for free, before Gemini.
    if (prefilterAbuse(question)) {
      return NextResponse.json({ intent: "REFUSED", answer: refusalMessage(subject) });
    }

    // Scope gate layer 1 rides along in the intent-classification call.
    const { inScope, intent, topic } = await classifyIntent(question, { subject });
    if (!inScope) {
      return NextResponse.json({ intent: "REFUSED", answer: refusalMessage(subject) });
    }

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

    if (intent === "TOPIC_ANALYTICS") {
      // Topic-scoped frequency: embed the topic phrase, match this subject's
      // clusters by centroid similarity, rank by real question_count.
      const topicPhrase = topic ?? question;
      const topicVec = await embedQuery(topicPhrase);
      const clusters = await topicClusters(subject, topicVec, TOP_K);
      if (clusters.length === 0) {
        return NextResponse.json({
          intent,
          topic: topicPhrase,
          answer: `No question clusters about **${topicPhrase}** found in **${subject}**. Either it isn't asked in this subject's papers, or the phrasing differs — try an open-ended question instead.`,
          clusters: [],
        });
      }
      const sources = await clusterSources(clusters.map((c) => c.cluster_id));
      return NextResponse.json({
        intent,
        topic: topicPhrase,
        answer: formatTopicAnalyticsAnswer(subject, topicPhrase, clusters, sources),
        clusters: clusters.map((c) => ({ ...c, sources: sources.get(c.cluster_id) ?? [] })),
      });
    }

    // SEMANTIC: embed the query, then pgvector search *already* scoped to the
    // subject in SQL — the LLM only ever sees same-subject questions.
    const queryVec = await embedQuery(question);
    const hits = await semanticSearch(subject, queryVec, TOP_K);

    // Grounding floor: without enough genuinely similar questions, honesty
    // beats synthesis — say so and suggest what the papers DO cover.
    const grounded = hits.filter((h) => h.similarity >= SEMANTIC_MIN_SIMILARITY);
    if (grounded.length < MIN_GROUNDING_HITS) {
      const suggestions = (await topClusters(subject, 3)).map(
        (c) =>
          `- ${c.representative_text.length > 120 ? `${c.representative_text.slice(0, 120)}…` : c.representative_text}`,
      );
      return NextResponse.json({
        intent,
        answer:
          `The previous-year papers for **${subject}** don't cover this specifically.` +
          (suggestions.length > 0
            ? `\n\nTopics the papers do ask about:\n${suggestions.join("\n")}`
            : ""),
        citations: [],
        no_answer: true,
      });
    }

    const raw = await synthesizeAnswer(subject, question, grounded);
    const guarded = guardOutput(raw, subject, question);
    if (guarded.flagged) {
      return NextResponse.json({ intent: "REFUSED", answer: guarded.answer });
    }
    return NextResponse.json({
      intent,
      answer: guarded.answer,
      citations: grounded.map((h, i) => ({
        ref: i + 1,
        question_text: h.question_text,
        marks: h.marks,
        sub_label: h.sub_label,
        file_name: h.file_name,
        year: h.year,
        exam_type: h.exam_type,
        url: h.url,
        standard_subject: h.standard_subject,
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
