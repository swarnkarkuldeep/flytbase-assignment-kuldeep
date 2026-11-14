// A third account is released mid-build (K, Kestrel Estates). whoami lists it and get_my_accounts never will:
// its export comes from get_new_account and its files from get_new_account_file. Nothing may block on it.
import "./_env.ts"; // first: sets the call gap before lib/plan.ts is loaded
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pendingJobs, dataKeyFor } from "../lib/plan.ts";
import { bundleFromSnapshot } from "../lib/analysis/snapshot.ts";
import { analyse } from "../lib/analysis/index.ts";
import { resolveSource } from "../lib/sources.ts";

const haveK = fs.existsSync("snapshot/get_new_account.K.json") && fs.existsSync("snapshot/get_all_paperwork.K.json") && fs.existsSync("snapshot/file.flight_log_force_month.json");
const t = haveK ? test : test.skip;
const NOW = new Date("2026-11-14T10:00:00Z");
const meta = () => ({ lastCallAt: null, calls: 0, alt: "get_signals" as const, fails: {}, log: [] });
const INITIAL = ["whoami", "format", "accounts", "paperwork:A", "paperwork:B", "team", "signals"];

test("planner: an account released later is fetched first, ahead of files and notes", () => {
  const accounts: any = { accounts: [{ id: "A" }, { id: "B" }], files: [{ id: "f1", account: "A" }] };
  const s = { have: new Set(INITIAL), accounts, extra: ["K"], drops: [], queue: [], meta: meta(), now: 1_000_000 };
  const jobs = pendingJobs(s).slice(0, 3).map((j) => j.tool + ":" + JSON.stringify(j.args));
  assert.deepEqual(jobs, ['get_new_account:{"account":"K"}', 'get_all_paperwork:{"account":"K"}', 'get_file:{"id":"f1"}']);
});

test("planner: files of a released account use get_new_account_file, others use get_file", () => {
  const accounts: any = { accounts: [{ id: "A" }, { id: "K" }], files: [{ id: "A_file", account: "A" }, { id: "K_note", account: "K" }] };
  const have = new Set([...INITIAL, "drop:K", "paperwork:K"]);
  const s = { have, accounts, extra: ["K"], drops: ["K"], queue: [], meta: meta(), now: 1_000_000 };
  const jobs = pendingJobs(s).slice(0, 2).map((j) => j.tool + ":" + JSON.stringify(j.args));
  assert.deepEqual(jobs, ['get_file:{"id":"A_file"}', 'get_new_account_file:{"account":"K","file_id":"K_note"}']);
  assert.equal(dataKeyFor({ tool: "get_new_account", args: { account: "K" } }), "drop:K");
  assert.equal(dataKeyFor({ tool: "get_new_account_file", args: { account: "K", file_id: "K_note" } }), "file:K_note");
});

t("K is analysed: its dated deadlines, the promise to Dana, and the blocker before the board vote", () => {
  const a = analyse(bundleFromSnapshot(), NOW);
  const K = a.accounts.find((x) => x.id === "K")!;
  assert.ok(K, "K is analysed");
  assert.equal(K.currency, "GBP");
  assert.equal(K.clock.shifted, false);
  // the export's game-clock minutes become real dates, with the rule shown
  const risks = K.q4.filter((r) => r.kind === "deadline" && r.id.startsWith("risk:dated:"));
  assert.deepEqual(risks.map((r) => r.turnsBadOn!.date).sort(), ["2026-11-16", "2026-11-17"]);
  assert.ok(risks.every((r) => r.turnsBadOn!.derived && /minute \d+ on the game clock/.test(r.turnsBadOn!.how!)));
  // #1: Dana's unanswered email, with the promised go-live plan folded in and every open deal she speaks for linked
  const m1 = K.q3.top[0];
  assert.match(m1.title, /Reply to Dana Whitfield/);
  assert.ok(m1.insideDeadlines.some((d) => d.date === "2026-11-16" && /Go-live plan promised to Dana/.test(d.label)));
  assert.ok(m1.dealIds.includes("k_golive_rti") && m1.dealIds.includes("k_south_rti"));
  assert.ok(m1.weOwe && m1.score.promise >= 1.5);
  // #2: the blocker (no pilot, never commissioned, insurer not told) before the board vote on 17 Nov
  const m2 = K.q3.top[1];
  assert.match(m2.title, /Clear the blocker/);
  assert.match(m2.title, /insurer has not been told/);
  assert.ok(m2.insideDeadlines.some((d) => d.date === "2026-11-17"));
  assert.ok(m2.sources.includes("k_insurer_not_told_rti"));
  // due dates sit inside the deadlines
  for (const m of K.q3.top) for (const d of m.insideDeadlines) assert.ok(m.due <= d.date, `${m.id} due ${m.due} is inside ${d.date}`);
});

t("K's email with 'No further reply on file' is found as unanswered, and its request row merged", () => {
  const a = analyse(bundleFromSnapshot(), NOW);
  const K = a.accounts.find((x) => x.id === "K")!;
  const risk = K.q4.find((r) => /No reply: Our dock/.test(r.title))!;
  assert.ok(risk && risk.overdue);
  assert.ok(risk.sources.includes("K:emails/2026-10-19_dana_when.txt") && risk.sources.some((s) => s.startsWith("K:requests.csv")));
});

t("K cites only records that exist (it has no flight log)", () => {
  const b = bundleFromSnapshot();
  const a = analyse(b, NOW);
  const K = a.accounts.find((x) => x.id === "K")!;
  assert.ok(K.fleet && !K.fleet.sources.includes("K:flights.csv") && K.fleet.sources.includes("K:usage_weekly.csv"));
  const bad: string[] = [];
  const walk = (o: unknown, p: string) => {
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
      if (k === "raw") continue;
      if (k === "sources" && Array.isArray(v)) for (const id of v as string[]) { if (!resolveSource(b, id)) bad.push(`${p}: ${id}`); }
      else walk(v, `${p}.${k}`);
    }
  };
  walk(K, "K");
  assert.deepEqual(bad, [], "every id K cites resolves");
});

t("a released account that has not arrived yet does not block the page: A and B are analysed, K is listed as pending", () => {
  const b = bundleFromSnapshot();
  b.accounts = { at: "x", data: { ...b.accounts!.data, accounts: b.accounts!.data.accounts.filter((x) => x.id !== "K") } };
  delete b.paperwork.K;
  b.whoami = { at: "x", data: { pack: [{ account: "A", open: true }, { account: "B", open: true }, { account: "K", open: true }], new_accounts: [{ id: "K", name: "Kestrel Estates" }] } as any };
  const a = analyse(b, NOW);
  assert.equal(a.ready, true);
  assert.deepEqual(a.accounts.map((x) => x.id), ["A", "B"]);
  assert.deepEqual(a.pending.map((p) => [p.id, p.name]), [["K", "Kestrel Estates"]]);
  assert.deepEqual(a.pending[0].waitingFor, ["get_new_account K", "get_all_paperwork K"]);
});

// ---------------------------------------------------------------- end to end through the sync queue
const GAP = 80;
const snap = (f: string) => JSON.parse(fs.readFileSync(path.join("snapshot", f), "utf8"));
const calls: { tool: string; args: any }[] = [];
let server: http.Server;
let sync: typeof import("../lib/sync.ts");
let data: typeof import("../lib/data.ts");
let store: any;

before(async () => {
  if (!haveK) return;
  const kExport = snap("get_new_account.K.json");
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { params, id } = JSON.parse(body);
      const { name, arguments: args } = params;
      calls.push({ tool: name, args });
      res.setHeader("content-type", "application/json");
      let out: unknown = {};
      switch (name) {
        case "whoami": out = { ...snap("whoami.json"), signals: 0, new_accounts: [{ id: "K", name: "Kestrel Estates", path: "/drops/K" }], pack: [{ account: "A", open: true }, { account: "B", open: true }, { account: "K", open: true }] }; break;
        case "get_data_format": out = snap("get_data_format.json"); break;
        case "get_my_accounts": out = snap("get_my_accounts.json"); break; // A and B only, as the real one does
        case "get_new_account": out = args.account === "K" ? kExport : {}; break;
        case "get_new_account_file": out = { id: args.file_id, name: `${args.file_id}.txt`, text: `FILE ${args.file_id} of ${args.account}` }; break;
        case "get_all_paperwork": out = args.account === "K" ? snap("get_all_paperwork.K.json") : snap(`get_all_paperwork.${args.account}.json`); break;
        case "get_flytbase_team": out = snap("get_flytbase_team.json"); break;
        case "get_signals": out = { signals: [] }; break;
        case "get_file": out = snap(`file.${args.id}.json`); break;
        case "list_notes": out = { notes: [] }; break;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.AQ_MCP_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.AQ_TOKEN = "test-token";
  process.env.AQ_MIN_GAP_MS = String(GAP);
  process.env.AQ_WRITE_NOTES = "0";
  sync = await import("../lib/sync.ts");
  data = await import("../lib/data.ts");
  const { MemoryStore } = await import("../lib/store.ts");
  store = new MemoryStore();
});
after(() => server?.close());

t("end to end: the queue picks up the new account, its export, its paperwork and its files, with no code change", async () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let guard = 0;
  while (guard++ < 40) {
    await sync.runSync(store);
    await wait(GAP + 15);
    const idx = await data.getIndex(store);
    if (idx["drop:K"] && idx["paperwork:K"] && idx["file:K_install_note_rti"] && idx["file:K_insurance_schedule_rti"]) break;
  }
  const seq = calls.map((c) => c.tool + (c.args.account ? ":" + c.args.account : ""));
  assert.ok(seq.includes("get_new_account:K"), "asked for K export with get_new_account; calls were: " + seq.join(", "));
  assert.equal(seq.filter((x) => x === "get_new_account:K").length, 1, "once");
  assert.equal(seq.filter((x) => x === "get_all_paperwork:K").length, 1);
  const fileCalls = calls.filter((c) => c.tool === "get_new_account_file").map((c) => c.args.file_id).sort();
  assert.deepEqual(fileCalls, ["K_install_note_rti", "K_insurance_schedule_rti"], "K's files are read with get_new_account_file, not get_file");
  assert.ok(!calls.some((c) => c.tool === "get_file" && /^K_/.test(String(c.args.id))));
  // the bundle merges K into the export, and the analysis includes it
  const b = await data.loadBundle(store);
  assert.deepEqual(b.accounts!.data.accounts.map((x) => x.id), ["A", "B", "K"]);
  assert.equal(b.paperwork.K.length, 11);
  assert.match(String(b.files["K_install_note_rti"] && (b.files["K_install_note_rti"] as any).text), /FILE K_install_note_rti of K/);
  const a = analyse(b, NOW);
  assert.deepEqual(a.accounts.map((x) => x.id), ["A", "B", "K"]);
  assert.deepEqual(a.pending, []);
  assert.ok(![...store.data.values()].some((v: unknown) => JSON.stringify(v).includes("test-token")));
});
