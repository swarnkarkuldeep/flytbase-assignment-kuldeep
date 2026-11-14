// The rate-limited sync queue. Called by the browser every ~20s; makes at most one MCP call per 61s.
import type { Store } from "./store.ts";
import type { Envelope, Export, Job, LogEntry, Meta, Paperwork, Signal, Whoami } from "./types.ts";
import { callTool, RateLimitError } from "./mcp.ts";
import { getData, getIndex, getMeta, getQueue, loadExport, putData } from "./data.ts";
import {
  MIN_GAP_MS, altAfter, dataKeyFor, jobKey, jobsForSignal, jobsForWhoami,
  newSignals, nextJob, normalizeSignals, pendingJobs,
} from "./plan.ts";
import type { PlanState } from "./plan.ts";
import { planNotes, refOf } from "./notes.ts";
import type { Written } from "./notes.ts";
import { getAnalysis } from "./serve.ts";

const LOCK_KEY = "lock";
const LOCK_TTL_SEC = 90;

export interface Status {
  backend: "upstash" | "memory";
  now: number;
  lastCallAt: number | null;
  nextCallInSec: number;
  calls: number;
  pending: { tool: string; args: Record<string, unknown>; reason?: string }[];
  stored: Record<string, string>;
  lastError?: Meta["lastError"];
  log: LogEntry[];
  dry: boolean;
  /** "paused" when write-back is switched off (AQ_WRITE_NOTES=0, or the Redis flag flag:writeback = "off") */
  writeback?: "on" | "paused";
  busy?: boolean;
}

async function loadPlanState(store: Store, now: number): Promise<{ s: PlanState; index: Record<string, string> }> {
  const [meta, queue, index, base, whoami] = await Promise.all([
    getMeta(store), getQueue(store), getIndex(store), getData<Export>(store, "accounts"), getData<Whoami>(store, "whoami"),
  ]);
  const accounts = await loadExport(store, index);
  // accounts released after the morning: whoami lists them, but get_my_accounts never will
  const baseIds = new Set(base?.data.accounts.map((a) => a.id) ?? []);
  const named = (whoami?.data.new_accounts ?? []).map((n) => (typeof n === "string" ? n : (n as { id?: string; account?: string })?.id ?? (n as { account?: string })?.account));
  const packIds = (whoami?.data.pack ?? []).filter((p) => p.open).map((p) => p.account);
  const extra = base ? [...new Set([...named, ...packIds].filter((id): id is string => !!id && !baseIds.has(id)))] : [];
  const drops = Object.keys(index).filter((k) => k.startsWith("drop:")).map((k) => k.slice(5));
  return { s: { have: new Set(Object.keys(index)), accounts: accounts?.data ?? null, extra, drops, queue, meta, now }, index };
}

function statusOf(store: Store, s: PlanState, index: Record<string, string>, extra: Partial<Status> = {}): Status {
  const last = s.meta.lastCallAt;
  return {
    backend: store.kind,
    now: s.now,
    lastCallAt: last,
    nextCallInSec: last ? Math.max(0, Math.ceil((last + MIN_GAP_MS - s.now) / 1000)) : 0,
    calls: s.meta.calls,
    pending: pendingJobs(s).slice(0, 12),
    stored: index,
    lastError: s.meta.lastError,
    log: s.meta.log.slice(-12),
    dry: process.env.AQ_DRY === "1",
    ...extra,
  };
}

/** The kill switch for write-back: an env var, or a Redis flag that can be flipped without a redeploy. */
export async function writebackPaused(store: Store): Promise<boolean> {
  return process.env.AQ_WRITE_NOTES === "0" || (await store.get<string>("flag:writeback")) === "off";
}

export async function getStatus(store: Store): Promise<Status> {
  const { s, index } = await loadPlanState(store, Date.now());
  return statusOf(store, s, index, { writeback: (await writebackPaused(store)) ? "paused" : "on" });
}

export async function enqueue(store: Store, jobs: Job[], front = true) {
  if (!jobs.length) return;
  const queue = await getQueue(store);
  const have = new Set(queue.map(jobKey));
  const fresh = jobs.filter((j) => !have.has(jobKey(j)));
  await store.set("queue", front ? [...fresh, ...queue] : [...queue, ...fresh]);
}

async function removeFromQueue(store: Store, job: Job) {
  const k = jobKey(job);
  const queue = await getQueue(store);
  if (queue.some((j) => jobKey(j) === k)) await store.set("queue", queue.filter((j) => jobKey(j) !== k));
}

/** Store the result and decide what that result means for the queue. */
async function afterResult(store: Store, job: Job, data: unknown) {
  const key = dataKeyFor(job);
  const prior = key ? await getData<unknown>(store, key) : null;
  if (key) await putData(store, key, data);

  if (job.tool === "whoami") {
    const sig = await getData<unknown>(store, "signals");
    const held = sig ? normalizeSignals(sig.data).length : 0;
    const index = await getIndex(store);
    await enqueue(store, jobsForWhoami(data as Whoami, held, new Set(Object.keys(index))));
  }

  let changed = job.tool !== "whoami" && job.tool !== "get_signals";
  if (job.tool === "get_signals") {
    const fresh = newSignals(prior ? normalizeSignals(prior.data) : [], normalizeSignals(data));
    changed = fresh.length > 0;
    if (fresh.length) {
      const accounts = (await loadExport(store))?.data;
      const ids = accounts?.accounts.map((a) => a.id) ?? [];
      const paths: Record<string, string[]> = {};
      for (const id of ids) paths[id] = ((await getData<Paperwork>(store, `paperwork:${id}`))?.data.records ?? []).map((r) => r.path);
      const ctx = { accountIds: ids, fileIds: accounts?.files.map((f) => f.id) ?? [], paths };
      await enqueue(store, fresh.flatMap((sg: Signal) => jobsForSignal(sg, ctx)));
    }
  }

  await removeFromQueue(store, job);

  if (job.tool === "write_note") {
    await markWritten(store, job, "written");
    // once the batch is out, re-read the notes so what we hold matches what the MCP holds
    const left = (await getQueue(store)).some((j) => j.tool === "write_note");
    if (!left) await enqueue(store, [{ tool: "list_notes", args: {}, reason: "verify what was written back" }], false);
  } else if (changed || (await replanDue(store))) {
    await planWriteBacks(store);
  }
}

async function markWritten(store: Store, job: Job, status: "written" | "unknown") {
  const ref = refOf(job);
  if (!ref) return;
  const w = (await store.get<Written>("written")) ?? {};
  w[ref] = { status, at: new Date().toISOString() };
  await store.set("written", w);
}

/** After the analysis can change, queue write_note jobs for anything not already written back. */
async function planWriteBacks(store: Store) {
  if (await writebackPaused(store)) return; // not marked as planned, so it plans at once when switched back on
  const index = await getIndex(store);
  if (!index["notes"]) return; // wait until we know what is already there
  const { analysis } = await getAnalysis(store);
  const notes = await getData<unknown>(store, "notes");
  const written = (await store.get<Written>("written")) ?? {};
  // a note already waiting in the queue is not planned again, even if its wording has drifted since
  const queued = new Set((await getQueue(store)).map((j) => refOf(j)).filter((r): r is string => !!r));
  await enqueue(store, planNotes(analysis, notes?.data, notes?.at ?? null, written).filter((j) => !queued.has(refOf(j)!)), false);
  await store.set("plannedAt", Date.now());
}

/** Planning also runs on a timer, so a switch flipped back on (or time passing) is picked up without new data. */
const REPLAN_MS = Number(process.env.AQ_REPLAN_MS) || 5 * 60_000;
async function replanDue(store: Store): Promise<boolean> {
  return Date.now() - ((await store.get<number>("plannedAt")) ?? 0) > REPLAN_MS;
}

/**
 * Make the next queued call if >=61s have passed since the last one. Safe to call as often as you like:
 * a Redis lock stops two polls double-calling, and lastCallAt is stamped BEFORE the call so a crash
 * or a failed call still counts against the rate limit.
 */
export async function runSync(store: Store): Promise<{ status: Status; called: string | null }> {
  const now = Date.now();
  let { s, index } = await loadPlanState(store, now);
  const tooSoon = (m: Meta, t: number) => m.lastCallAt !== null && t - m.lastCallAt < MIN_GAP_MS;
  if (process.env.AQ_DRY === "1" || tooSoon(s.meta, now)) return { status: statusOf(store, s, index), called: null };

  const token = await store.lock(LOCK_KEY, LOCK_TTL_SEC);
  if (!token) return { status: statusOf(store, s, index, { busy: true }), called: null };

  try {
    const t = Date.now();
    if (await writebackPaused(store)) {
      // paused: drop any queued writes so none can go out
      const q = await getQueue(store);
      if (q.some((j) => j.tool === "write_note")) await store.set("queue", q.filter((j) => j.tool !== "write_note"));
    }
    ({ s, index } = await loadPlanState(store, t)); // re-read under the lock
    if (tooSoon(s.meta, t)) return { status: statusOf(store, s, index), called: null };

    const job = nextJob(s);
    const jk = jobKey(job);
    const meta = s.meta;
    meta.lastCallAt = t;
    meta.calls += 1;
    meta.sincePoll = job.tool === "get_signals" || job.tool === "whoami" ? 0 : (meta.sincePoll ?? 0) + 1;
    await store.set("meta", meta);

    const started = Date.now();
    const entry: LogEntry = { at: new Date(t).toISOString(), job: `${job.tool} ${JSON.stringify(job.args)}`, ok: true, ms: 0 };
    try {
      const data = await callTool(job.tool, job.args);
      await afterResult(store, job, data);
      delete meta.fails[jk];
      if (job.tool === "get_signals" || job.tool === "whoami") meta.alt = altAfter(job.tool);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      entry.ok = false;
      entry.note = message.slice(0, 200);
      meta.lastError = { at: entry.at, job: entry.job, message: entry.note };
      if (job.tool === "write_note" && !(e instanceof RateLimitError)) {
        // never retry a write blindly: it may have landed. Re-read the notes and decide from that.
        await markWritten(store, job, "unknown");
        await removeFromQueue(store, job);
        await enqueue(store, [{ tool: "list_notes", args: {}, reason: "a write failed: check whether it landed" }], true);
      } else if (/no such record|not found|unknown (file|record)/i.test(message)) {
        // it does not exist (yet): retrying cannot help, so park it for the cooldown instead of burning calls
        meta.fails[jk] = { n: 3, at: t };
        await removeFromQueue(store, job);
      } else if (!(e instanceof RateLimitError)) {
        const f = meta.fails[jk] ?? { n: 0, at: 0 };
        meta.fails[jk] = { n: f.n + 1, at: t };
        if (f.n + 1 >= 3) await removeFromQueue(store, job);
      }
    }
    entry.ms = Date.now() - started;
    meta.log = [...meta.log, entry].slice(-30);
    await store.set("meta", meta);

    ({ s, index } = await loadPlanState(store, Date.now()));
    return { status: statusOf(store, s, index), called: entry.job };
  } finally {
    await store.unlock(LOCK_KEY, token);
  }
}
