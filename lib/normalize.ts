/**
 * Query normalization ahead of classification/embedding: students type fast
 * and abbreviated on phones. Expansions are word-boundary and conservative —
 * only unambiguous study shorthand.
 */

const EXPANSIONS: [RegExp, string][] = [
  [/\bimp\b/gi, "important"],
  [/\b(?:ques|qs|que|qstn|qsn)\b/gi, "questions"],
  [/\bfreq\b/gi, "frequently"],
  [/\byr\b/gi, "year"],
  [/\bsem\b/gi, "semester"],
  [/\bdefn?\b/gi, "definition"],
  [/\bexpl?[ai]?n\b/gi, "explain"],
  [/\bw\/o\b/gi, "without"],
  [/\bb\/w\b/gi, "between"],
  [/\bdiff\b/gi, "difference"],
];

export function normalizeQuery(question: string): string {
  let q = question.trim().replace(/\s+/g, " ");
  for (const [pattern, replacement] of EXPANSIONS) {
    q = q.replace(pattern, replacement);
  }
  return q;
}
