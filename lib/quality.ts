/**
 * Server-side answer-quality contract for Gemini prose: length caps, banned
 * filler/consultant-speak, verdict-first shape. A failing draft gets ONE
 * corrective retry; the better draft is served (availability beats polish)
 * with the failure logged.
 */

export const BANNED_PHRASES: RegExp[] = [
  /to maximi[sz]e your (?:efficiency|score|marks|results)/i,
  /it is important to (?:note|remember|understand)/i,
  /it'?s (?:important|worth) (?:to note|noting)/i,
  /high[- ]value (?:area|topic|question)/i,
  /long[- ]standing staples?/i,
  /\bin conclusion\b/i,
  /\bdelve\b/i,
  /\bleverage\b/i,
  /\butili[sz]e\b/i,
  /comprehensive understanding/i,
  /crucial (?:role|aspect)/i,
  /in the realm of/i,
  /\bfurthermore\b/i,
  /be strategic about/i,
];

export function countWords(text: string): number {
  const stripped = text
    .replace(/[*_#>`]/g, " ")
    .replace(/\[(\d+)\]/g, " ") // citation chips aren't prose
    .trim();
  return stripped.length === 0 ? 0 : stripped.split(/\s+/).length;
}

export interface QualityVerdict {
  ok: boolean;
  problems: string[];
}

export function checkAnswerQuality(
  answer: string,
  opts: { maxWords: number; requireVerdictFirst?: boolean },
): QualityVerdict {
  const problems: string[] = [];

  const words = countWords(answer);
  if (words > opts.maxWords) problems.push(`too long: ${words} words (cap ${opts.maxWords})`);

  for (const re of BANNED_PHRASES) {
    const m = re.exec(answer);
    if (m) problems.push(`banned phrase: "${m[0]}"`);
  }

  if (opts.requireVerdictFirst !== false) {
    const firstLine = answer.split("\n").find((l) => l.trim().length > 0) ?? "";
    if (!/^\s*\*\*[^*]/.test(firstLine)) {
      problems.push("missing bold verdict line first");
    }
  }

  return { ok: problems.length === 0, problems };
}
