import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { getAnalysis } from "@/lib/serve";
import { resolveSource } from "@/lib/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Opens the raw record or file behind a source chip. Reads Redis only.
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id || id.length > 300) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { bundle } = await getAnalysis(await getStore());
  const r = resolveSource(bundle, id);
  if (!r) return NextResponse.json({ error: `no source with id "${id}"` }, { status: 404 });
  return NextResponse.json(r);
}
