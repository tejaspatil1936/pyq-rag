import { describe, expect, it } from "vitest";

import { classifyHeuristic } from "../lib/intent";

// The heuristic is the resilience fallback when the Gemini classification
// call fails; it must at least nail the obvious phrasings of all three
// intents.
describe("classifyHeuristic", () => {
  it.each([
    "most repeated questions",
    "What are the most frequently asked questions?",
    "topic-wise weightage please",
    "show me the year-wise trends",
  ])("ANALYTICS: %s", (q) => {
    expect(classifyHeuristic(q).intent).toBe("ANALYTICS");
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
