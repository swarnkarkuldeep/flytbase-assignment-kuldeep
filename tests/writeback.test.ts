// End-to-end: notes are written back once each, through the same rate-limited queue, without starving polls,
// and a write that errors is never repeated blindly. Fake MCP serves the real snapshot. Zero real calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const GAP = 90;
const have = fs.existsSync("snapshot/get_my_accounts.json") && fs.existsSync("snapshot/file.flight_log_force_month.json");
const snap = (f: string) => JSON.parse(fs.readFileSync(path.join("snapshot", f), "utf8"));
const calls: { tool: string; args: any }[] = [];
const saved: { id: number; account: string; kind: string; title: string; text: string }[] = [];
let writes = 0;
let server: http.Server;
let sync: typeof import("../lib/sync.ts");
let store: any;

before(async () => {
  if (!have) return;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { params, id } = JSON.parse(body);
      const { name, arguments: args } = params;
      calls.push({ tool: name, args });
      const ok = (out: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } }));
      const fail = (msg: string) => res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: msg } }));
      res.setHeader("content-type", "application/json");
      switch (name) {
        case "whoami": return ok({ ...snap("whoami.json"), signals: 0 });
        case "get_data_format": return ok(snap("get_data_format.json"));
        case "get_my_accounts": return ok(snap("get_my_accounts.json"));
        case "get_all_paperwork": return ok(snap(`get_all_paperwork.${args.account}.json`));
        case "get_flytbase_team": return ok(snap("get_flytbase_team.json"));
        case "get_signals": return ok({ signals: [] });
        case "get_file": return ok(snap(`file.${args.id}.json`));
        case "list_notes": return ok({ notes: saved });
        case "write_note": {
          writes++;
          if (writes === 2) { saved.push({ id: saved.length + 1, ...args }); return fail("upstream timeout (but the note landed)"); }
          if (writes === 4) return fail("upstream error (nothing was saved)");
          saved.push({ id: saved.length + 1, ...args });
          return ok({ id: saved.length });
        }
        default: return ok({});
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.AQ_MCP_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.AQ_TOKEN = "test-token";
  process.env.AQ_MIN_GAP_MS = String(GAP);
  sync = await import("../lib/sync.ts");
  const { MemoryStore } = await import("../lib/store.ts");
  store = new MemoryStore();
});
after(() => server?.close());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t = have ? test : test.skip;

t("every wanted note is written exactly once, even when a write errors; polls are never starved", async () => {
  let guard = 0;
  let idleRounds = 0;
  while (guard++ < 120 && idleRounds < 6) {
    const before = calls.length;
    await sync.runSync(store);
    await wait(GAP + 15);
    // stop once the queue is quiet: only polls are being made and no write is outstanding
    const recent = calls.slice(-4).map((c) => c.tool);
    idleRounds = calls.length > before && recent.every((x) => x === "whoami" || x === "get_signals") ? idleRounds + 1 : 0;
  }

  // 12 wanted notes: 3 next steps + 3 risks for each of 2 accounts
  const refs = saved.map((n) => /\[crm:ref:([a-z0-9]+)\]/.exec(n.text)?.[1]);
  assert.equal(saved.length, 12, `expected 12 notes saved, got ${saved.length}`);
  assert.equal(new Set(refs).size, 12, "no duplicates, including the write that landed but returned an error");
  assert.equal(saved.filter((n) => n.kind === "next_step").length, 6);
  assert.equal(saved.filter((n) => n.kind === "risk").length, 6);
  assert.deepEqual([...new Set(saved.map((n) => n.account))].sort(), ["A", "B"]);

  // 12 landed + the one that failed before landing was redone once = 13 write calls; the one that landed was NOT repeated
  assert.equal(calls.filter((c) => c.tool === "write_note").length, 13);

  // the failed writes triggered a re-read of the notes before any retry
  const idx = calls.map((c) => c.tool);
  const firstFail = idx.indexOf("write_note", idx.indexOf("write_note") + 1); // 2nd write (landed, errored)
  assert.ok(idx.slice(firstFail + 1).includes("list_notes"), "list_notes ran after the errored write");

  // live events are not starved: after the first seven calls, never more than two non-poll calls in a row
  let run = 0, maxRun = 0;
  for (const c of calls.slice(7)) { run = c.tool === "whoami" || c.tool === "get_signals" ? 0 : run + 1; maxRun = Math.max(maxRun, run); }
  assert.ok(maxRun <= 2, `longest non-poll run was ${maxRun}`);
  assert.ok(calls.slice(7).filter((c) => c.tool === "whoami" || c.tool === "get_signals").length >= 5, "polling kept going while notes were written");

  // after everything is written the queue goes quiet: more rounds make no further writes
  const before = calls.filter((c) => c.tool === "write_note").length;
  for (let i = 0; i < 4; i++) { await sync.runSync(store); await wait(GAP + 15); }
  assert.equal(calls.filter((c) => c.tool === "write_note").length, before, "no duplicate writes once everything is out");
});

t("the token is never stored", async () => {
  assert.ok(![...store.data.values()].some((v: unknown) => JSON.stringify(v).includes("test-token")));
});
