import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pendingJobs, nextJob, jobKey, dataKeyFor, jobsForSignal, jobsForWhoami, newSignals, normalizeSignals, MIN_GAP_MS,
} from "../lib/plan.ts";

const meta = () => ({ lastCallAt: null, calls: 0, alt: "get_signals" as const, fails: {}, log: [] });
const accounts: any = {
  accounts: [{ id: "A" }, { id: "B" }],
  files: [{ id: "f1" }, { id: "f2" }],
};
const state = (over: any = {}) => ({ have: new Set<string>(), accounts: null, queue: [], meta: meta(), now: 1_000_000, ...over });

test("initial order follows the brief", () => {
  const tools = pendingJobs(state({ accounts })).slice(0, 7).map((j) => j.tool + (j.args.account ?? ""));
  assert.deepEqual(tools, ["whoami", "get_data_format", "get_my_accounts", "get_all_paperworkA", "get_all_paperworkB", "get_flytbase_team", "get_signals"]);
});

test("files are fetched after the initial set, then polling alternates", () => {
  const have = new Set(["whoami", "format", "accounts", "paperwork:A", "paperwork:B", "team", "signals"]);
  const s = state({ accounts, have });
  assert.deepEqual(pendingJobs(s).slice(0, 3).map((j) => j.tool + (j.args.id ?? "")), ["get_filef1", "get_filef2", "list_notes"]);
  for (const k of ["file:f1", "file:f2", "notes"]) have.add(k);
  assert.equal(nextJob(s).tool, "get_signals");
  s.meta.alt = "whoami";
  assert.equal(nextJob(s).tool, "whoami");
});

test("explicit queue beats files but not the initial set", () => {
  const q = [{ tool: "get_paperwork_record", args: { account: "A", path: "x.txt" } }];
  const s = state({ accounts, queue: q, have: new Set(["whoami", "format", "accounts", "paperwork:A", "paperwork:B", "team", "signals"]) });
  assert.equal(nextJob(s).tool, "get_paperwork_record");
  assert.equal(nextJob(state({ accounts, queue: q })).tool, "whoami");
});

test("a job that failed 3 times is skipped during cooldown, then retried", () => {
  const j = { tool: "whoami", args: {} };
  const s = state({ meta: { ...meta(), fails: { [jobKey(j)]: { n: 3, at: 999_000 } } } });
  assert.notEqual(nextJob(s).tool, "whoami");
  assert.equal(nextJob({ ...s, now: 999_000 + 16 * 60_000 }).tool, "whoami");
});

test("data keys", () => {
  assert.equal(dataKeyFor({ tool: "get_all_paperwork", args: { account: "B" } }), "paperwork:B");
  assert.equal(dataKeyFor({ tool: "write_note", args: {} }), null);
  assert.ok(MIN_GAP_MS > 60_000);
});

test("signals: tolerant shape + diff by id or content", () => {
  assert.deepEqual(normalizeSignals({ signals: [] }), []);
  assert.deepEqual(normalizeSignals([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(normalizeSignals({ events: [{ a: 1 }] }), [{ a: 1 }]);
  const a = [{ id: "s1" }];
  assert.equal(newSignals(a, [...a, { id: "s2" }]).length, 1);
  assert.equal(newSignals([{ x: 1 }], [{ x: 1 }, { x: 2 }]).length, 1);
});

test("a signal that mentions a record or a file enqueues fetches for them", () => {
  const ctx = { accountIds: ["A", "B"], fileIds: ["roi_spreadsheet"], paths: { A: ["emails/2026-11-18_karen.txt", "tickets.json"], B: ["tickets.json"] } };
  const jobs = jobsForSignal({ account: "A", text: "see emails/2026-11-18_karen.txt and file roi_spreadsheet" }, ctx);
  assert.deepEqual(jobs.map((j) => j.tool + ":" + (j.args.id ?? j.args.path)).sort(), ["get_file:roi_spreadsheet", "get_paperwork_record:emails/2026-11-18_karen.txt"]);
  // no account on the signal: only accounts that hold the path
  const j2 = jobsForSignal({ text: "tickets.json" }, ctx);
  assert.equal(j2.length, 2);
  assert.equal(jobsForSignal({ text: "nothing relevant" }, ctx).length, 0);
});

test("a signal about docks flying queues a refresh of that account's usage data", () => {
  const ctx = { accountIds: ["A", "B"], fileIds: [], paths: { A: ["usage_weekly.csv"], B: ["usage_weekly.csv"] } };
  const jobs = jobsForSignal({ account: "B", text: "Three docks that flew most nights flew nothing for two weeks" }, ctx);
  assert.deepEqual(jobs.map((j) => `${j.args.account}:${j.args.path}`).sort(), ["B:device_events.csv", "B:flights.csv", "B:usage_weekly.csv"]);
  assert.equal(jobsForSignal({ account: "B", text: "a note about the invoice" }, ctx).length, 0);
  assert.equal(jobsForSignal({ text: "docks flew nothing" }, ctx).length, 0, "no account on the signal: do not guess which to refresh");
});

test("whoami: signal count mismatch and new accounts trigger fetches", () => {
  const none = jobsForWhoami({ signals: 0, pack: [{ account: "A", open: true }] }, 0, new Set(["paperwork:A"]));
  assert.equal(none.length, 0);
  const sig = jobsForWhoami({ signals: 2 }, 0, new Set());
  assert.equal(sig[0].tool, "get_signals");
  const fresh = jobsForWhoami({ signals: 0, new_accounts: ["C"], pack: [{ account: "C", open: true }] }, 0, new Set());
  // an account released later is read with get_new_account (get_my_accounts never lists it), plus its paperwork
  assert.deepEqual(fresh.map((j) => j.tool + ":" + JSON.stringify(j.args)), ['get_new_account:{"account":"C"}', 'get_all_paperwork:{"account":"C"}']);
  // once we hold its export and paperwork there is nothing left to fetch for it
  assert.equal(jobsForWhoami({ signals: 0, new_accounts: ["C"], pack: [{ account: "C", open: true }] }, 0, new Set(["drop:C", "paperwork:C"])).length, 0);
});
