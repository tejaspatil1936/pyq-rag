import { generateText, GeminiUnavailable } from "./gemini";

export type Intent = "ANALYTICS" | "TOPIC_ANALYTICS" | "SEMANTIC";

export interface Classification {
  intent: Intent;
  /** The named topic phrase — set only for TOPIC_ANALYTICS. */
  topic: string | null;
}

const CLASSIFY_PROMPT = `Classify a student's question about an archive of previous-year university exam papers.

ANALYTICS — asks for frequency/statistics across the WHOLE subject with no specific topic named: "most repeated questions", "topic-wise weightage", "year-wise trends".
TOPIC_ANALYTICS — asks what or how often things are asked about one SPECIFIC named topic or concept: "what usually gets asked about TCP congestion control", "questions on hashing", "how often does normalization come up".
SEMANTIC — everything else: wants content explained, understood, compared, or answered: "explain X", "how do I answer Y".

Reply with only one JSON object:
{"intent":"ANALYTICS"} or {"intent":"TOPIC_ANALYTICS","topic":"<the named topic phrase>"} or {"intent":"SEMANTIC"}

Question: `;

// "explain/define/how do I..." openers are content questions even when a
// topic phrase follows — check before topic extraction.
const EXPLAIN_OPENER =
  /^(?:explain|define|derive|describe|compare|differentiate|discuss|solve|state|prove|why\b|what\s+is\b|what\s+are\b|how\s+(?:do|does|would|can|to)\b)/i;

const FREQUENCY =
  /most\s+(?:frequent(?:ly)?|repeated|common(?:ly)?|asked|important)|frequently\s+asked|how\s+(?:often|many\s+times)|repeated\s+questions?|weightage|year[-\s]?wise|trend|usually|gets?\s+asked|come(?:s)?\s+up|appears?\b/i;

const TOPIC_PATTERN =
  /(?:asked|asks?|come(?:s)?\s+up|appear(?:s)?|questions?)\s+(?:about|on|from|regarding|related\s+to|cover(?:ing)?|for)\s+(.+?)[?.!\s]*$/i;

// Passive frequency phrasing: "how often is X asked", "how many times did X appear".
const TOPIC_PATTERN_PASSIVE =
  /how\s+(?:often|many\s+times)\s+(?:is|was|were|does|do|did|has|have)\s+(.+?)\s+(?:been\s+)?(?:asked|appear|come|covered)/i;

/**
 * Regex fallback used when the Gemini classification call fails — /api/ask
 * must keep working (both analytics paths need no LLM) even if the runtime
 * key is rate-limited. Exported for tests.
 */
export function classifyHeuristic(question: string): Classification {
  const q = question.trim();
  // "explain/how do I..." openers are content questions even when a topic
  // phrase follows ("how do I answer the question on paging").
  if (!EXPLAIN_OPENER.test(q)) {
    const topicMatch = TOPIC_PATTERN.exec(q) ?? TOPIC_PATTERN_PASSIVE.exec(q);
    if (topicMatch) return { intent: "TOPIC_ANALYTICS", topic: topicMatch[1].trim() };
  }
  // Checked after topic extraction, and also rescues frequency questions
  // that start explain-like ("What are the most frequently asked questions?").
  if (FREQUENCY.test(q)) return { intent: "ANALYTICS", topic: null };
  return { intent: "SEMANTIC", topic: null };
}

/** One cheap Gemini call per the spec; falls back to the heuristic on failure. */
export async function classifyIntent(question: string): Promise<Classification> {
  try {
    const raw = await generateText(`${CLASSIFY_PROMPT}${JSON.stringify(question)}`, {
      json: true,
      timeoutMs: 15_000,
    });
    const parsed = JSON.parse(raw) as { intent?: unknown; topic?: unknown };
    const intent = String(parsed?.intent ?? "").toUpperCase();
    if (intent === "ANALYTICS" || intent === "SEMANTIC") {
      return { intent, topic: null };
    }
    if (intent === "TOPIC_ANALYTICS") {
      const topic = String(parsed?.topic ?? "").trim();
      // A topic-analytics verdict without a topic can't scope anything —
      // the whole question works as the similarity probe instead.
      return { intent, topic: topic || question };
    }
  } catch (err) {
    if (!(err instanceof GeminiUnavailable)) console.error("intent classification failed:", err);
  }
  return classifyHeuristic(question);
}
