/**
 * Runtime Gemini client for /api/ask.
 *
 * Uses ONLY the LAST key in GEMINI_API_KEYS — that key is reserved for the
 * runtime app; all other keys belong to the ingestion pipeline's rotation
 * pool and must never be touched here (see CLAUDE.md).
 *
 * Gemini 3.x are thinking models; chat answers need speed, not reasoning,
 * so requests ask for minimal thinking and silently drop the config if the
 * configured model rejects it (mirrors the pipeline's fallback ladder).
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";

/** Gemini is rate-limited or down — callers should surface HTTP 503. */
export class GeminiUnavailable extends Error {}

function runtimeKey(): string {
  const keys = (process.env.GEMINI_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) throw new Error("GEMINI_API_KEYS is not set");
  return keys[keys.length - 1];
}

// Sticky per-instance: once the model rejects thinkingConfig we stop sending it.
let sendThinkingConfig = true;

interface GenerateOptions {
  json?: boolean;
  timeoutMs?: number;
}

export async function generateText(
  prompt: string,
  { json = false, timeoutMs = 30_000 }: GenerateOptions = {},
): Promise<string> {
  let retriedServerError = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    const generationConfig: Record<string, unknown> = { temperature: 0 };
    if (json) generationConfig.responseMimeType = "application/json";
    if (sendThinkingConfig) generationConfig.thinkingConfig = { thinkingLevel: "minimal" };

    let resp: Response;
    try {
      resp = await fetch(`${API_BASE}/${GEMINI_MODEL}:generateContent?key=${runtimeKey()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Timeouts and network failures degrade like quota exhaustion —
      // callers fall back to retrieval/analytics instead of a 500.
      throw new GeminiUnavailable(
        `Gemini unreachable (${err instanceof Error ? err.name : "network error"}) — try again shortly`,
      );
    }

    if (resp.ok) {
      const body = (await resp.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = (body.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      if (!text) throw new Error("Gemini returned an empty candidate");
      return text;
    }

    const errText = await resp.text();

    if (resp.status === 400 && sendThinkingConfig && errText.toLowerCase().includes("thinking")) {
      sendThinkingConfig = false; // model doesn't take thinkingConfig; drop it for this instance
      continue;
    }
    if (resp.status === 429) {
      throw new GeminiUnavailable("Gemini runtime key is rate-limited — try again in a minute");
    }
    if (resp.status >= 500 && !retriedServerError) {
      retriedServerError = true;
      continue;
    }
    throw new Error(`Gemini HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  throw new GeminiUnavailable("Gemini request did not succeed after retries");
}
