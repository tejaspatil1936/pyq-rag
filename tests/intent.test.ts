import { describe, expect, it } from "vitest";

import { classifyHeuristic } from "../lib/intent";

// The heuristic is the resilience fallback when the Gemini classification
// call fails; it must at least nail the obvious phrasings.
describe("classifyHeuristic", () => {
  it.each([
    "most repeated questions",
    "What are the most frequently asked questions?",
    "how many times was normalization asked",
    "topic-wise weightage please",
    "year-wise trend of questions on TCP",
  ])("ANALYTICS: %s", (q) => {
    expect(classifyHeuristic(q)).toBe("ANALYTICS");
  });

  it.each([
    "explain database normalization with an example",
    "what questions cover TCP congestion control?",
    "how do I answer the question on paging vs segmentation?",
  ])("SEMANTIC: %s", (q) => {
    expect(classifyHeuristic(q)).toBe("SEMANTIC");
  });
});
