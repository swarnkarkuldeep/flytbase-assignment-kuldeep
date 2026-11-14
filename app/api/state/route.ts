import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { getStatus } from "@/lib/sync";
import { getAnalysis } from "@/lib/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The computed CRM for both accounts. Reads Redis only; never calls the MCP.
export async function GET() {
  try {
    const store = await getStore();
    const [status, { analysis, bundle }] = await Promise.all([getStatus(store), getAnalysis(store)]);
    return NextResponse.json({
      status,
      analysis,
      held: {
        records: Object.fromEntries(Object.entries(bundle.paperwork).map(([k, v]) => [k, v.length])),
        files: Object.keys(bundle.files).length,
        signals: bundle.signals.length,
        signalsAt: bundle.signalsAt,
        // what the MCP says the dashboard has written back (shape of a note is read tolerantly)
        notes: (Array.isArray((bundle.notes as { notes?: unknown[] } | null)?.notes) ? (bundle.notes as { notes: Record<string, unknown>[] }).notes : []).map((n) => ({
          kind: typeof n.kind === "string" ? n.kind : null,
          account: typeof n.account === "string" ? n.account : null,
          title: typeof n.title === "string" ? n.title : String(n.text ?? "").slice(0, 90),
        })),
        dataAsOf: bundle.accounts?.data.exported_at ?? null,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "state failed" }, { status: 500 });
  }
}
