import { generateText, GeminiUnavailable } from "./gemini";

export type Intent = "ANALYTICS" | "SEMANTIC";

const CLASSIFY_PROMPT = `Classify a student's question about an archive of previous-year university exam papers.

ANALYTICS = asks for statistics ABOUT the archive: most repeated / most frequently asked questions or topics, how many times something was asked, topic weightage, year-wise trends.
SEMANTIC = everything else: wants to find, understand, compare, or answer actual exam content.

Question: `;

/**
 * Regex fallback used when the Gemini classification call fails — /api/ask
 * must keep working (analytics needs no LLM at all) even if the runtime key
 * is rate-limited. Exported for tests.
 */
export function classifyHeuristic(question: string): Intent {
  const analytics =
    /most\s+(frequent|repeated|common|asked|important)|frequently\s+asked|how\s+(often|many\s+times)|repeated\s+questions?|weightage|year[-\s]?wise|trend|distribution\s+of\s+(marks|questions)/i;
  return analytics.test(question) ? "ANALYTICS" : "SEMANTIC";
}

/** One cheap Gemini call per the spec; falls back to the heuristic on failure. */
export async function classifyIntent(question: string): Promise<Intent> {
  try {
    const raw = await generateText(
      `${CLASSIFY_PROMPT}${JSON.stringify(question)}\n\nReply with only: {"intent":"ANALYTICS"} or {"intent":"SEMANTIC"}`,
      { json: true, timeoutMs: 15_000 },
    );
    const intent = String(JSON.parse(raw)?.intent ?? "").toUpperCase();
    if (intent === "ANALYTICS" || intent === "SEMANTIC") return intent;
  } catch (err) {
    if (!(err instanceof GeminiUnavailable)) console.error("intent classification failed:", err);
  }
  return classifyHeuristic(question);
}
