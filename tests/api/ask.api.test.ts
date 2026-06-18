import { beforeAll, describe, expect, it } from "vitest";

/**
 * Black-box tests for the deployed API surface. Requires a running server:
 *   npm run dev            # then: npm run test:api
 *   API_BASE_URL=https://your-deployment.vercel.app npm run test:api
 */
const BASE = (process.env.API_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

interface AskResponse {
  intent?: string;
  topic?: string;
  answer?: string;
  error?: string;
  clusters?: {
    representative_text: string;
    question_count: number;
    topic_similarity?: number;
    sources: { url: string; file_name: string }[];
  }[];
  citations?: {
    ref: number;
    question_text: string;
    url: string;
    standard_subject: string;
  }[];
}

async function ask(body: unknown): Promise<{ status: number; body: AskResponse }> {
  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as AskResponse };
}

let subjects: { subject: string; question_count: number }[] = [];

function findSubject(re: RegExp): string {
  const hit = subjects.find((s) => re.test(s.subject));
  if (!hit) throw new Error(`no subject matching ${re} among ${subjects.length} subjects`);
  return hit.subject;
}

beforeAll(async () => {
  const res = await fetch(`${BASE}/api/subjects`).catch(() => null);
  if (!res?.ok) {
    throw new Error(`API not reachable at ${BASE} — start \`npm run dev\` or set API_BASE_URL`);
  }
  subjects = ((await res.json()) as { subjects: typeof subjects }).subjects;
  expect(subjects.length).toBeGreaterThan(0);
});

describe(`POST /api/ask @ ${BASE}`, () => {
  it("ANALYTICS: subject-wide frequency question returns real counts + sources", async () => {
    const subject = findSubject(/^computer networks$/i);
    const { status, body } = await ask({
      subject,
      question: "What are the most repeated questions?",
    });
    expect(status).toBe(200);
    expect(body.intent).toBe("ANALYTICS");
    const clusters = body.clusters ?? [];
    expect(clusters.length).toBeGreaterThan(0);
    for (let i = 0; i < clusters.length; i++) {
      expect(clusters[i].question_count).toBeGreaterThanOrEqual(1);
      if (i > 0) {
        expect(clusters[i].question_count).toBeLessThanOrEqual(clusters[i - 1].question_count);
      }
    }
    expect(body.answer).toContain(`${clusters[0].question_count}×`);
    expect(clusters[0].sources.length).toBeGreaterThan(0);
    for (const s of clusters[0].sources) expect(s.url).toMatch(/^https?:\/\//);
  });

  it("TOPIC_ANALYTICS: 'hashing' returns topically relevant clusters", async () => {
    const subject = findSubject(/^data structures$/i);
    const { status, body } = await ask({
      subject,
      question: "what usually gets asked about hashing",
    });
    expect(status).toBe(200);
    expect(body.intent).toBe("TOPIC_ANALYTICS");
    expect(body.topic).toMatch(/hash/i);
    const clusters = body.clusters ?? [];
    expect(clusters.length).toBeGreaterThan(0);
    // topical relevance: matched clusters actually talk about hashing
    const hashy = clusters.filter((c) => /hash/i.test(c.representative_text));
    expect(hashy.length).toBeGreaterThan(0);
    expect(hashy.length).toBeGreaterThanOrEqual(clusters.length / 2);
    // ranked by real frequency, not similarity
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i].question_count).toBeLessThanOrEqual(clusters[i - 1].question_count);
    }
  });

  it("TOPIC_ANALYTICS: the original misrouting bug stays fixed", async () => {
    // Regression: this exact question was classified ANALYTICS and returned
    // the generic subject-wide top-10, ignoring the topic.
    const subject = findSubject(/^computer networks$/i);
    const { status, body } = await ask({
      subject,
      question: "what usually gets asked about TCP congestion control",
    });
    expect(status).toBe(200);
    expect(body.intent).toBe("TOPIC_ANALYTICS");
    expect(body.topic).toMatch(/tcp|congestion/i);
    const clusters = body.clusters ?? [];
    expect(clusters.length).toBeGreaterThan(0);
    const topical = clusters.filter((c) => /tcp|congestion/i.test(c.representative_text));
    expect(topical.length).toBeGreaterThan(0);
  });

  it("SEMANTIC: answers with [n] markers and valid citations", async () => {
    const subject = findSubject(/^computer networks$/i);
    const { status, body } = await ask({
      subject,
      question: "Explain the difference between TCP and UDP.",
    });
    expect(status).toBe(200);
    expect(body.intent).toBe("SEMANTIC");
    expect(body.answer).toBeTruthy();
    expect(body.answer).toMatch(/\[\d+\]/); // inline citation markers
    const citations = body.citations ?? [];
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.length).toBeLessThanOrEqual(10);
    for (const c of citations) {
      expect(c.url).toMatch(/^https?:\/\//);
      expect(c.standard_subject).toBe(subject);
    }
  });

  it("unknown subject → 404", async () => {
    const { status, body } = await ask({
      subject: "__no_such_subject__",
      question: "most repeated questions",
    });
    expect(status).toBe(404);
    expect(body.error).toContain("unknown subject");
  });

  it("empty question → 400", async () => {
    const subject = findSubject(/^computer networks$/i);
    const { status } = await ask({ subject, question: "" });
    expect(status).toBe(400);
  });

  it("subject isolation: AVL trees asked in Thermal Engineering leaks nothing", async () => {
    const subject = findSubject(/^thermal engineering$/i);
    const { status, body } = await ask({
      subject,
      question: "what usually gets asked about AVL trees",
    });
    expect(status).toBe(200);
    // Whatever path it took, nothing from Data Structures may appear: no
    // cluster or citation text about AVL, and citations only from Thermal.
    const texts = [
      ...(body.clusters ?? []).map((c) => c.representative_text),
      ...(body.citations ?? []).map((c) => c.question_text),
    ];
    for (const t of texts) expect(t).not.toMatch(/\bAVL\b/i);
    for (const c of body.citations ?? []) expect(c.standard_subject).toBe(subject);
  });
});
