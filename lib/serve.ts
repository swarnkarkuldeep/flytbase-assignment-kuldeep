// Shared by the read-only API routes: load what is stored, analyse it, and cache briefly so that
// many viewers polling every 20s do not each re-read the paperwork from Redis. Never calls the MCP.
import type { Store } from "./store.ts";
import { getIndex, loadBundle } from "./data.ts";
import type { Bundle } from "./data.ts";
import { analyse } from "./analysis/index.ts";
import type { Analysis } from "./analysis/index.ts";

interface Cached { key: string; at: number; bundle: Bundle; analysis: Analysis }
const g = globalThis as unknown as { __aqServe?: Cached };
const TTL_MS = 30_000;

export async function getAnalysis(store: Store): Promise<{ bundle: Bundle; analysis: Analysis; cached: boolean }> {
  const index = await getIndex(store);
  const key = JSON.stringify(index);
  const c = g.__aqServe;
  if (c && c.key === key && Date.now() - c.at < TTL_MS) return { bundle: c.bundle, analysis: c.analysis, cached: true };
  const bundle = await loadBundle(store);
  const analysis = analyse(bundle, new Date());
  g.__aqServe = { key, at: Date.now(), bundle, analysis };
  return { bundle, analysis, cached: false };
}
