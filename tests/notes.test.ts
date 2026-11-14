import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bundleFromSnapshot } from "../lib/analysis/snapshot.ts";
import { analyse } from "../lib/analysis/index.ts";
import { planNotes, noteRef, refOf, topRisks } from "../lib/notes.ts";
import { pendingJobs } from "../lib/plan.ts";

const have = fs.existsSync("snapshot/get_my_accounts.json") && fs.existsSync("snapshot/file.flight_log_force_month.json");
const t = have ? test : test.skip;
const analysis = () => analyse(bundleFromSnapshot(), new Date("2026-11-14T10:00:00Z"));

test("refs are stable and distinct", () => {
  assert.equal(noteRef("A", "next_step", "move:x"), noteRef("A", "next_step", "move:x"));
  assert.notEqual(noteRef("A", "next_step", "move:x"), noteRef("B", "next_step", "move:x"));
  assert.notEqual(noteRef("A", "next_step", "move:x"), noteRef("A", "risk", "move:x"));
});

t("plans three next steps and three risks per account, each tagged, within size, citing sources", () => {
  const jobs = planNotes(analysis(), { notes: [] }, "2026-11-14T09:00:00Z", {});
  assert.equal(jobs.length, 12);
  for (const account of ["A", "B"]) {
    const mine = jobs.filter((j) => j.args.account === account);
    assert.equal(mine.filter((j) => j.args.kind === "next_step").length, 3);
    assert.equal(mine.filter((j) => j.args.kind === "risk").length, 3);
  }
  const refs = new Set<string>();
  for (const j of jobs) {
    assert.equal(j.tool, "write_note");
    const text = String(j.args.text);
    assert.ok(text.length <= 1500, `note too long: ${text.length}`);
    assert.ok(String(j.args.title).length <= 120);
    const ref = refOf(j)!;
    assert.ok(ref && text.includes(`[crm:ref:${ref}]`));
    refs.add(ref);
    assert.match(text, /Sources: /);
  }
  assert.equal(refs.size, 12, "no two notes share a ref");
  const step1 = jobs.find((j) => j.args.account === "A" && /Next step 1:/.test(String(j.args.title)))!;
  assert.match(String(step1.args.text), /Owner: You \(CSM\)/);
  assert.match(String(step1.args.text), /Due: 2026-11-17/);
});

t("duplicates: anything already in list_notes, or already written, is skipped", () => {
  const a = analysis();
  const all = planNotes(a, { notes: [] }, null, {});
  const first = all[0], second = all[1], third = all[2];
  // visible in list_notes (any shape): skipped
  const notes = { notes: [{ id: 1, text: String(first.args.text) }] };
  assert.equal(planNotes(a, notes, "x", {}).length, 11);
  assert.equal(planNotes(a, JSON.stringify(notes), "x", {}).length, 11, "even if the shape is odd");
  // recorded as written: skipped
  assert.equal(planNotes(a, { notes: [] }, "x", { [refOf(second)!]: { status: "written", at: "2026-11-14T09:30:00Z" } }).length, 11);
  // a write that errored ("unknown") is NOT repeated until a later list_notes shows it missing
  const unknown = { [refOf(third)!]: { status: "unknown" as const, at: "2026-11-14T09:30:00Z" } };
  assert.equal(planNotes(a, { notes: [] }, "2026-11-14T09:00:00Z", unknown).length, 11, "list_notes older than the failure: wait");
  assert.equal(planNotes(a, { notes: [] }, "2026-11-14T09:45:00Z", unknown).length, 12, "newer list_notes still lacks it: redo");
  assert.equal(planNotes(a, { notes: [{ text: String(third.args.text) }] }, "2026-11-14T09:45:00Z", unknown).length, 11, "it had landed: skip");
});

t("risks written back are the highest severity, overdue first on ties", () => {
  const a = analysis().accounts[1];
  const top = topRisks(a);
  assert.equal(top.length, 3);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].severity >= top[i].severity);
});

test("nothing is planned until the analysis is ready", () => {
  const empty = analyse({ whoami: null, accounts: null, team: [], signals: [], signalsAt: null, paperwork: {}, files: {}, notes: null, index: {} });
  assert.deepEqual(planNotes(empty, { notes: [] }, null, {}), []);
});

test("polls are not starved: after two non-poll calls, a poll jumps ahead of queued writes", () => {
  const have = new Set(["whoami", "format", "accounts", "paperwork:A", "paperwork:B", "team", "signals", "notes"]);
  const queue = [{ tool: "write_note", args: { text: "a [crm:ref:x]" } }, { tool: "write_note", args: { text: "b [crm:ref:y]" } }];
  const base = { have, accounts: null, queue, now: 1_000_000 };
  const meta = (sincePoll: number) => ({ lastCallAt: null, calls: 0, alt: "whoami" as const, fails: {}, log: [], sincePoll });
  assert.equal(pendingJobs({ ...base, meta: meta(1) })[0].tool, "write_note");
  assert.equal(pendingJobs({ ...base, meta: meta(2) })[0].tool, "whoami");
});
