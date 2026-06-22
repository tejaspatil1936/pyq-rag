import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AnswerView from "../components/AnswerView";
import type { AskResponse } from "../lib/api-types";

const citation = (ref: number) => ({
  ref,
  question_text: `Question number ${ref}`,
  marks: 5,
  sub_label: null,
  file_name: `paper-${ref}.pdf`,
  year: "2023",
  exam_type: "ESE",
  url: `https://example.com/${ref}.pdf`,
  standard_subject: "Computer Networks",
  similarity: 0.8,
});

function renderSemantic(answer: string, refs: number[]): string {
  const res: AskResponse = {
    intent: "SEMANTIC",
    answer,
    citations: refs.map(citation),
  };
  return renderToStaticMarkup(<AnswerView res={res} msgId={1} />);
}

describe("citation marker rendering", () => {
  it("renders single markers as chips", () => {
    const html = renderSemantic("TCP is reliable [1].", [1]);
    expect(html).toContain(">1</button>");
    expect(html).not.toContain("[1]");
  });

  it("adjacent markers [1][7] render as two chips, never bare '17'", () => {
    const html = renderSemantic("Both protocols appear [1][7] in papers.", [1, 7]);
    expect(html).toContain(">1</button>");
    expect(html).toContain(">7</button>");
    // the reported bug: adjacent markers collapsing into plain "17"
    expect(html).not.toMatch(/>\s*17\s*</);
    expect(html).not.toMatch(/appear\s*17/);
    // chips must never sit flush — visually that also reads as "17"
    expect(html).not.toContain("</button><button");
  });

  it("triple adjacency and punctuation survive", () => {
    const html = renderSemantic("Compare [2][5][10], then decide.", [2, 5, 10]);
    for (const n of [2, 5, 10]) expect(html).toContain(`>${n}</button>`);
  });

  it("real markdown links are left untouched", () => {
    const html = renderSemantic("See [the paper](https://example.com/x.pdf) [1].", [1]);
    expect(html).toContain('href="https://example.com/x.pdf"');
    expect(html).toContain(">1</button>");
  });
});
