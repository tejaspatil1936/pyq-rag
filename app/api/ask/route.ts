import { NextResponse } from "next/server";

import { clusterSources, topClusters, topicClusters } from "@/lib/analytics";
import {
  formatAnalyticsAnswer,
  formatTopicAnalyticsAnswer,
  guardOutput,
  synthesizeAnswer,
} from "@/lib/answer";
import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { MIN_GROUNDING_HITS, SEMANTIC_MIN_SIMILARITY } from "@/lib/config";
import { embedQuery } from "@/lib/embed";
import { GeminiUnavailable } from "@/lib/gemini";
import { classifyIntent, type HistoryTurn } from "@/lib/intent";
import { normalizeQuery } from "@/lib/normalize";
import { consume, ipFromHeaders, rateKey, synthLimit, totalLimit } from "@/lib/ratelimit";
import { prefilterAbuse, refusalMessage } from "@/lib/scope";
import { semanticSearch } from "@/lib/search";
import { subjectExists } from "@/lib/subjects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold start: MiniLM ONNX download (~23 MB) + Gemini synthesis must fit.
export const maxDuration = 60;

const MAX_QUESTION_LEN = 1000;
const TOP_K = 10;

// Multi-turn caps — the server never trusts the client's history size.
const MAX_HISTORY_TURNS = 6;
const MAX_TURN_CHARS = 1200;
const MAX_HISTORY_CHARS = 6000;

/** Coerce untrusted history into ≤6 truncated turns under a total char cap. */
function sanitizeHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: HistoryTurn[] = [];
  for (const item of raw) {
    const role = (item as { role?: unknown })?.role;
    const content = String((item as { content?: unknown })?.content ?? "").trim();
    if ((role === "user" || role === "assistant") && content) {
      turns.push({ role, content: content.slice(0, MAX_TURN_CHARS) });
    }
  }
  let kept = turns.slice(-MAX_HISTORY_TURNS);
  while (kept.length > 0 && kept.reduce((s, t) => s + t.content.length, 0) > MAX_HISTORY_CHARS) {
    kept = kept.slice(1); // drop oldest first
  }
  return kept;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const {
    subject: rawSubject,
    question: rawQuestion,
    history: rawHistory,
  } = (body ?? {}) as Record<string, unknown>;
  const subject = String(rawSubject ?? "").trim();
  // "imp ques" → "important questions" etc. before anything reads the query.
  const question = normalizeQuery(String(rawQuestion ?? ""));
  const history = sanitizeHistory(rawHistory);
  if (!subject || !question) {
    return NextResponse.json({ error: "subject and question are required" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LEN) {
    return NextResponse.json(
      { error: `question exceeds ${MAX_QUESTION_LEN} characters` },
      { status: 400 },
    );
  }

  const client = rateKey(ipFromHeaders(req.headers));
  if (!consume(`total:${client}`, totalLimit())) {
    return NextResponse.json(
      { error: "That's a lot of questions this hour — take a short break and try again." },
      { status: 429 },
    );
  }

  // Cache before any other work; multi-turn requests are context-dependent
  // and skip it.
  const key = cacheKey(subject, question);
  if (history.length === 0) {
    const hit = cacheGet(key);
    if (hit) return NextResponse.json({ ...hit, cached: true });
  }

  // Successful history-free responses land in the cache on the way out.
  const respond = (body: Record<string, unknown>, cacheable = true) => {
    if (cacheable && history.length === 0) cacheSet(key, body);
    return NextResponse.json(body);
  };

  try {
    if (!(await subjectExists(subject))) {
      return NextResponse.json({ error: `unknown subject: ${subject}` }, { status: 404 });
    }

    // Scope gate layer 0: obvious abuse dies here for free, before Gemini.
    if (prefilterAbuse(question)) {
      return respond({ intent: "REFUSED", answer: refusalMessage(subject) });
    }

    // Scope gate layer 1 rides along in the intent-classification call; the
    // history lets it resolve follow-ups like "explain the second one".
    const { inScope, intent, topic, rewritten } = await classifyIntent(question, {
      subject,
      history,
    });
    if (!inScope) {
      return respond({ intent: "REFUSED", answer: refusalMessage(subject) });
    }

    if (intent === "ANALYTICS") {
      const clusters = await topClusters(subject, TOP_K);
      if (clusters.length === 0) {
        return respond({
          intent,
          answer: `No clustered questions for **${subject}** yet — the pipeline may still be processing this subject.`,
          clusters: [],
        });
      }
      const sources = await clusterSources(clusters.map((c) => c.cluster_id));
      return respond({
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
        return respond({
          intent,
          topic: topicPhrase,
          answer: `No question clusters about **${topicPhrase}** found in **${subject}**. Either it isn't asked in this subject's papers, or the phrasing differs — try an open-ended question instead.`,
          clusters: [],
        });
      }
      const sources = await clusterSources(clusters.map((c) => c.cluster_id));
      return respond({
        intent,
        topic: topicPhrase,
        answer: formatTopicAnalyticsAnswer(subject, topicPhrase, clusters, sources),
        clusters: clusters.map((c) => ({ ...c, sources: sources.get(c.cluster_id) ?? [] })),
      });
    }

    // SEMANTIC: embed the query, then pgvector search *already* scoped to the
    // subject in SQL — the LLM only ever sees same-subject questions. The
    // classifier's standalone rewrite makes follow-ups searchable.
    const searchQuery = rewritten ?? question;
    const queryVec = await embedQuery(searchQuery);
    const hits = await semanticSearch(subject, queryVec, TOP_K);

    // Grounding floor: without enough genuinely similar questions, honesty
    // beats synthesis — say so and suggest what the papers DO cover.
    const grounded = hits.filter((h) => h.similarity >= SEMANTIC_MIN_SIMILARITY);
    if (grounded.length < MIN_GROUNDING_HITS) {
      const suggestions = (await topClusters(subject, 3)).map(
        (c) =>
          `- ${c.representative_text.length > 120 ? `${c.representative_text.slice(0, 120)}…` : c.representative_text}`,
      );
      return respond({
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

    const citations = grounded.map((h, i) => ({
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
    }));

    // Synthesis is the only expensive Gemini call — it gets the strict cap.
    if (!consume(`synth:${client}`, synthLimit())) {
      return NextResponse.json(
        {
          error:
            "You've used this hour's AI answers. Frequency analytics still work — or try again in a bit.",
        },
        { status: 429 },
      );
    }

    let raw: string;
    try {
      raw = await synthesizeAnswer(subject, question, grounded, history);
    } catch (err) {
      if (err instanceof GeminiUnavailable) {
        // Quota exhausted: never go dark — hand over raw retrieval instead.
        return respond(
          {
            intent,
            answer:
              "AI answers are resting until tomorrow — here are the most relevant past questions instead.",
            citations,
            degraded: true,
          },
          false, // don't cache the degraded shape past the outage
        );
      }
      throw err;
    }
    const guarded = guardOutput(raw, subject, question);
    if (guarded.flagged) {
      return respond({ intent: "REFUSED", answer: guarded.answer });
    }
    return respond({ intent, answer: guarded.answer, citations });
  } catch (err) {
    if (err instanceof GeminiUnavailable) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    console.error("POST /api/ask failed:", err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
