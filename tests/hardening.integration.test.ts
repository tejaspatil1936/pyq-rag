import { afterAll, describe, expect, it, vi } from "vitest";

import { closePool } from "../lib/db";

// Simulate the runtime key's daily quota being exhausted: every Gemini call
// throws GeminiUnavailable. Classification then falls back to the regex
// heuristic and synthesis must degrade gracefully — the site never goes
// dark because of quota.
vi.mock("../lib/gemini", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/gemini")>();
  return {
    ...mod,
    generateText: vi.fn(async () => {
      throw new mod.GeminiUnavailable("daily quota exhausted (mocked)");
    }),
  };
});

import { POST } from "../app/api/ask/route";

const hasDb = Boolean(process.env.DATABASE_URL);

const ask = (body: unknown) =>
  POST(
    new Request("http://localhost/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe.skipIf(!hasDb)("quota-exhausted behavior (live DB, mocked Gemini)", () => {
  afterAll(async () => {
    delete process.env.RATE_LIMIT_SYNTH_PER_HOUR;
    await closePool();
  });

  it("zero-match topic queries still lead with the exam total", async () => {
    // Heuristic routes this to TOPIC_ANALYTICS; the nonsense topic matches
    // no clusters — the answer must still open with "appeared in 0 of M".
    const res = await ask({
      subject: "Computer Networks",
      question: "what usually gets asked about flurbification theory",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intent).toBe("TOPIC_ANALYTICS");
    expect(body.topic_exam_count).toBe(0);
    expect(body.answer).toMatch(/^\*\*.+\*\* appeared in \*\*0\*\* of \d+ Computer Networks exams/);
  });

  it("analytics keeps working with Gemini fully down", async () => {
    const res = await ask({
      subject: "Computer Networks",
      question: "What are the most repeated questions?",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intent).toBe("ANALYTICS");
    expect(body.clusters.length).toBeGreaterThan(0);
  });

  it("semantic degrades to raw retrieval instead of failing", async () => {
    const res = await ask({
      subject: "Computer Networks",
      question: "Explain the difference between TCP and UDP.",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.answer).toMatch(/resting until tomorrow/i);
    expect(body.citations.length).toBeGreaterThan(0);
    for (const c of body.citations) expect(c.standard_subject).toBe("Computer Networks");
  });

  it("synthesis rate limit returns a friendly 429 before any Gemini spend", async () => {
    process.env.RATE_LIMIT_SYNTH_PER_HOUR = "0";
    const res = await ask({
      subject: "Computer Networks",
      question: "Explain how congestion control works in detail.",
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/hour's AI answers/i);
  });
});
