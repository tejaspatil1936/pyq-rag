"use client";

import { useState, type ReactNode } from "react";
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
import {
  PRIORITY_MUST_RATIO,
  PRIORITY_SHOULD_RATIO,
  QUESTION_MUST_RATIO,
  QUESTION_SHOULD_RATIO,
} from "@/lib/config";

/** Some papers carry the literal string "Unknown" for year/exam_type — hide it. */
function known(value: string | null): string | null {
  return value && value.trim().toLowerCase() !== "unknown" ? value : null;
}

/* ---------- shared glanceable primitives ---------- */

const TIER_STYLES = {
  must: { label: "Must know", classes: "bg-indigo-500 text-white" },
  should: { label: "Should know", classes: "bg-indigo-500/15 text-indigo-300" },
  ifTime: { label: "If time permits", classes: "bg-slate-800 text-slate-400" },
};

/** Topic-level tiers: fraction of the subject's total exams. */
function priorityTier(examCount: number, total: number | null) {
  if (!total || total <= 0) return null;
  const ratio = examCount / total;
  if (ratio >= PRIORITY_MUST_RATIO) return TIER_STYLES.must;
  if (ratio >= PRIORITY_SHOULD_RATIO) return TIER_STYLES.should;
  return TIER_STYLES.ifTime;
}

/** Question-level tiers: relative to the list's top count, so the #1
 *  most-repeated question is always "Must know". */
function questionTier(examCount: number, maxInList: number | null) {
  if (!maxInList || maxInList <= 0) return null;
  const ratio = examCount / maxInList;
  if (ratio >= QUESTION_MUST_RATIO) return TIER_STYLES.must;
  if (ratio >= QUESTION_SHOULD_RATIO) return TIER_STYLES.should;
  return TIER_STYLES.ifTime;
}

function CoverageBar({ count, total }: { count: number; total: number | null }) {
  if (!total || total <= 0) return null;
  const pct = Math.max(2, Math.min(100, Math.round((count / total) * 100)));
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-800">
      <div className="h-full rounded-full bg-indigo-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The count is the boldest element on every row. */
function BigCount({ count, total }: { count: number; total: number | null }) {
  return (
    <span className="shrink-0 whitespace-nowrap tabular-nums">
      <span className="text-lg font-extrabold leading-none text-slate-50">{count}</span>
      {total != null && total > 0 && <span className="text-xs text-slate-500">/{total}</span>}
    </span>
  );
}

function MutedPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-slate-800/60 px-2 py-0.5 text-[11px] text-slate-500">
      {children}
    </span>
  );
}

function TopicChip({ topic }: { topic?: string | null }) {
  if (!topic) return null;
  return (
    <span className="mr-1.5 inline-block max-w-44 truncate rounded bg-indigo-500/10 px-1.5 py-0.5 align-middle text-[10px] font-medium text-indigo-300/90">
      {topic}
    </span>
  );
}

/** ⓘ tooltip carrying the methodology note once, instead of on every answer. */
function MethodNote() {
  return (
    <details className="relative inline-block align-middle">
      <summary className="inline-flex h-6 w-6 min-h-0 cursor-pointer list-none items-center justify-center rounded-full text-sm text-slate-500 hover:text-indigo-300 [&::-webkit-details-marker]:hidden">
        ⓘ
      </summary>
      <div className="absolute left-0 z-10 mt-1 w-64 rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-xs leading-snug text-slate-300 shadow-xl">
        Counted over distinct exams — repeated uploads of the same paper count once.
      </div>
    </details>
  );
}

/** Universal 2-line clamp with tap-to-expand (44px minimum tap target). */
function ExpandableText({ text, className = "" }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className={`block min-h-11 w-full cursor-pointer text-left ${className}`}
      title={expanded ? "Collapse" : "Show full text"}
    >
      <span className={`whitespace-pre-line ${expanded ? "" : "line-clamp-2"}`}>{text}</span>
    </button>
  );
}

/** "49 exams · 150 topics · top topic in 61% of exams" — the concentration
 *  stat uses exam coverage, never a denominator that dilutes it. */
function StatStrip({
  totalExams,
  topicCount,
  topics,
  smallCorpus = false,
}: {
  totalExams: number | null;
  topicCount?: number;
  topics: TopicResult[];
  smallCorpus?: boolean;
}) {
  if (totalExams == null) return null;
  // Small archives get raw counts only — a percentage of 3 exams is noise.
  const parts: string[] = [`${totalExams} exam${totalExams === 1 ? "" : "s"}${smallCorpus ? " (small archive)" : ""}`];
  if (topicCount) parts.push(`${topicCount} topics`);
  if (!smallCorpus && totalExams > 0 && topics.length > 0) {
    parts.push(`top topic in ${Math.round((topics[0].exam_count / totalExams) * 100)}% of exams`);
  }
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-slate-400"
      data-testid="stat-strip"
    >
      <span>{parts.join(" · ")}</span>
      <MethodNote />
    </div>
  );
}

const Prose = ({ children }: { children: string }) => (
  <div className="prose prose-sm prose-invert max-w-none prose-p:my-2 prose-li:my-0.5">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  </div>
);

/* ---------- intent renderers ---------- */

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
        <span className="mb-2 inline-block rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-semibold text-slate-300">
          Out of scope
        </span>
        <Prose>{res.answer}</Prose>
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
    return <TopicAnswer res={res} />;
  }

  /* ANALYTICS + TOPIC_ANALYTICS */
  const filterNote = res.filters
    ? [res.filters.exam_type, res.filters.year].filter(Boolean).join(" ")
    : null;
  return (
    <div data-testid="analytics-answer">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-xs font-semibold text-indigo-300">
          {res.intent === "ANALYTICS" ? "Most asked — whole subject" : "Topic frequency"}
        </span>
        {res.topic && (
          <span className="max-w-48 truncate rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-medium text-slate-300">
            {res.topic}
          </span>
        )}
        {filterNote && (
          <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-medium text-slate-300">
            {filterNote} only
          </span>
        )}
        <MethodNote />
      </div>
      {res.intent === "TOPIC_ANALYTICS" &&
        (res.clusters?.length ?? 0) > 0 &&
        res.topic_exam_count != null &&
        res.total_exams != null && (
          <p className="mb-2 text-sm text-slate-200" data-testid="topic-total-lead">
            <span className="font-semibold">{res.topic}</span> appeared in{" "}
            <span className="text-lg font-extrabold text-slate-50">{res.topic_exam_count}</span> of{" "}
            {res.total_exams} exams
            {filterNote ? ` (${filterNote} only)` : ""}.
          </p>
        )}
      {(res.clusters?.length ?? 0) === 0 ? (
        <Prose>{res.answer}</Prose>
      ) : (
        <ol className="space-y-3.5">
          {res.clusters!.map((c, i) => (
            <ClusterItem
              key={c.cluster_id}
              cluster={c}
              rank={i + 1}
              totalExams={res.total_exams ?? null}
              maxExamCount={Math.max(...res.clusters!.map((x) => x.exam_count))}
              filterNote={filterNote}
              smallCorpus={res.small_corpus === true}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function ClusterItem({
  cluster: c,
  rank,
  totalExams,
  maxExamCount = null,
  filterNote = null,
  smallCorpus = false,
}: {
  cluster: ClusterResult;
  rank: number;
  totalExams: number | null;
  maxExamCount?: number | null;
  filterNote?: string | null;
  smallCorpus?: boolean;
}) {
  const span = yearSpan(c.years_spanned);
  const yearsChip = filterNote ? (span ? `asked since ${span.split("–")[0]}` : null) : span;
  const tier = smallCorpus ? null : questionTier(c.exam_count, maxExamCount);
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900 p-3.5 shadow-sm">
      <div className="flex gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <TopicChip topic={c.topic} />
              <ExpandableText text={c.representative_text} className="text-sm leading-snug" />
            </div>
            <BigCount count={c.exam_count} total={totalExams} />
          </div>
          <CoverageBar count={c.exam_count} total={totalExams} />
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            {tier && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tier.classes}`}>
                {tier.label}
              </span>
            )}
            <span className="text-[11px] text-slate-500">
              {c.exam_count} exam{c.exam_count === 1 ? "" : "s"}
              {filterNote ? ` in ${filterNote}` : ""}
            </span>
            {yearsChip && <MutedPill>{yearsChip}</MutedPill>}
            {c.has_figure && <MutedPill>has figure</MutedPill>}
            {c.topic_similarity != null && !smallCorpus && (
              <MutedPill>{Math.round(c.topic_similarity * 100)}% match</MutedPill>
            )}
          </div>
          {c.text_twin && (
            <p className="mt-1 text-[11px] text-slate-500">
              Count refers to a figure-based question — the figure may differ between papers.
            </p>
          )}
          {c.sources.length > 0 && (
            <details className="mt-2">
              <summary className="flex min-h-11 cursor-pointer select-none items-center text-xs font-medium text-slate-400 hover:text-indigo-400">
                Sources ({c.sources.length})
              </summary>
              <ul className="space-y-1">
                {c.sources.map((s) => (
                  <li key={s.url}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate rounded-lg bg-slate-800/60 px-2.5 py-2.5 text-xs text-indigo-300 underline-offset-2 hover:underline"
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

/* ---------- topic weightage / study guide ---------- */

/** Split a study plan into Day-N cards when the model wrote one. */
export function splitDayPlan(
  answer: string,
): { intro: string; days: { label: string; body: string }[] } | null {
  const lines = answer.split("\n");
  const dayStarts: number[] = [];
  const dayRe = /^\s*(?:[-*]\s*)?\**\s*Day\s+(\d+)\b/i;
  lines.forEach((l, i) => {
    if (dayRe.test(l)) dayStarts.push(i);
  });
  if (dayStarts.length < 2) return null;
  const intro = lines.slice(0, dayStarts[0]).join("\n").trim();
  const days = dayStarts.map((start, di) => {
    const end = di + 1 < dayStarts.length ? dayStarts[di + 1] : lines.length;
    const chunk = lines.slice(start, end).join("\n").trim();
    const label = `Day ${dayRe.exec(lines[start])?.[1] ?? di + 1}`;
    const body = chunk
      .replace(dayRe, "")
      .replace(/^\s*[:\-–—*]+\s*/, "")
      .replace(/^\*+\s*/, "")
      .trim();
    return { label, body };
  });
  return { intro, days };
}

function TopicAnswer({ res }: { res: AskResponse }) {
  const intent = res.intent as "TOPIC_WEIGHTAGE" | "STUDY_GUIDE";
  const topics = res.topics ?? [];
  const totalExams = res.total_exams ?? null;
  const dayPlan = intent === "STUDY_GUIDE" ? splitDayPlan(res.answer) : null;
  return (
    <div data-testid={intent === "STUDY_GUIDE" ? "study-guide-answer" : "topic-weightage-answer"}>
      <span className="mb-2 inline-block rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-xs font-semibold text-indigo-300">
        {intent === "STUDY_GUIDE" ? "Study plan" : "Topic weightage"}
      </span>
      <StatStrip
        totalExams={totalExams}
        topicCount={res.topic_count}
        topics={topics}
        smallCorpus={res.small_corpus === true}
      />
      {dayPlan ? (
        <div data-testid="day-plan">
          {dayPlan.intro && <Prose>{dayPlan.intro}</Prose>}
          <ol className="mt-2 space-y-2.5">
            {dayPlan.days.map((d) => (
              <li
                key={d.label}
                className="rounded-xl border border-slate-800 bg-slate-900 p-3.5 shadow-sm"
              >
                <span className="mb-1 inline-block rounded-full bg-indigo-600 px-2.5 py-0.5 text-xs font-bold text-white">
                  {d.label}
                </span>
                <Prose>{d.body}</Prose>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <Prose>{res.answer}</Prose>
      )}
      {topics.length > 0 &&
        (intent === "TOPIC_WEIGHTAGE" ? (
          <ol className="mt-3 space-y-3.5">
            {topics.map((t, i) => (
              <TopicItem
                key={t.topic}
                topic={t}
                rank={i + 1}
                totalExams={totalExams}
                smallCorpus={res.small_corpus === true}
              />
            ))}
          </ol>
        ) : (
          <details className="mt-3 border-t border-slate-800 pt-2">
            <summary className="flex min-h-11 cursor-pointer select-none items-center text-xs font-semibold text-slate-400 hover:text-indigo-400">
              The data behind this plan ({topics.length} topics)
            </summary>
            <ol className="mt-2 space-y-3">
              {topics.map((t, i) => (
                <TopicItem
                  key={t.topic}
                  topic={t}
                  rank={i + 1}
                  totalExams={totalExams}
                  smallCorpus={res.small_corpus === true}
                />
              ))}
            </ol>
          </details>
        ))}
    </div>
  );
}

function TopicItem({
  topic: t,
  rank,
  totalExams,
  smallCorpus = false,
}: {
  topic: TopicResult;
  rank: number;
  totalExams: number | null;
  smallCorpus?: boolean;
}) {
  const span =
    t.years.length === 0
      ? null
      : t.years.length === 1
        ? t.years[0]
        : `${t.years[0]}–${t.years[t.years.length - 1]}`;
  const tier = smallCorpus ? null : priorityTier(t.exam_count, totalExams);
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900 p-3.5 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 flex-1 text-sm font-semibold leading-snug">{t.topic}</p>
            <BigCount count={t.exam_count} total={totalExams} />
          </div>
          <CoverageBar count={t.exam_count} total={totalExams} />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {tier && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tier.classes}`}>
                {tier.label}
              </span>
            )}
            {span && <MutedPill>{span}</MutedPill>}
            {t.total_marks != null && <MutedPill>{t.total_marks} marks</MutedPill>}
          </div>
          {t.questions.length > 0 && (
            <details className="mt-1.5">
              <summary className="flex min-h-11 cursor-pointer select-none items-center text-xs font-medium text-slate-400 hover:text-indigo-400">
                Questions ({t.questions.length})
              </summary>
              <ul className="space-y-1">
                {t.questions.map((q) => (
                  <li
                    key={q.text.slice(0, 80)}
                    className="rounded-lg bg-slate-800/60 px-2.5 py-1.5 text-xs text-slate-300"
                  >
                    <ExpandableText text={q.text} />
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

/* ---------- year trend ---------- */

const STATUS_STYLES: Record<string, string> = {
  rising: "bg-indigo-500/15 text-indigo-300",
  staple: "bg-slate-800 text-slate-300",
  fading: "bg-slate-800/60 text-slate-500",
};

function YearTrendAnswer({
  answer,
  trend,
}: {
  answer: string;
  trend: { years: string[]; topics: TrendTopicResult[] } | null;
}) {
  return (
    <div data-testid="year-trend-answer">
      <span className="mb-2 mr-1.5 inline-block rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-xs font-semibold text-indigo-300">
        Year-wise trend
      </span>
      <MethodNote />
      <Prose>{answer}</Prose>
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
                  <td className="max-w-52 px-3 py-2">
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
                      className={`px-2 py-2 text-center tabular-nums ${n === 0 ? "text-slate-600" : "text-slate-200"}`}
                    >
                      {n === 0 ? "·" : n}
                    </td>
                  ))}
                  <td className="px-2 py-2 text-center text-sm font-extrabold tabular-nums text-slate-50">
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

/* ---------- semantic ---------- */

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
                  // muted superscript footnote chip — prose reads cleanly
                  <button
                    type="button"
                    onClick={() => jumpTo(ref)}
                    className="mx-px inline-flex -translate-y-1 items-center rounded px-0.5 align-super text-[10px] font-medium text-indigo-400/80 no-underline hover:text-indigo-300"
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
          <summary className="flex min-h-11 cursor-pointer select-none items-center text-xs font-semibold text-slate-400 hover:text-indigo-400">
            Sources — {citations.length} question{citations.length === 1 ? "" : "s"} from past
            papers
          </summary>
          <ul className="space-y-2">
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
                    <TopicChip topic={c.topic} />
                    <ExpandableText
                      text={c.question_text}
                      className="text-xs leading-snug text-slate-300"
                    />
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
                        className="inline-flex min-h-11 items-center font-medium text-indigo-400 underline-offset-2 hover:underline"
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
