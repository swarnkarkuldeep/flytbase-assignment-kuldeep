import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { runSync } from "@/lib/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The browser polls this every ~20s. It makes at most one MCP call per 61s, and returns status only.
export async function GET() {
  try {
    const { status, called } = await runSync(await getStore());
    return NextResponse.json({ ok: true, called, status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "sync failed" }, { status: 500 });
  }
}
export const POST = GET;
