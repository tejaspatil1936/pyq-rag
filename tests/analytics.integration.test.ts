import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clusterSources, topClusters } from "../lib/analytics";
import { closePool, getPool } from "../lib/db";
import { listSubjects } from "../lib/subjects";

const hasDb = Boolean(process.env.DATABASE_URL);

// ANALYTICS path: ranked clusters must be real SQL counts, strictly scoped
// to the requested subject.
describe.skipIf(!hasDb)("cluster analytics (live DB)", () => {
  let subject: string;

  beforeAll(async () => {
    const subjects = await listSubjects();
    subject = subjects.reduce((a, b) => (b.question_count > a.question_count ? b : a)).subject;
  });

  afterAll(() => closePool());

  it("returns clusters ranked by distinct-exam count", async () => {
    const clusters = await topClusters(subject, 10);
    expect(clusters.length).toBeGreaterThan(0);
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i].exam_count).toBeLessThanOrEqual(clusters[i - 1].exam_count);
    }
    for (const c of clusters) {
      expect(c.representative_text.length).toBeGreaterThan(0);
      expect(c.exam_count).toBeGreaterThanOrEqual(1);
      // every member question belongs to exactly one exam, so distinct
      // exams can never exceed raw members
      expect(c.exam_count).toBeLessThanOrEqual(c.question_count);
    }
  });

  it("collapses repeated uploads of the same exam into one count", async () => {
    // Science of Nature is the most duplicate-ridden subject in the corpus
    // ("... (2).pdf" re-uploads of the same sitting).
    const dupeSubject = "Science of Nature";
    const clusters = await topClusters(dupeSubject, 50);
    expect(clusters.length).toBeGreaterThan(0);
    const res = await getPool().query(
      `SELECT cluster_id, COUNT(DISTINCT paper_id)::int AS files
         FROM questions WHERE cluster_id = ANY($1::int[]) GROUP BY cluster_id`,
      [clusters.map((c) => c.cluster_id)],
    );
    const files = new Map(
      (res.rows as { cluster_id: number; files: number }[]).map((r) => [r.cluster_id, r.files]),
    );
    // exam_count never exceeds the number of source files, and for at least
    // one cluster the dedup must actually collapse something.
    let collapsed = 0;
    for (const c of clusters) {
      const f = files.get(c.cluster_id) ?? 0;
      expect(c.exam_count).toBeLessThanOrEqual(f);
      if (c.exam_count < f) collapsed++;
    }
    expect(collapsed).toBeGreaterThan(0);
  });

  it("every returned cluster belongs to the requested subject", async () => {
    const clusters = await topClusters(subject, 10);
    const res = await getPool().query(
      "SELECT COUNT(*)::int AS leaked FROM clusters WHERE id = ANY($1::int[]) AND standard_subject <> $2",
      [clusters.map((c) => c.cluster_id), subject],
    );
    expect(res.rows[0].leaked).toBe(0);
  });

  it("unknown subject yields zero clusters, not an error", async () => {
    expect(await topClusters("__no_such_subject__", 10)).toEqual([]);
  });

  it("resolves source paper links for top clusters", async () => {
    const clusters = await topClusters(subject, 5);
    const sources = await clusterSources(clusters.map((c) => c.cluster_id));
    expect(sources.size).toBeGreaterThan(0);
    for (const list of sources.values()) {
      expect(list.length).toBeLessThanOrEqual(3);
      for (const s of list) {
        expect(s.url).toMatch(/^https?:\/\//);
        expect(s.file_name).toBeTruthy();
      }
    }
  });
});
