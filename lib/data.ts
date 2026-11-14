// Typed access to what the sync queue has stored. Reads Redis only, never the MCP.
import type { Store } from "./store.ts";
import type { Envelope, Export, Meta, Paperwork, Signal, TeamMember, Whoami, Job, PaperRecord } from "./types.ts";
import { normalizeSignals } from "./plan.ts";

export const emptyMeta = (): Meta => ({ lastCallAt: null, calls: 0, alt: "get_signals", fails: {}, log: [] });

/** key -> ISO time it was stored. Lets the status endpoint avoid reading big payloads. */
export type Index = Record<string, string>;

export async function getIndex(store: Store): Promise<Index> {
  return (await store.get<Index>("index")) ?? {};
}

export async function putData(store: Store, key: string, data: unknown, at = new Date().toISOString()) {
  await store.set(`data:${key}`, { at, data } satisfies Envelope);
  const idx = await getIndex(store);
  idx[key] = at;
  await store.set("index", idx);
}

export async function getData<T>(store: Store, key: string): Promise<Envelope<T> | null> {
  return store.get<Envelope<T>>(`data:${key}`);
}

export const getMeta = async (store: Store) => (await store.get<Meta>("meta")) ?? emptyMeta();
export const getQueue = async (store: Store) => (await store.get<Job[]>("queue")) ?? [];

export interface Bundle {
  whoami: Envelope<Whoami> | null;
  accounts: Envelope<Export> | null;
  team: TeamMember[];
  signals: Signal[];
  signalsAt: string | null;
  /** records per account, with records fetched individually (after a signal) overriding the bulk copy */
  paperwork: Record<string, PaperRecord[]>;
  files: Record<string, unknown>;
  notes: unknown;
  index: Index;
}

export async function loadBundle(store: Store): Promise<Bundle> {
  const index = await getIndex(store);
  const accounts = await getData<Export>(store, "accounts");
  const ids = accounts?.data.accounts.map((a) => a.id) ?? [];
  const paperwork: Record<string, PaperRecord[]> = {};
  for (const id of ids) {
    const pw = await getData<Paperwork>(store, `paperwork:${id}`);
    const byPath = new Map((pw?.data.records ?? []).map((r) => [r.path, r]));
    for (const k of Object.keys(index).filter((k) => k.startsWith(`record:${id}:`))) {
      const env = await getData<unknown>(store, k);
      const path = k.slice(`record:${id}:`.length);
      if (env) byPath.set(path, normalizeRecord(path, env.data, byPath.get(path)));
    }
    paperwork[id] = [...byPath.values()];
  }
  const files: Record<string, unknown> = {};
  for (const f of accounts?.data.files ?? []) {
    const env = await getData<unknown>(store, `file:${f.id}`);
    if (env) files[f.id] = env.data;
  }
  const sig = await getData<unknown>(store, "signals");
  return {
    whoami: await getData<Whoami>(store, "whoami"),
    accounts,
    team: (await getData<{ people: TeamMember[] }>(store, "team"))?.data.people ?? [],
    signals: sig ? normalizeSignals(sig.data) : [],
    signalsAt: sig?.at ?? null,
    paperwork,
    files,
    notes: (await getData<unknown>(store, "notes"))?.data ?? null,
    index,
  };
}

/** get_paperwork_record may return a bare record or already-wrapped {path,kind,...}. Keep the original kind. */
function normalizeRecord(path: string, data: unknown, prior?: PaperRecord): PaperRecord {
  if (data && typeof data === "object" && "path" in (data as object)) return data as PaperRecord;
  const kind = prior?.kind ?? "record";
  return typeof data === "string" ? { path, kind, text: data } : { path, kind, data };
}
