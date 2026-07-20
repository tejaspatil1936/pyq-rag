"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  type AskResponse,
  type Citation,
  type ClusterResult,
  type TopicResult,
  type TrendTopicResult,
  yearSpan,
} from "@/lib/api-types";

/** Some papers carry the literal string "Unknown" for year/exam_type — hide it. */
function known(value: string | null): string | null {
  return value && value.trim().toLowerCase() !== "unknown" ? value : null;
}

/** Renders one /api/ask response according to its intent. */
export default function AnswerView({ res, msgId }: { res: AskResponse; msgId: number }) {
  if (res.intent === "GREETING") {
    return (
      <div data-testid="greeting-answer" className="prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{res.answer}</ReactMarkdown>
      </div>
    );
  }
  if (res.intent === "REFUSED") {
    return (
      <div data-testid="refused-answer">
        <span className="mb-2 inline-block rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-300">
          Out of scope
        </span>
        <div className="prose prose-sm prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{res.answer}</ReactMarkdown>
        </div>
      </div>
    );
  }
  if (res.intent === "SEMANTIC") {
    return <SemanticAnswer answer={res.answer} citations={res.citations ?? []} msgId={msgId} />;
  }
  if (res.intent === "YEAR_TREND") {
    return <YearTrendAnswer answer={res.answer} trend={res.trend ?? null} />;
  }
  if (res.intent === "TOPIC_WEIGHTAGE" || res.intent === "STUDY_GUIDE") {
    return (
      <TopicAnswer
        intent={res.intent}
        answer={res.answer}
        topics={res.topics ?? []}
        totalExams={res.total_exams ?? null}
      />
    );
  }
  return (
    <div data-testid="analytics-answer">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-xs font-semibold text-indigo-300">
          {res.intent === "ANALYTICS" ? "Most asked — whole subject" : "Topic frequency"}
        </span>
        {res.topic && (
          <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300">
            {res.topic}
          </span>
        )}
        {res.filters && (
          <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-medium text-slate-300">
            {[res.filters.exam_type, res.filters.year].filter(Boolean).join(" ")} only
          </span>
        )}
      </div>
      {/* The nonzero path renders the structured list instead of res.answer,
          so the topic-total lead must be rendered explicitly here — the
          zero path gets it via the answer markdown. */}
      {res.intent === "TOPIC_ANALYTICS" &&
        (res.clusters?.length ?? 0) > 0 &&
        res.topic_exam_count != null &&
        res.total_exams != null && (
          <p className="mb-2 text-sm text-slate-200" data-testid="topic-total-lead">
            <span className="font-semibold">{res.topic}</span> appeared in{" "}
            <span className="font-bold text-emerald-300">{res.topic_exam_count}</span> of{" "}
            {res.total_exams} exams
            {res.filters
              ? ` (${[res.filters.exam_type, res.filters.year].filter(Boolean).join(" ")} only)`
              : ""}
            .
          </p>
        )}
      {(res.clusters?.length ?? 0) === 0 ? (
        <div className="prose prose-sm prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{res.answer}</ReactMarkdown>
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-slate-400">
            Counted over distinct exams — repeated uploads of the same paper count once.
          </p>
          <ol className="space-y-3">
            {res.clusters!.map((c, i) => (
              <ClusterItem
                key={c.cluster_id}
                cluster={c}
                rank={i + 1}
                filterNote={
                  res.filters
                    ? [res.filters.exam_type, res.filters.year].filter(Boolean).join(" ")
                    : null
                }
              />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/**
 * TOPIC_WEIGHTAGE: prose summary + ranked topic list (frequency intent keeps
 * list rendering). STUDY_GUIDE: chat-first — the plan is prose; the data
 * that grounds it sits in one collapsed panel.
 */
function TopicAnswer({
  intent,
  answer,
  topics,
  totalExams,
}: {
  intent: "TOPIC_WEIGHTAGE" | "STUDY_GUIDE";
  answer: string;
  topics: TopicResult[];
  totalExams: number | null;
}) {
  const prose = (
    <div className="prose prose-sm prose-invert max-w-none prose-p:my-2 prose-li:my-0.5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
    </div>
  );
  return (
    <div data-testid={intent === "STUDY_GUIDE" ? "study-guide-answer" : "topic-weightage-answer"}>
      <span className="mb-2 inline-block rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-xs font-semibold text-indigo-300">
        {intent === "STUDY_GUIDE" ? "Study plan" : "Topic weightage"}
        {totalExams != null && ` · ${totalExams} exams analyzed`}
      </span>
      {prose}
      {topics.length > 0 &&
        (intent === "TOPIC_WEIGHTAGE" ? (
          <ol className="mt-3 space-y-2">
            {topics.map((t, i) => (
              <TopicItem key={t.topic} topic={t} rank={i + 1} totalExams={totalExams} />
            ))}
          </ol>
        ) : (
          <details className="mt-3 border-t border-slate-800 pt-2">
            <summary className="cursor-pointer select-none text-xs font-semibold text-slate-400 hover:text-indigo-400">
              The data behind this plan ({topics.length} topics)
            </summary>
            <ol className="mt-2 space-y-2">
              {topics.map((t, i) => (
                <TopicItem key={t.topic} topic={t} rank={i + 1} totalExams={totalExams} />
              ))}
            </ol>
          </details>
        ))}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  rising: "bg-emerald-500/15 text-emerald-300",
  staple: "bg-indigo-500/15 text-indigo-300",
  fading: "bg-slate-800 text-slate-400",
};

/** YEAR_TREND: prose summary + per-topic per-year count table. */
function YearTrendAnswer({
  answer,
  trend,
}: {
  answer: string;
  trend: { years: string[]; topics: TrendTopicResult[] } | null;
}) {
  return (
    <div data-testid="year-trend-answer">
      <span className="mb-2 inline-block rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-xs font-semibold text-indigo-300">
        Year-wise trend
      </span>
      <div className="prose prose-sm prose-invert max-w-none prose-p:my-2">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
      </div>
      {trend && trend.topics.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-max border-collapse text-xs">
            <thead>
              <tr className="bg-slate-900 text-slate-400">
                <th className="px-3 py-2 text-left font-medium">Topic</th>
                {trend.years.map((y) => (
                  <th key={y} className="px-2 py-2 text-center font-medium tabular-nums">
                    ’{y.slice(2)}
                  </th>
                ))}
                <th className="px-2 py-2 text-center font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {trend.topics.map((t) => (
                <tr key={t.topic} className="bg-slate-900/60">
                  <td className="max-w-52 px-3 py-1.5">
                    <span className="line-clamp-2">{t.topic}</span>
                    {t.status && (
                      <span
                        className={`mt-0.5 inline-block rounded-full px-1.5 text-[10px] font-semibold ${STATUS_STYLES[t.status]}`}
                      >
                        {t.status}
                      </span>
                    )}
                  </td>
                  {t.counts.map((n, i) => (
                    <td
                      key={trend.years[i]}
                      className={`px-2 py-1.5 text-center tabular-nums ${n === 0 ? "text-slate-600" : "text-slate-200"}`}
                    >
                      {n === 0 ? "·" : n}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-center font-semibold tabular-nums text-emerald-300">
                    {t.exam_count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TopicItem({
  topic: t,
  rank,
  totalExams,
}: {
  topic: TopicResult;
  rank: number;
  totalExams: number | null;
}) {
  const span =
    t.years.length === 0
      ? null
      : t.years.length === 1
        ? t.years[0]
        : `${t.years[0]}–${t.years[t.years.length - 1]}`;
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900 p-3 shadow-sm">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug">{t.topic}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-300">
              {t.exam_count}
              {totalExams != null ? ` of ${totalExams}` : ""} exam{t.exam_count === 1 ? "" : "s"}
            </span>
            {span && <span className="rounded-full bg-slate-800 px-2 py-0.5 text-slate-300">{span}</span>}
            {t.total_marks != null && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-300">
                {t.total_marks} marks total
              </span>
            )}
          </div>
          {t.questions.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer select-none text-xs font-medium text-slate-400 hover:text-indigo-400">
                Questions ({t.questions.length})
              </summary>
              <ul className="mt-1.5 space-y-1">
                {t.questions.map((q) => (
                  <li
                    key={q.text.slice(0, 80)}
                    className="rounded-lg bg-slate-800/60 px-2.5 py-1.5 text-xs text-slate-300"
                  >
                    <span className="line-clamp-2">{q.text}</span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      asked in {q.exam_count} exam{q.exam_count === 1 ? "" : "s"}
                    </span>
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

function ClusterItem({
  cluster: c,
  rank,
  filterNote = null,
}: {
  cluster: ClusterResult;
  rank: number;
  filterNote?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const span = yearSpan(c.years_spanned);
  const long = c.representative_text.length > 180;
  // Filtered views must never show an all-time range next to a filtered
  // count — label both sides explicitly instead.
  const countChip = `${c.exam_count} exam${c.exam_count === 1 ? "" : "s"}${filterNote ? ` in ${filterNote}` : ""}`;
  const yearsChip = filterNote ? (span ? `asked since ${span.split("–")[0]}` : null) : span;
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900 p-3 shadow-sm">
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
              className="mt-1 text-xs font-medium text-indigo-400"
            >
              {expanded ? "Show less" : "Show full question"}
            </button>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-300">
              {countChip}
            </span>
            {yearsChip && (
              <span className="rounded-full bg-slate-800 px-2 py-0.5 text-slate-300">{yearsChip}</span>
            )}
            {c.topic_similarity != null && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-300">
                {Math.round(c.topic_similarity * 100)}% match
              </span>
            )}
          </div>
          {c.sources.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer select-none text-xs font-medium text-slate-400 hover:text-indigo-400">
                Sources ({c.sources.length})
              </summary>
              <ul className="mt-1.5 space-y-1">
                {c.sources.map((s) => (
                  <li key={s.url}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate rounded-lg bg-slate-800/60 px-2.5 py-1.5 text-xs text-indigo-300 underline-offset-2 hover:underline"
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
  // Comma/and groups like [1, 5] or [1, 3, 5, and 6] expand to one chip per
  // number; adjacent markers like [1][7] are split — flush chips read as a
  // bare "17" — and the link text avoids nested brackets ("c1", never
  // rendered: the chip shows the number parsed from the href).
  // The (?!\() lookaheads leave real markdown links like [text](url) alone.
  const processed = answer
    .replace(/\[(\d+(?:[\s,&]+(?:and\s+)?\d+)+)\](?!\()/gi, (_m, group: string) =>
      (group.match(/\d+/g) ?? []).map((n) => `[c${n}](#cite-${n})`).join(" "),
    )
    .replace(/\](?=\[\d+\])/g, "] ")
    .replace(/\[(\d+)\](?!\()/g, (_m, n) => `[c${n}](#cite-${n})`);

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
      <div className="prose prose-sm prose-invert max-w-none prose-p:my-2 prose-li:my-0.5">
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
                    className="mx-0.5 inline-flex -translate-y-0.5 items-center rounded bg-indigo-500/20 px-1 text-[11px] font-semibold text-indigo-300 no-underline hover:bg-indigo-500/30"
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
          className="mt-3 border-t border-slate-800 pt-2"
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
        >
          <summary className="cursor-pointer select-none text-xs font-semibold text-slate-400 hover:text-indigo-400">
            Sources — {citations.length} question{citations.length === 1 ? "" : "s"} from past
            papers
          </summary>
          <ul className="mt-2 space-y-2">
            {citations.map((c) => (
              <li
                key={c.ref}
                id={`cite-${msgId}-${c.ref}`}
                className={`rounded-lg border border-slate-800 bg-slate-800/60 p-2.5 ${flashRef === c.ref ? "cite-flash" : ""}`}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-indigo-500/20 text-[11px] font-bold text-indigo-300">
                    {c.ref}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-3 text-xs leading-snug text-slate-300">
                      {c.question_text}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                      {known(c.year) && <span>{c.year}</span>}
                      {known(c.exam_type) && (
                        <span className="rounded bg-slate-700 px-1.5">{c.exam_type}</span>
                      )}
                      {c.marks != null && <span>{c.marks} marks</span>}
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-indigo-400 underline-offset-2 hover:underline"
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
