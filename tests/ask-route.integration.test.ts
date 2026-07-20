import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST } from "../app/api/ask/route";
import { closePool } from "../lib/db";
import { listSubjects } from "../lib/subjects";

const hasDb = Boolean(process.env.DATABASE_URL);
// Semantic synthesis needs a live Gemini key (rotated pool); the analytics
// path is deterministic SQL + formatting and runs without any key.
const hasGemini = Boolean(process.env.GEMINI_API_KEYS);

const ask = (body: unknown) =>
  POST(
    new Request("http://localhost/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe.skipIf(!hasDb)("POST /api/ask (live DB)", () => {
  let subject: string;

  beforeAll(async () => {
    const subjects = await listSubjects();
    subject = subjects.reduce((a, b) => (b.question_count > a.question_count ? b : a)).subject;
  });

  afterAll(() => closePool());

  it("rejects a missing subject/question with 400", async () => {
    expect((await ask({})).status).toBe(400);
    expect((await ask({ subject: "x" })).status).toBe(400);
  });

  it("rejects an unknown subject with 404", async () => {
    const res = await ask({ subject: "__no_such_subject__", question: "most repeated questions" });
    expect(res.status).toBe(404);
  });

  it("answers an analytics question with ranked real counts", async () => {
    const res = await ask({ subject, question: "What are the most repeated questions?" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intent).toBe("ANALYTICS");
    expect(body.clusters.length).toBeGreaterThan(0);
    expect(body.answer).toContain("Most frequently asked");
    // counts in the answer come straight from SQL rows (distinct exams)
    expect(body.answer).toContain(`**${body.clusters[0].exam_count}** exam`);
    expect(body.clusters[0].sources.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasGemini)("answers a semantic question with [n]-cited sources", async () => {
    // Pinned to a corpus-anchored query so the grounding floor is cleared.
    const subject = "Computer Networks";
    const res = await ask({
      subject,
      question: "Explain the difference between TCP and UDP.",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intent).toBe("SEMANTIC");
    expect(body.answer.length).toBeGreaterThan(0);
    expect(body.answer).toMatch(/\[\d+\]/); // inline citation markers
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.citations.length).toBeLessThanOrEqual(10);
    for (const c of body.citations) {
      expect(c.url).toMatch(/^https?:\/\//);
      expect(c.standard_subject).toBe(subject);
    }
  });
});
