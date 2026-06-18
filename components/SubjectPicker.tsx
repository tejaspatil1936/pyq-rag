"use client";

import { useMemo, useState } from "react";

import type { SubjectRow } from "@/lib/api-types";

export default function SubjectPicker({
  subjects,
  onSelect,
}: {
  subjects: SubjectRow[];
  onSelect: (subject: string) => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ranked = [...subjects].sort((a, b) => b.question_count - a.question_count);
    if (!q) return ranked;
    return ranked.filter((s) => s.subject.toLowerCase().includes(q));
  }, [subjects, query]);

  return (
    <div>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search your subject…"
        autoComplete="off"
        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
      />
      <p className="mt-2 px-1 text-xs text-slate-500">
        {filtered.length} of {subjects.length} subjects
      </p>
      <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {filtered.slice(0, 60).map((s) => (
          <li key={s.subject}>
            <button
              type="button"
              onClick={() => onSelect(s.subject)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-indigo-50 active:bg-indigo-100"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{s.subject}</span>
              <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs tabular-nums text-slate-600">
                {s.question_count.toLocaleString()} questions
              </span>
            </button>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-slate-500">
            No subject matches “{query}”.
          </li>
        )}
      </ul>
      {filtered.length > 60 && (
        <p className="mt-2 px-1 text-xs text-slate-400">
          Showing the 60 largest matches — keep typing to narrow down.
        </p>
      )}
    </div>
  );
}
