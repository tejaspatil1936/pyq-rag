import { afterAll, describe, expect, it } from "vitest";

import { closePool } from "../lib/db";
import { topicQuestions, topicWeightage, totalExams } from "../lib/topics";

const hasDb = Boolean(process.env.DATABASE_URL);

// Requires label_topics.py to have run for these subjects (done for
// Computer Networks and Data Structures).
describe.skipIf(!hasDb)("topic weightage (live DB)", () => {
  afterAll(() => closePool());

  it("ranks canonical topics by distinct-exam coverage", async () => {
    const [topics, total] = await Promise.all([
      topicWeightage("Data Structures", 10),
      totalExams("Data Structures"),
    ]);
    expect(total).toBeGreaterThan(0);
    expect(topics.length).toBeGreaterThan(3);
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      // topic names, not raw question texts
      expect(t.topic.length).toBeGreaterThan(2);
      expect(t.topic.length).toBeLessThanOrEqual(80);
      expect(t.topic).not.toMatch(/\?$/);
      expect(t.exam_count).toBeGreaterThanOrEqual(1);
      expect(t.exam_count).toBeLessThanOrEqual(total);
      if (i > 0) expect(t.exam_count).toBeLessThanOrEqual(topics[i - 1].exam_count);
    }
  });

  it("resolves example questions per topic", async () => {
    const topics = await topicWeightage("Computer Networks", 5);
    const questions = await topicQuestions(
      "Computer Networks",
      topics.map((t) => t.topic),
    );
    expect(questions.size).toBeGreaterThan(0);
    for (const list of questions.values()) {
      expect(list.length).toBeLessThanOrEqual(4);
      for (const q of list) expect(q.text.length).toBeGreaterThan(0);
    }
  });

  it("denominator invariant: every count fits the subject's real exam total", async () => {
    for (const subject of ["Data Structures", "Structural Analysis", "Thermal Engineering"]) {
      const [topics, total] = await Promise.all([topicWeightage(subject, 15), totalExams(subject)]);
      for (const t of topics) expect(t.exam_count).toBeLessThanOrEqual(total);
    }
  });

  it("respects a requested size", async () => {
    const topics = await topicWeightage("Data Structures", 5);
    expect(topics.length).toBe(5);
  });
});
