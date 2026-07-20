import { describe, expect, it } from "vitest";

import { classifyHeuristic, coerceClassification, type Classification } from "../lib/intent";

const cls = (partial: Partial<Classification>): Classification => ({
  inScope: true,
  intent: "SEMANTIC",
  topic: null,
  rewritten: null,
  topN: null,
  solving: false,
  predictive: false,
  year: null,
  examType: null,
  ...partial,
});

// The heuristic is the resilience fallback when the Gemini classification
// call fails; it must at least nail the obvious phrasings of all three
// intents.
describe("classifyHeuristic", () => {
  it.each([
    "most repeated questions",
    "What are the most frequently asked questions?",
  ])("ANALYTICS: %s", (q) => {
    expect(classifyHeuristic(q).intent).toBe("ANALYTICS");
  });

  it.each([
    "show me the year-wise trends",
    "what's hot recently",
    "which topics are trending over the years",
  ])("YEAR_TREND: %s", (q) => {
    expect(classifyHeuristic(q).intent).toBe("YEAR_TREND");
  });

  it.each([
    "topic-wise weightage please",
    "most important topics",
    "which topics matter the most",
    "list down 5 important topics",
  ])("TOPIC_WEIGHTAGE: %s", (q) => {
    expect(classifyHeuristic(q).intent).toBe("TOPIC_WEIGHTAGE");
  });

  it.each([
    "how to study for the exam",
    "what to study 1st",
    "make me a study plan",
    "how should I prepare for the exam?",
  ])("STUDY_GUIDE: %s", (q) => {
    expect(classifyHeuristic(q).intent).toBe("STUDY_GUIDE");
  });

  it("extracts the requested topic count", () => {
    expect(classifyHeuristic("list down 5 important topics").topN).toBe(5);
    expect(classifyHeuristic("top 3 topics please").topN).toBe(3);
    expect(classifyHeuristic("most important topics").topN).toBeNull();
  });

  it("flags prediction phrasings", () => {
    expect(classifyHeuristic("predict what will come this year").predictive).toBe(true);
    expect(classifyHeuristic("what will be asked this year?").predictive).toBe(true);
    expect(classifyHeuristic("most repeated questions").predictive).toBe(false);
  });

  it("extracts year and exam-type filters", () => {
    const a = classifyHeuristic("questions that came in 2024");
    expect(a.intent).toBe("ANALYTICS");
    expect(a.year).toBe("2024");
    const b = classifyHeuristic("most asked in MSE");
    expect(b.intent).toBe("ANALYTICS");
    expect(b.examType).toBe("MSE");
    const c = classifyHeuristic("last year's ESE papers");
    expect(c.intent).toBe("ANALYTICS");
    expect(c.examType).toBe("ESE");
    expect(c.year).toBe(String(new Date().getFullYear() - 1));
    expect(classifyHeuristic("explain the OSI model").year).toBeNull();
  });

  it("skip phrasings land on the study guide, even via heuristic", () => {
    expect(classifyHeuristic("which topics can I skip if I'm short on time?").intent).toBe(
      "STUDY_GUIDE",
    );
  });

  it("coerceClassification corrects known classifier drift", () => {
    // skip questions must reach the study guide (only path with the tail)
    expect(
      coerceClassification(cls({ intent: "TOPIC_WEIGHTAGE" }), "which topics can I skip?").intent,
    ).toBe("STUDY_GUIDE");
    // a filter-only query is an analytics ask, not semantic search
    expect(
      coerceClassification(cls({ year: "2025", examType: "ESE" }), "last year's ESE").intent,
    ).toBe("ANALYTICS");
    // real semantic questions that merely mention a year stay semantic
    expect(
      coerceClassification(
        cls({ year: "2024", examType: "ESE" }),
        "explain the subnetting question from the 2024 ESE paper",
      ).intent,
    ).toBe("SEMANTIC");
    expect(
      coerceClassification(cls({ intent: "TOPIC_WEIGHTAGE" }), "most important topics").intent,
    ).toBe("TOPIC_WEIGHTAGE");
  });

  it("count-phrased topic questions always reach the exam-total path", () => {
    // even if the classifier says SEMANTIC, the topic gets extracted
    const a = coerceClassification(cls({}), "how many times has hashing been asked");
    expect(a.intent).toBe("TOPIC_ANALYTICS");
    expect(a.topic).toMatch(/hashing/i);
    // an existing topic from the classifier is kept
    const b = coerceClassification(
      cls({ intent: "TOPIC_WEIGHTAGE", topic: "recursion" }),
      "how often does recursion come up",
    );
    expect(b.intent).toBe("TOPIC_ANALYTICS");
    expect(b.topic).toBe("recursion");
    // count phrasing without any topic stays put
    expect(coerceClassification(cls({ intent: "ANALYTICS" }), "how many times were papers repeated").intent).toBe(
      "ANALYTICS",
    );
    // typo tolerance: dropped leading "h" must not lose the count path
    const typo = coerceClassification(cls({}), "ow many times has hashing been asked");
    expect(typo.intent).toBe("TOPIC_ANALYTICS");
    expect(typo.topic).toMatch(/hashing/i);
  });

  it("flags solving intent for worked-problem requests", () => {
    const c = classifyHeuristic("solve the 2019 subnetting numerical for me");
    expect(c.intent).toBe("SEMANTIC");
    expect(c.solving).toBe(true);
    expect(classifyHeuristic("explain the OSI model").solving).toBe(false);
  });

  it.each([
    ["what usually gets asked about TCP congestion control", /tcp congestion control/i],
    ["questions on hashing", /hashing/i],
    ["year-wise trend of questions on TCP", /tcp/i],
    ["how many times was normalization asked", /normalization/i],
  ] as [string, RegExp][])("TOPIC_ANALYTICS: %s", (q, topicRe) => {
    const { intent, topic } = classifyHeuristic(q);
    expect(intent).toBe("TOPIC_ANALYTICS");
    expect(topic).toMatch(topicRe);
  });

  it.each([
    "explain database normalization with an example",
    "how do I answer the question on paging vs segmentation?",
    "what is a B+ tree used for?",
    "compare mesh and star topologies",
  ])("SEMANTIC: %s", (q) => {
    expect(classifyHeuristic(q).intent).toBe("SEMANTIC");
  });
});
