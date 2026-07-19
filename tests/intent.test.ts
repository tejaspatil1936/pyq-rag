import { describe, expect, it } from "vitest";

import { classifyHeuristic } from "../lib/intent";

// The heuristic is the resilience fallback when the Gemini classification
// call fails; it must at least nail the obvious phrasings of all three
// intents.
describe("classifyHeuristic", () => {
  it.each([
    "most repeated questions",
    "What are the most frequently asked questions?",
    "show me the year-wise trends",
  ])("ANALYTICS: %s", (q) => {
    expect(classifyHeuristic(q).intent).toBe("ANALYTICS");
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
