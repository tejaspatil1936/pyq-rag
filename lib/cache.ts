/**
 * In-memory response cache for /api/ask, keyed on (subject, normalized
 * question). The night before an exam everyone asks the same things —
 * identical questions must hit this, not Gemini.
 *
 * In-memory (not a Neon table) on purpose: a cache row is worthless without
 * a warm instance anyway (cold starts pay for the model, not Gemini), the
 * hot-path win needs zero DB round-trips, and Vercel keeps instances warm
 * exactly when traffic is hot. Per-instance scope is an accepted trade-off.
 * Only history-free requests are cached — multi-turn answers depend on
 * conversation state.
 */

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

const globalForCache = globalThis as unknown as {
  pyqAskCache?: Map<string, { body: Record<string, unknown>; expires: number }>;
};

function store() {
  globalForCache.pyqAskCache ??= new Map();
  return globalForCache.pyqAskCache;
}

export function cacheKey(subject: string, question: string): string {
  return `${subject}::${question.toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/g, "").trim()}`;
}

export function cacheGet(key: string): Record<string, unknown> | null {
  const entry = store().get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    store().delete(key);
    return null;
  }
  return entry.body;
}

export function cacheSet(key: string, body: Record<string, unknown>): void {
  const s = store();
  if (s.size >= MAX_ENTRIES) {
    // Maps iterate in insertion order — drop the oldest entry.
    const oldest = s.keys().next().value;
    if (oldest !== undefined) s.delete(oldest);
  }
  s.set(key, { body, expires: Date.now() + TTL_MS });
}
