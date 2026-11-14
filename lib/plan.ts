// Pure queue-planning logic: no I/O, so it can be unit-tested.
// The sync runner (lib/sync.ts) feeds it state and executes whatever job it returns.
import type { Export, Job, Meta, Signal, Whoami } from "./types.ts";

export const MIN_GAP_MS = Number(process.env.AQ_MIN_GAP_MS) || 61_000; // 1 call/min per token, plus margin
export const FAIL_COOLDOWN_MS = 15 * 60_000;
export const MAX_FAILS = 3;
export const MAX_BETWEEN_POLLS = 2;

function stable(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => `${k}:${stable(o[k])}`).join(",") + "}";
  }
  return JSON.stringify(v);
}
export const jobKey = (j: Job) => `${j.tool}:${stable(j.args)}`;

/** Where a job's result is stored. Null for jobs that store nothing (writes). */
export function dataKeyFor(j: Job): string | null {
  const a = j.args as Record<string, string>;
  switch (j.tool) {
    case "whoami": return "whoami";
    case "get_data_format": return "format";
    case "get_my_accounts": return "accounts";
    // an account released later: its own export (same shape as get_my_accounts) and its files
    case "get_new_account": return `drop:${a.account}`;
    case "get_new_account_file": return `file:${a.file_id}`;
    case "get_all_paperwork": return `paperwork:${a.account}`;
    case "get_flytbase_team": return "team";
    case "get_signals": return "signals";
    case "get_file": return `file:${a.id}`;
    case "get_paperwork_record": return `record:${a.account}:${a.path}`;
    case "list_notes": return "notes";
    default: return null;
  }
}

export interface PlanState {
  /** data keys already stored */
  have: Set<string>;
  accounts: Export | null;
  /** accounts released after the morning (whoami's pack and new_accounts), whose export comes from get_new_account */
  extra?: string[];
  /** the subset of those whose export we already hold; their files are fetched with get_new_account_file */
  drops?: string[];
  /** explicit, event-driven jobs (signal follow-ups, notes), in order */
  queue: Job[];
  meta: Meta;
  now: number;
}

const accountIds = (s: PlanState) => [...new Set([...(s.accounts?.accounts.map((a) => a.id) ?? ["A", "B"]), ...(s.extra ?? [])])];

/** Everything still to do, in the order it will be done. */
export function pendingJobs(s: PlanState): Job[] {
  const out: Job[] = [];
  const seen = new Set<string>();
  const add = (j: Job) => {
    const k = jobKey(j);
    if (seen.has(k)) return;
    const f = s.meta.fails[k];
    if (f && f.n >= MAX_FAILS && s.now - f.at < FAIL_COOLDOWN_MS) return; // cooling down
    seen.add(k);
    out.push(j);
  };
  const initial: Job[] = [
    { tool: "whoami", args: {}, reason: "initial" },
    { tool: "get_data_format", args: {}, reason: "initial" },
    { tool: "get_my_accounts", args: {}, reason: "initial" },
    // (an account released later is handled just below, export first)
    ...accountIds(s).filter((id) => !(s.extra ?? []).includes(id)).map((account): Job => ({ tool: "get_all_paperwork", args: { account }, reason: "initial" })),
    { tool: "get_flytbase_team", args: {}, reason: "initial" },
    { tool: "get_signals", args: {}, reason: "initial" },
  ];
  for (const j of initial) if (!s.have.has(dataKeyFor(j)!)) add(j);
  // a long queue (e.g. notes being written back) must not starve live events: after two non-poll calls, poll next
  if ((s.meta.sincePoll ?? 0) >= MAX_BETWEEN_POLLS && initial.every((j) => s.have.has(dataKeyFor(j)!))) {
    add({ tool: s.meta.alt, args: {}, reason: "poll" });
  }
  // an account released after the morning needs its own export and its paperwork before anything else
  for (const id of s.extra ?? []) {
    if (!s.have.has(`drop:${id}`)) add({ tool: "get_new_account", args: { account: id }, reason: "a new account was released" });
    if (!s.have.has(`paperwork:${id}`)) add({ tool: "get_all_paperwork", args: { account: id }, reason: "a new account was released" });
  }
  for (const j of s.queue) add(j);
  const dropSet = new Set(s.drops ?? []);
  for (const f of s.accounts?.files ?? []) {
    if (s.have.has(`file:${f.id}`)) continue;
    if (f.account && dropSet.has(f.account)) add({ tool: "get_new_account_file", args: { account: f.account, file_id: f.id }, reason: "file behind a deal or fact (new account)" });
    else add({ tool: "get_file", args: { id: f.id }, reason: "file behind a deal or fact" });
  }
  if (!s.have.has("notes")) add({ tool: "list_notes", args: {}, reason: "know what is already written back" });
  const other = s.meta.alt === "get_signals" ? "whoami" : "get_signals";
  add({ tool: s.meta.alt, args: {}, reason: "poll" });
  add({ tool: other, args: {}, reason: "poll" });
  return out;
}

export const nextJob = (s: PlanState): Job => pendingJobs(s)[0];

/** Opposite polling tool after one ran. */
export const altAfter = (tool: string): Meta["alt"] => (tool === "get_signals" ? "whoami" : "get_signals");

// ---------- reactions to what came back ----------

/** The array of signals inside whatever get_signals returned. Tolerant of shape. */
export function normalizeSignals(data: unknown): Signal[] {
  if (Array.isArray(data)) return data as Signal[];
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.signals)) return o.signals as Signal[];
    for (const v of Object.values(o)) if (Array.isArray(v)) return v as Signal[];
  }
  return [];
}

export function signalKey(s: Signal): string {
  const id = s.id ?? s.signal_id ?? s.event_id;
  return typeof id === "string" || typeof id === "number" ? `id:${id}` : `json:${stable(s)}`;
}

export function newSignals(prev: Signal[], next: Signal[]): Signal[] {
  const seen = new Set(prev.map(signalKey));
  return next.filter((s) => !seen.has(signalKey(s)));
}

export interface RefContext {
  accountIds: string[];
  fileIds: string[];
  /** known record paths per account */
  paths: Record<string, string[]>;
}

const PATH_RE = /\b(?:calls|emails|files)\/[\w.\-]+\.(?:txt|csv|json)\b|\b(?:profile|contract|deal_history|internal_notes|mail_log|users|devices|calls_index|tickets|invoices|requests|flights|usage_weekly|device_events)\.(?:json|csv|txt)\b/g;

/** Fetch jobs for any record or file a signal mentions. */
export function jobsForSignal(sig: Signal, ctx: RefContext): Job[] {
  // Records a signal carries inline ({records:[{path:"A/emails/x.txt", text}]}) are already in hand: merged into
  // the paperwork by lib/analysis/inline.ts, so there is nothing to fetch. Scan only the rest of the signal.
  const { records, set_off_at: _setOff, ...rest } = sig as Signal & { records?: unknown; set_off_at?: unknown };
  const inline = new Set<string>();
  for (const r of Array.isArray(records) ? records : []) {
    const p = String((r as { path?: unknown })?.path ?? "");
    inline.add(p);
    inline.add(p.replace(/^[A-Za-z0-9_-]+\//, ""));
  }
  const text = JSON.stringify(rest);
  const jobs: Job[] = [];
  const acctField = [sig.account, sig.account_id, sig.accountId].find((v): v is string => typeof v === "string" && ctx.accountIds.includes(v));

  const fileIds = new Set<string>();
  for (const id of ctx.fileIds) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\w-])${esc}(?![\\w-])`).test(text)) fileIds.add(id);
  }
  for (const [k, v] of Object.entries(sig)) if (/file/i.test(k) && typeof v === "string" && !v.includes("/")) fileIds.add(v);

  const paths = new Set<string>();
  for (const m of text.match(PATH_RE) ?? []) {
    const fm = /^files\/([\w\-]+)\./.exec(m);
    if (fm) fileIds.add(fm[1]);
    else paths.add(m);
  }
  for (const list of Object.values(ctx.paths)) for (const p of list) if (!p.startsWith("files/") && text.includes(p)) paths.add(p);

  // a signal about docks that stopped flying or went quiet means the usage data may have moved: refresh that
  // account's. (A dock that "fails on the day" is a support question, not a usage change.)
  const carriesUsage = ["usage_weekly.csv", "flights.csv", "device_events.csv"].some((p) => inline.has(p));
  if (!carriesUsage && acctField && /\bdocks?\b/i.test(text) && /\b(flew|flown|flying|idle|offline|no flights|not flown|stopped flying|nothing)\b/i.test(text)) {
    for (const p of ["usage_weekly.csv", "flights.csv", "device_events.csv"]) paths.add(p);
  }
  for (const p of inline) paths.delete(p);
  for (const id of fileIds) jobs.push({ tool: "get_file", args: { id }, reason: "mentioned by a new signal" });
  for (const path of paths) {
    const owners = acctField
      ? [acctField]
      : ctx.accountIds.filter((a) => (ctx.paths[a] ?? []).includes(path));
    for (const account of owners.length ? owners : ctx.accountIds) {
      jobs.push({ tool: "get_paperwork_record", args: { account, path }, reason: "mentioned by a new signal" });
    }
  }
  return jobs;
}

/** What whoami tells us to do next. */
export function jobsForWhoami(w: Whoami, storedSignalCount: number, haveKeys: Set<string>): Job[] {
  const jobs: Job[] = [];
  if (typeof w.signals === "number" && w.signals !== storedSignalCount) {
    jobs.push({ tool: "get_signals", args: {}, reason: `whoami reports ${w.signals} signals, we hold ${storedSignalCount}` });
  }
  const fresh = new Set<string>();
  for (const n of w.new_accounts ?? []) {
    const id = typeof n === "string" ? n : (n as { id?: string; account?: string })?.id ?? (n as { account?: string })?.account;
    if (id) fresh.add(id);
  }
  // only accounts whoami explicitly calls new. (An account in the pack that we hold no export for is found by
  // pendingJobs from the pack versus the export; at first run nothing is held yet, so the pack alone proves nothing.)
  for (const account of fresh) {
    if (!haveKeys.has(`drop:${account}`)) jobs.push({ tool: "get_new_account", args: { account }, reason: "whoami reports a new account" });
    if (!haveKeys.has(`paperwork:${account}`)) jobs.push({ tool: "get_all_paperwork", args: { account }, reason: "whoami reports a new account" });
  }
  return jobs;
}
