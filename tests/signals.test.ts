// The two real live events (tests/fixtures/signals.json), exactly as the MCP returned them:
// { id, account, dated, title, summary, records:[{path:"A/emails/…", text}], set_off_at }
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bundleFromSnapshot } from "../lib/analysis/snapshot.ts";
import { analyse } from "../lib/analysis/index.ts";
import { overlaySignalRecords } from "../lib/analysis/inline.ts";
import { resolveSource } from "../lib/sources.ts";
import { jobsForSignal } from "../lib/plan.ts";
import { planNotes } from "../lib/notes.ts";
import { findMonthInText, parseCsv } from "../lib/analysis/util.ts";

const signals = JSON.parse(fs.readFileSync("tests/fixtures/signals.json", "utf8"));
const have = fs.existsSync("snapshot/get_my_accounts.json") && fs.existsSync("snapshot/file.flight_log_force_month.json");
const t = have ? test : test.skip;
const REAL_NOW = new Date("2026-11-14T10:00:00Z");
const run = () => { const b = bundleFromSnapshot(); b.signals = signals; return { b, a: analyse(b, REAL_NOW) }; };

test("records carried inline are not fetched, and a dock that 'fails on the day' is not a usage change", () => {
  const ctx = { accountIds: ["A", "B"], fileIds: [], paths: { A: ["usage_weekly.csv", "requests.csv"], B: [] } };
  for (const s of signals) assert.deepEqual(jobsForSignal(s, ctx), [], `no calls needed for ${s.id}`);
});

test("'in January' becomes the 1st of the next January, labelled derived by the callers", () => {
  assert.equal(findMonthInText("he leaves the drone programme in January.", new Date("2026-11-17T00:00:00Z"))!.toISOString().slice(0, 10), "2027-01-01");
  assert.equal(findMonthInText("no month here", new Date()), null);
});

t("inline records join the paperwork once: the emails, and the new request row appended to requests.csv", () => {
  const b = bundleFromSnapshot();
  const once = overlaySignalRecords(b.paperwork, signals);
  const twice = overlaySignalRecords(once, signals);
  const paths = once.A.map((r) => r.path);
  assert.ok(paths.includes("emails/2026-11-17_rhys_moving.txt") && paths.includes("emails/2026-11-18_karen_event.txt"));
  const req = once.A.find((r) => r.path === "requests.csv")!.text!;
  assert.equal((req.match(/FB-11206/g) ?? []).length, 1);
  assert.ok(req.includes("FB-10412"), "existing rows are kept");
  assert.equal(twice.A.find((r) => r.path === "requests.csv")!.text, req, "applying it again changes nothing");
  assert.equal(twice.A.length, once.A.length);
  assert.equal(once.B.length, b.paperwork.B.length, "B gets no new record, only new usage rows");
  assert.equal(once.B.find((r) => r.path === "requests.csv")!.text, b.paperwork.B.find((r) => r.path === "requests.csv")!.text);
});

t("new weekly usage rows are appended by whole row (every dock shares a week), once", () => {
  const b = bundleFromSnapshot();
  const rows = (pw: typeof b.paperwork) => parseCsv(pw.B.find((r) => r.path === "usage_weekly.csv")!.text!);
  const before = rows(b.paperwork).length;
  const once = overlaySignalRecords(b.paperwork, signals);
  const twice = overlaySignalRecords(once, signals);
  assert.equal(rows(once).length, before + 56, "14 docks x 4 new weeks");
  assert.equal(rows(twice).length, rows(once).length, "applying it again adds nothing");
  assert.ok(rows(once).some((r) => r.week_start === "2026-11-23" && r.dock_id === "AD-02" && r.flights === "0"));
  assert.ok(rows(once).some((r) => r.week_start === "2026-10-26" && r.dock_id === "AD-02"), "the old rows are kept");
});

t("each account has its own 'today': the later of the real clock and its latest live event", () => {
  const { a } = run();
  const A = a.accounts.find((x) => x.id === "A")!, B = a.accounts.find((x) => x.id === "B")!;
  assert.deepEqual([A.clock.shifted, A.clock.world, A.clock.because], [true, "2026-11-18T09:00:00.000Z", "urgent_request"]);
  assert.deepEqual([B.clock.shifted, B.clock.world, B.clock.because], [true, "2026-11-30T09:00:00.000Z", "usage_drop"]);
  assert.equal(A.clock.real, REAL_NOW.toISOString());
  const K = a.accounts.find((x) => x.id === "K");
  if (K) assert.deepEqual([K.clock.shifted, K.clock.world], [false, REAL_NOW.toISOString()], "an account with no events keeps the real clock");
  const none = analyse({ ...bundleFromSnapshot(), signals: [] }, REAL_NOW);
  assert.ok(none.accounts.every((x) => !x.clock.shifted));
});

t("B: three docks that flew most nights stopped; the idle-docks move rises with the event", () => {
  const { a } = run();
  const B = a.accounts.find((x) => x.id === "B")!;
  assert.equal(B.fleet!.wentQuiet, 3);
  const m = B.q3.top.find((x) => x.id === "move:idle-docks")!;
  assert.ok(m, "idle-docks is in B's top three");
  assert.match(m.title, /start with the 3 that stopped/);
  assert.ok(m.sources.includes("signal:usage_drop") && m.sources.includes("B:usage_weekly.csv"));
  assert.ok(m.valueAtRisk.backed >= 320_000, "includes the renewal and the documented 180k insurer saving");
  assert.ok(B.q4.some((r) => r.id === "risk:signal:usage_drop"));
});

t("A: Karen's event is move #1, the promise we owe, due today inside 'this week' and the 5 Dec event", () => {
  const { a, b } = run();
  const m = a.accounts[0].q3.top[0];
  assert.match(m.title, /Westmere needs an answer before a public event/);
  assert.match(m.title, /and 1 older ask/, "her own event email is part of the event, not an 'older ask'");
  assert.equal(m.score.promise, 2);
  assert.deepEqual(m.insideDeadlines.map((d) => d.date).sort(), ["2026-11-25", "2026-12-05"], "the event date is 5 Dec, not the signal's own date");
  assert.equal(m.due, "2026-11-18");
  assert.ok(m.dealTitles.some((x) => /Priority support/.test(x)) && m.dealTitles.some((x) => /Operator training/.test(x)));
  assert.ok(m.sources.includes("signal:urgent_request") && m.sources.includes("A:emails/2026-11-18_karen_event.txt"));
  const email = resolveSource(b, "A:emails/2026-11-18_karen_event.txt")!;
  assert.match(String(email.content), /Public event, 5 December/);
  const row = resolveSource(b, "A:requests.csv#FB-11206")!;
  assert.match(JSON.stringify(row.content), /Operator training and support cover/);
});

t("A: Rhys leaving is move #2, tied to the renewal, due before 1 January", () => {
  const { a } = run();
  const m = a.accounts[0].q3.top[1];
  assert.match(m.title, /Rhys Calder is moving on/);
  assert.ok(m.dealIds.includes("a_renewal"), "he has been on every call, so the renewal rests on him");
  assert.ok(m.insideDeadlines.some((d) => d.date === "2027-01-01" && d.derived && /no day given/.test(d.label)));
  assert.ok(m.due <= "2026-12-25");
  assert.match(m.reasoning, /every call since 2026-05/);
});

t("A: risk dated 1 Jan (derived, rule shown), and a gap asking who replaces Rhys", () => {
  const { a } = run();
  const risk = a.accounts[0].q4.find((r) => r.id === "risk:signal:champion_leaves")!;
  assert.equal(risk.turnsBadOn!.date, "2027-01-01");
  assert.ok(risk.turnsBadOn!.derived && /no day/.test(risk.turnsBadOn!.how!));
  assert.equal(a.accounts[0].q4.find((r) => r.id === "risk:signal:urgent_request")!.turnsBadOn!.date, "2026-12-05");
  const gap = a.accounts[0].q5.find((g) => /Who takes over from Rhys Calder/.test(g.title))!;
  assert.ok(gap && /Rhys Calder/.test(gap.whoCouldFill[0].who) && gap.sources.includes("signal:champion_leaves"));
});

t("the events are shown with their titles on the account they are about", () => {
  const { a } = run();
  assert.deepEqual(a.accounts[0].signals.map((s) => s.headline).sort(), ["Rhys Calder is moving on", "Westmere needs an answer before a public event"]);
  assert.deepEqual(a.accounts[1].signals.map((s) => s.headline), ["three docks that fly most nights have stopped"]);
  assert.equal(a.signals.length, 3);
});

t("every source id still resolves to a real record, now including the signals' inline records", () => {
  const { a, b } = run();
  const bad: string[] = [];
  const walk = (o: unknown, path: string) => {
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
      if (k === "raw") continue;
      if (k === "sources" && Array.isArray(v)) for (const id of v as string[]) { if (!resolveSource(b, id)) bad.push(`${path}: ${id}`); }
      else walk(v, `${path}.${k}`);
    }
  };
  walk(a.accounts, "accounts");
  assert.deepEqual(bad, []);
});

t("write-back would now include notes for both live events", () => {
  const { a } = run();
  const titles = planNotes(a, { notes: [] }, null, {}).map((j) => String(j.args.title));
  assert.ok(titles.some((x) => /Westmere needs an answer/.test(x)));
  assert.ok(titles.some((x) => /Rhys Calder is moving on/.test(x)));
});
