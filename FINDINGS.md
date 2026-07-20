# Corpus findings — for owner review (2026-07-20)

Issues found by `pipeline/audit_subjects.py` and the cross-subject battery
that were **deliberately not fixed**: they are taxonomy or data-source
decisions, not code defects. Adaptive serving (small-corpus caveats, figure
annotations) papers over the symptoms; these are the causes.

## Subject taxonomy (owner decisions)

1. **Split twins that are probably one subject** — merge candidates:
   - `Data Structures` (927 q) vs `Advanced Data Structures` (137 q)
   - `Materials Engineering` (1,010 q) vs `Material Engineering` (6 q, 1 exam)
   - `Solid Mechanics` (737 q) vs `Mechanics of Solids` (290 q)
   - `Robot Fundamentals and Kinematics` (53 clusters) vs
     `Kinematics and Dynamics of Robots` (47 clusters)
   Merging means updating `standard_subject` on papers and re-running
   cluster + label for the merged subject.

2. **`Science of Nature` is a mega-merge.** Its papers include Engineering
   Physics, Statistics & Integral Calculus, and Basics of Civil Engineering
   files (visible in file names). The raw `subject` column is unusable for
   splitting ("FY BTECH CH SEM II APR 2024"-style values). Consequence:
   same-session papers of *different courses* count as one exam, and its
   largest cluster has 38 members but only 9 distinct texts. A real fix
   needs a better standardSubject mapping at the metadata source.

3. **Tiny subjects that may be misfiled**: `Network Security` (1 exam, 4
   questions) looks like Computer Networks material; ~10 other subjects have
   a single exam on file (CAD Automation and Customisation, Product
   Management, Contracts Management, …). Small-corpus mode handles the UX;
   whether they should exist as subjects is a taxonomy call.

## Data quality (source or pipeline-history limits)

4. **OCR share is unmeasurable for the existing corpus.** `extract_method`
   was never persisted during the original ingest; tracking landed now, so
   only future papers carry it. Backfilling would require re-downloading
   and re-processing all PDFs in Actions.

5. **Applied Mathematics has a 127-member cluster (82 distinct texts).**
   Likely over-merge of similar formula-question phrasings at 0.80. It does
   NOT show in text-twin risk (that metric targets figure-dependent twins).
   A stricter threshold override would help but wipes + relabels 570
   clusters — left for an Actions run if you approve adding it to
   `CLUSTER_THRESHOLD_OVERRIDES`.

6. **Residual text-twin risk after 0.88 reclustering** (Structural Analysis
   7.4%, Network Analysis Techniques 6.6%): identical question text with a
   *different figure* cannot be split by text embeddings at any threshold.
   Real fix = figure-aware ingest (per-question image hashes). The serving
   layer now annotates these counts instead ("refers to a figure; versions
   may differ").

7. **`Facility Planning and Design`** (4.65% twin risk, 43 clusters) sits
   over the risk threshold but was too small to justify reclustering —
   flag as override candidate if its corpus grows.

8. **Label quality**: labels are generally good post-normalization, but
   near-duplicate label variants can persist below the 0.85 merge
   threshold across subjects (spot-checked, not exhaustively audited).
   The audit's `pct_labeled` is 100% corpus-wide as of this run.

9. **Label contamination (measured, not fixed)** — the audit's
   contradicting-keyword check (`audit_subjects.py`, `CONTRADICTIONS`
   pairs) finds questions whose text contradicts their topic label:
   - `Data Structures`: **12 questions** (mostly *singly*-linked-list
     questions filed under `Doubly Linked List Operations` — the reported
     case). They inflate that topic's count slightly.
   - `Design of Steel Structures`: 3 questions (directed/undirected-style
     modifier mismatches in graph-adjacent phrasing).
   Fixing means re-assigning those questions' clusters or refining labels —
   a relabeling policy decision, so left untouched. The check runs on every
   audit, so growth is visible.
