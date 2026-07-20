import { NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { GEMINI_MODEL } from "@/lib/gemini";
import { keyAvailability } from "@/lib/key-rotator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness for uptime monitors: DB reachability + key configuration. */
export async function GET() {
  const t0 = Date.now();
  let db: { ok: boolean; latency_ms: number | null } = { ok: false, latency_ms: null };
  try {
    await getPool().query("SELECT 1");
    db = { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    console.error("health: DB check failed:", err);
  }

  const { total, available, benched } = keyAvailability();

  const body = {
    ok: db.ok && total > 0,
    db,
    gemini: {
      configured: total > 0,
      keys: total,
      available,
      benched,
      model: GEMINI_MODEL,
    },
  };
  return NextResponse.json(body, { status: body.ok ? 200 : 503 });
}
