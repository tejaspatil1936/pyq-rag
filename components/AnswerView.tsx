"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { type AskResponse, type Citation, type ClusterResult, yearSpan } from "@/lib/api-types";

/** Some papers carry the literal string "Unknown" for year/exam_type — hide it. */
function known(value: string | null): string | null {
  return value && value.trim().toLowerCase() !== "unknown" ? value : null;
}

/** Renders one /api/ask response according to its intent. */
export default function AnswerView({ res, msgId }: { res: AskResponse; msgId: number }) {
  if (res.intent === "REFUSED") {
    return (
      <div data-testid="refused-answer">
        <span className="mb-2 inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
          Out of scope
        </span>
        <div className="prose prose-sm prose-slate max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{res.answer}</ReactMarkdown>
        </div>
      </div>
    );
  }
  if (res.intent === "SEMANTIC") {
    return <SemanticAnswer answer={res.answer} citations={res.citations ?? []} msgId={msgId} />;
  }
  return (
    <div data-testid="analytics-answer">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
          {res.intent === "ANALYTICS" ? "Most asked — whole subject" : "Topic frequency"}
        </span>
        {res.topic && (
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
            {res.topic}
          </span>
        )}
      </div>
      {(res.clusters?.length ?? 0) === 0 ? (
        <div className="prose prose-sm prose-slate max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{res.answer}</ReactMarkdown>
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-slate-500">
            Counted over distinct exams — repeated uploads of the same paper count once.
          </p>
          <ol className="space-y-3">
            {res.clusters!.map((c, i) => (
              <ClusterItem key={c.cluster_id} cluster={c} rank={i + 1} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function ClusterItem({ cluster: c, rank }: { cluster: ClusterResult; rank: number }) {
  const [expanded, setExpanded] = useState(false);
  const span = yearSpan(c.years_spanned);
  const long = c.representative_text.length > 180;
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={`whitespace-pre-line text-sm leading-snug ${!expanded && long ? "line-clamp-3" : ""}`}
          >
            {c.representative_text}
          </p>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs font-medium text-indigo-600"
            >
              {expanded ? "Show less" : "Show full question"}
            </button>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
              {c.exam_count} exam{c.exam_count === 1 ? "" : "s"}
            </span>
            {span && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{span}</span>}
            {c.topic_similarity != null && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
                {Math.round(c.topic_similarity * 100)}% match
              </span>
            )}
          </div>
          {c.sources.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer select-none text-xs font-medium text-slate-500 hover:text-indigo-600">
                Sources ({c.sources.length})
              </summary>
              <ul className="mt-1.5 space-y-1">
                {c.sources.map((s) => (
                  <li key={s.url}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-indigo-700 underline-offset-2 hover:underline"
                      title={s.file_name}
                    >
                      {[known(s.year), known(s.exam_type)].filter(Boolean).join(" · ") || "PDF"} —{" "}
                      {s.file_name}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

function SemanticAnswer({
  answer,
  citations,
  msgId,
}: {
  answer: string;
  citations: Citation[];
  msgId: number;
}) {
  const [open, setOpen] = useState(false);
  const [flashRef, setFlashRef] = useState<number | null>(null);

  // Turn bare [n] markers into markdown links the renderer below intercepts.
  // The (?!\() lookahead leaves real markdown links like [text](url) alone.
  const processed = answer.replace(/\[(\d+)\](?!\()/g, (_m, n) => `[[${n}]](#cite-${n})`);

  const jumpTo = (ref: number) => {
    setOpen(true);
    setFlashRef(ref);
    requestAnimationFrame(() => {
      document
        .getElementById(`cite-${msgId}-${ref}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    setTimeout(() => setFlashRef(null), 1700);
  };

  return (
    <div data-testid="semantic-answer">
      <div className="prose prose-sm prose-slate max-w-none prose-p:my-2 prose-li:my-0.5">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              const cite = href?.match(/^#cite-(\d+)$/);
              if (cite) {
                const ref = Number(cite[1]);
                return (
                  <button
                    type="button"
                    onClick={() => jumpTo(ref)}
                    className="mx-0.5 inline-flex -translate-y-0.5 items-center rounded bg-indigo-100 px-1 text-[11px] font-semibold text-indigo-700 no-underline hover:bg-indigo-200"
                    title={`Show source ${ref}`}
                  >
                    {ref}
                  </button>
                );
              }
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {processed}
        </ReactMarkdown>
      </div>

      {citations.length > 0 && (
        <details
          className="mt-3 border-t border-slate-100 pt-2"
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
        >
          <summary className="cursor-pointer select-none text-xs font-semibold text-slate-500 hover:text-indigo-600">
            Sources — {citations.length} question{citations.length === 1 ? "" : "s"} from past
            papers
          </summary>
          <ul className="mt-2 space-y-2">
            {citations.map((c) => (
              <li
                key={c.ref}
                id={`cite-${msgId}-${c.ref}`}
                className={`rounded-lg border border-slate-200 bg-slate-50 p-2.5 ${flashRef === c.ref ? "cite-flash" : ""}`}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-indigo-100 text-[11px] font-bold text-indigo-700">
                    {c.ref}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-3 text-xs leading-snug text-slate-700">
                      {c.question_text}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                      {known(c.year) && <span>{c.year}</span>}
                      {known(c.exam_type) && (
                        <span className="rounded bg-slate-200 px-1.5">{c.exam_type}</span>
                      )}
                      {c.marks != null && <span>{c.marks} marks</span>}
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-indigo-600 underline-offset-2 hover:underline"
                      >
                        Open paper ↗
                      </a>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
