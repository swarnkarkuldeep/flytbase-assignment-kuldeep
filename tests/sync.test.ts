// End-to-end test of the sync queue against a fake MCP server (serves the real snapshot data).
// Burns zero real calls. Env must be set before the modules are imported.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const GAP = 120;
const snap = (f: string) => JSON.parse(fs.readFileSync(path.join("snapshot", f), "utf8"));
const calls: { tool: string; args: any; t: number }[] = [];
let signals: any[] = [];
let server: http.Server;
let sync: typeof import("../lib/sync.ts");
let data: typeof import("../lib/data.ts");
let store: any;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { params, id } = JSON.parse(body);
      const { name, arguments: args } = params;
      assert.match(String(req.headers.authorization), /^Bearer test-token$/);
      calls.push({ tool: name, args, t: Date.now() });
      let out: unknown;
      switch (name) {
        case "whoami": out = { ...snap("whoami.json"), signals: signals.length }; break;
        case "get_data_format": out = snap("get_data_format.json"); break;
        case "get_my_accounts": out = snap("get_my_accounts.json"); break;
        case "get_all_paperwork": out = snap(`get_all_paperwork.${args.account}.json`); break;
        case "get_flytbase_team": out = snap("get_flytbase_team.json"); break;
        case "get_signals": out = { signals }; break;
        case "get_file": out = { id: args.id, csv: "a,b\n1,2" }; break;
        case "get_paperwork_record": out = { path: args.path, kind: "email", text: "FRESH " + args.path }; break;
        case "list_notes": out = { notes: [] }; break;
        default: out = {};
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  process.env.AQ_MCP_URL = `http://127.0.0.1:${port}`;
  process.env.AQ_TOKEN = "test-token";
  process.env.AQ_WRITE_NOTES = "0"; // write-back has its own test (writeback.test.ts)
  process.env.AQ_MIN_GAP_MS = String(GAP);
  sync = await import("../lib/sync.ts");
  data = await import("../lib/data.ts");
  const { MemoryStore } = await import("../lib/store.ts");
  store = new MemoryStore();
});
after(() => server.close());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function step() {
  const r = await sync.runSync(store);
  await wait(GAP + 15);
  return r;
}

test("rate limit: a second poll inside the gap makes no call; concurrent polls make one", async () => {
  const [a, b, c, d, e] = await Promise.all([1, 2, 3, 4, 5].map(() => sync.runSync(store)));
  const made = [a, b, c, d, e].filter((r) => r.called).length;
  assert.equal(made, 1, "lock + gap allow exactly one call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "whoami");
  const again = await sync.runSync(store);
  assert.equal(again.called, null);
  assert.ok(again.status.nextCallInSec >= 0);
  await wait(GAP + 15);
});

test("initial fetches run in the brief's order, then files and notes interleaved with polls, then alternate polling", async () => {
  while (calls.length < 7 + 6 + 1 + 5) await step();
  const seq = calls.map((c) => c.tool + (c.args.account ?? c.args.id ?? ""));
  assert.deepEqual(seq.slice(0, 7), ["whoami", "get_data_format", "get_my_accounts", "get_all_paperworkA", "get_all_paperworkB", "get_flytbase_team", "get_signals"]);
  // after the initial seven: all six files and list_notes get fetched, each once, with polls jumping in
  const rest = seq.slice(7);
  const fileIds = ["dataflow_pack", "flight_log_force_month", "helicopter_cost_overtime", "insurer_premium_letter", "roi_spreadsheet", "support_ticket_history"];
  for (const f of fileIds) assert.equal(rest.filter((x) => x === "get_file" + f).length, 1, `${f} fetched once`);
  assert.equal(rest.filter((x) => x === "list_notes").length, 1);
  // polls alternate whoami / get_signals, starting with whoami (the initial get_signals was the last poll)
  const polls = rest.filter((x) => x === "whoami" || x === "get_signals");
  polls.forEach((p, i) => assert.equal(p, i % 2 === 0 ? "whoami" : "get_signals"));
  // live events are never starved: no run of more than two non-poll calls
  let run = 0;
  for (const x of rest) { run = x === "whoami" || x === "get_signals" ? 0 : run + 1; assert.ok(run <= 2, "a poll follows within two calls"); }
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].t - calls[i - 1].t >= GAP - 5, `calls ${i - 1}->${i} spaced`);
});

test("a new signal is picked up without a code change and triggers a fetch of the record it mentions", async () => {
  signals = [{ id: "sig-1", account: "A", at: "2026-11-18", text: "Karen logged a ticket, see emails/2026-11-18_karen_event.txt" }];
  const before = calls.length;
  let guard = 0;
  while (!calls.slice(before).some((c) => c.tool === "get_paperwork_record") && guard++ < 8) await step();
  const after = calls.slice(before).map((c) => c.tool);
  assert.ok(after.includes("get_signals"), "signals re-fetched after whoami noticed the count change");
  const rec = calls.slice(before).find((c) => c.tool === "get_paperwork_record");
  assert.deepEqual(rec?.args, { account: "A", path: "emails/2026-11-18_karen_event.txt" });
  const b = await data.loadBundle(store);
  assert.equal(b.signals.length, 1);
  assert.ok(b.paperwork.A.some((r: any) => r.path === "emails/2026-11-18_karen_event.txt" && r.text?.startsWith("FRESH")));
  assert.equal(b.paperwork.A.length, 36, "new record merged into the 35 on file");
});

test("the token never appears in stored data or status", async () => {
  const status = await sync.getStatus(store);
  assert.ok(!JSON.stringify(status).includes("test-token"));
  assert.ok(![...store.data.values()].some((v: unknown) => JSON.stringify(v).includes("test-token")));
});
