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
import { findMonthInText } from "../lib/analysis/util.ts";

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
  assert.equal(once.B.length, b.paperwork.B.length, "account B untouched");
});

t("today moves to the date of the latest live event, and says why", () => {
  const { a } = run();
  assert.equal(a.clock.shifted, true);
  assert.equal(a.clock.world, "2026-11-18T09:00:00.000Z");
  assert.equal(a.clock.real, REAL_NOW.toISOString());
  assert.equal(a.clock.because, "urgent_request");
  const none = analyse({ ...bundleFromSnapshot(), signals: [] }, REAL_NOW);
  assert.equal(none.clock.shifted, false);
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

t("both signals are shown with their titles on account A, and none on B", () => {
  const { a } = run();
  assert.deepEqual(a.accounts[0].signals.map((s) => s.headline).sort(), ["Rhys Calder is moving on", "Westmere needs an answer before a public event"]);
  assert.equal(a.accounts[1].signals.length, 0);
  assert.equal(a.signals.length, 2);
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
