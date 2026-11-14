// Invariants for the rules engine, run on the real snapshot. These enforce the rubric:
// every number cites ids, no id is invented, backed and unbacked stay apart, notes never leak out of Q5.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bundleFromSnapshot } from "../lib/analysis/snapshot.ts";
import { analyse } from "../lib/analysis/index.ts";
import { resolveSource } from "../lib/sources.ts";
import { addDays, iso, ymd } from "../lib/analysis/util.ts";
import { RULES } from "../lib/analysis/detect.ts";
import { parseMonth, cleanForceMonthLog } from "../lib/analysis/flightlog.ts";

const have = fs.existsSync("snapshot/get_my_accounts.json") && fs.existsSync("snapshot/file.flight_log_force_month.json");
const NOW = new Date("2026-11-14T10:00:00Z");
const bundle = have ? bundleFromSnapshot() : null;
const run = (opts: { signals?: any[]; now?: Date } = {}) => {
  const b = bundleFromSnapshot();
  if (opts.signals) b.signals = opts.signals;
  return { b, a: analyse(b, opts.now ?? NOW) };
};
const t = have ? test : test.skip;

/** every `sources` array in the output, with a path for error messages */
function allSources(o: unknown, path = "", out: { path: string; ids: string[] }[] = []) {
  if (Array.isArray(o)) o.forEach((x, i) => allSources(x, `${path}[${i}]`, out));
  else if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      if (k === "sources" && Array.isArray(v)) {
        // a zero total has no components to cite
        if ((o as { amount?: number }).amount === 0 && v.length === 0) continue;
        out.push({ path: `${path}.sources`, ids: v as string[] });
      }
      else if (k !== "raw") allSources(v, `${path}.${k}`, out);
    }
  }
  return out;
}

t("both accounts are analysed from stored data", () => {
  const { a } = run();
  assert.equal(a.ready, true);
  assert.deepEqual(a.accounts.slice(0, 2).map((x) => x.id), ["A", "B"]);
  assert.deepEqual(a.accounts.slice(0, 2).map((x) => x.currency), ["GBP", "EUR"]);
});

t("every item carries sources, and every source id resolves to a real record (no invented ids)", () => {
  const { a, b } = run();
  const bad: string[] = [];
  let n = 0;
  for (const acc of a.accounts) {
    for (const s of allSources(acc, acc.id)) {
      assert.ok(s.ids.length > 0, `empty sources at ${s.path}`);
      for (const id of s.ids) { n++; if (!resolveSource(b, id)) bad.push(`${s.path}: ${id}`); }
    }
  }
  assert.deepEqual(bad, [], `unresolvable ids:\n${bad.join("\n")}`);
  assert.ok(n > 200, `expected many cited ids, got ${n}`);
});

t("Q1: backed and unbacked are separate, with no headline total", () => {
  const { a } = run();
  const A = a.accounts[0].q1, B = a.accounts[1].q1;
  assert.equal(A.totals.closed.amount, 555_000); // 250k + 200k + 60k + 45k
  assert.equal(A.totals.evidenced.amount, 350_000); // renewal: amount is in the contract
  assert.equal(A.totals.unbacked.amount, 0);
  assert.equal(B.totals.closed.amount, 0);
  assert.equal(B.totals.evidenced.amount, 140_000); // renewal from contract + deal_history
  assert.equal(B.totals.projection.amount, 1_290_000); // 1.2M case study + 90k insurance: no record holds either amount
  assert.equal(B.totals.openOffers.amount, 280_000);
  assert.ok(!("total" in B.totals) && !("headline" in B.totals));
  const sister = B.rows.find((r) => r.id === "b_sister")!;
  assert.equal(sister.backed, false);
  assert.match(sister.note!, /1,053,400/, "the spreadsheet gap is computed, not copied");
  assert.equal(B.evidencedSavings[0].amount, 180_000);
  assert.deepEqual(B.evidencedSavings[0].sources, ["jt_prem_2", "insurer_premium_letter"]);
  assert.ok(A.declined.some((d) => d.id === "a_extra_docks"));
  const claim = A.claimsOnly.find((c) => c.id === "rc_funding_0")!;
  assert.ok(claim.qualifiedBy.some((q) => q.sources.includes("rc_funding_2")), "a claim is shown beside what contradicts it");
});

t("Q2: every deal has decides/pays/uses/blocks, derived entries say so, unknowns are labelled", () => {
  const { a } = run();
  for (const acc of a.accounts) for (const d of acc.q2) {
    for (const role of ["decides", "pays", "uses", "blocks"]) assert.ok(d.entries.some((e) => e.role === role), `${d.dealId} lacks ${role}`);
    for (const e of d.entries) { assert.ok(e.sources.length > 0); assert.ok(e.basis === "derived" || e.basis === "stated"); if (!e.known) assert.match(e.who, /^Unknown:|^Billed|operators on file/); }
  }
  const renewal = a.accounts[0].q2.find((d) => d.dealId === "a_renewal")!;
  const dec = renewal.entries.find((e) => e.role === "decides" && !e.known)!;
  assert.match(dec.who, /chief finance officer/);
  assert.ok(dec.sources.includes("rc_funding_2") && dec.sources.includes("eb_sign_2"));
  const bRen = a.accounts[1].q2.find((d) => /Renewal of the 14/.test(d.title))!;
  assert.ok(bRen.entries.some((e) => e.role === "decides" && e.stakeholderId === "stefan_roy" && e.basis === "stated"), "contract names Stefan as signer");
  assert.ok(bRen.entries.some((e) => e.role === "blocks" && e.stakeholderId === "nadia_rahman"), "finance mailbox email gates the renewal");
  assert.equal(a.accounts[1].q2.find((d) => d.dealId === "b_priority_support")!.entries.find((e) => e.role === "decides")!.relationship, "guarded");
});

t("Q3: three ranked moves, each with owner, due date inside every deadline, and deals", () => {
  const { a } = run();
  for (const acc of a.accounts) {
    assert.equal(acc.q3.top.length, 3);
    acc.q3.top.forEach((m, i) => {
      assert.equal(m.rank, i + 1);
      assert.ok(m.owner && m.due && m.reasoning.length > 40);
      assert.ok(m.dealIds.length > 0, `move ${m.id} moves no deal`);
      for (const d of m.insideDeadlines) assert.ok(ymd(m.due) <= addDays(ymd(d.date), -RULES.dueBufferDays) || m.due === iso(NOW), `${m.id} due ${m.due} not inside ${d.label} ${d.date}`);
      if (i) assert.ok(acc.q3.top[i - 1].score.total >= m.score.total);
    });
  }
  const A = a.accounts[0].q3.top.map((m) => m.title).join("|");
  assert.match(A, /Karen/);
  assert.match(a.accounts[1].q3.top[0].title, /renewal/i, "B: the renewal with Group Finance's unanswered quote request leads");
});

t("Q3: Karen's live event becomes move #1 with the promise we owe, due inside 'this week' and the event date", () => {
  const sig = { id: "sig-1", account: "A", date: "2026-11-18", text: "Insp. Karen Mbeki wrote and logged a ticket ahead of a public event on 5 Dec. She needs, in writing this week, training dates for new operators and who answers if a dock fails on the day." };
  const { a } = run({ signals: [sig], now: new Date("2026-11-18T09:00:00Z") });
  const m = a.accounts[0].q3.top[0];
  assert.match(m.title, /live event/i);
  assert.equal(m.score.promise, 2, "we sold her priority support and training");
  assert.ok(m.dealTitles.some((x) => /Priority support/.test(x)) && m.dealTitles.some((x) => /Operator training/.test(x)));
  const dates = m.insideDeadlines.map((d) => d.date).sort();
  assert.deepEqual(dates, ["2026-11-25", "2026-12-05"]);
  assert.ok(ymd(m.due) <= ymd("2026-11-25") && ymd(m.due) <= ymd("2026-12-05"));
  assert.ok(m.sources.includes("signal:sig-1"));
  assert.equal(a.accounts[1].signals.length, 0);
  assert.ok(a.accounts[0].q4.some((r) => r.kind === "signal"));
});

t("Q3: a live event about docks that stopped flying folds into the idle-docks move for B", () => {
  const sig = { id: "sig-2", account: "B", date: "2026-11-30", text: "Three docks that flew most nights have flown nothing for two weeks. They are still online. No ticket has been raised and nobody at the customer has said anything." };
  const { a } = run({ signals: [sig], now: new Date("2026-11-30T09:00:00Z") });
  const moves = a.accounts[1].q3.top;
  const idle = moves.find((m) => m.id === "move:idle-docks")!;
  assert.ok(idle, "idle-docks move is in B's top three");
  assert.ok(idle.sources.includes("signal:sig-2"));
  assert.ok(idle.valueAtRisk.backed >= 320_000, "includes the documented 180k saving and the 140k renewal");
});

t("Q4: risks have a date it turns bad (stated or derived with the rule), derived dates say how", () => {
  const { a } = run();
  for (const acc of a.accounts) {
    assert.ok(acc.q4.length >= 4);
    for (const r of acc.q4) { assert.ok(r.sources.length > 0); if (r.turnsBadOn?.derived) assert.ok(r.turnsBadOn.how, `${r.id} derived date has no rule`); }
  }
  const B = a.accounts[1].q4;
  assert.ok(B.some((r) => r.turnsBadOn?.date === "2027-04-14" && /barely fly/.test(r.title)), "insurer review derived from 'in five months'");
  assert.ok(B.some((r) => /Renewal quote/.test(r.title) && r.overdue), "Group Finance's 8 Oct email is overdue");
  assert.ok(B.some((r) => /Beatriz/.test(r.title) && r.turnsBadOn?.date === "2026-11-19"));
  const A = a.accounts[0].q4;
  assert.ok(A.some((r) => /Metro Central: live docks fell from 8 to 3/.test(r.title)));
  assert.ok(A.some((r) => /Tarn Valley/.test(r.title) && /no live missions/.test(r.title)));
  assert.ok(A.some((r) => /FB-10412/.test(r.title) && r.overdue));
  assert.ok(A.some((r) => /Batteries/.test(r.title) && r.overdue));
  assert.ok(A.some((r) => /Deadline with no date/.test(r.title) && r.turnsBadOn === null));
});

t("Q5: every gap names who could fill it, and morning notes appear only here, flagged unconfirmed", () => {
  const { a } = run();
  for (const acc of a.accounts) {
    for (const g of acc.q5) {
      assert.ok(g.whyItMatters.length > 20);
      if (g.kind !== "unconfirmed_note") assert.ok(g.sources.length > 0);
      assert.ok(g.whoCouldFill.length > 0, `gap "${g.title}" names nobody`);
      for (const w of g.whoCouldFill) assert.ok(w.who && w.why);
    }
    assert.ok(acc.q5.filter((g) => g.kind === "unconfirmed_note").every((g) => g.sources.includes("notes:morning")));
    // notes never leak into other sections
    const rest = JSON.stringify({ q1: acc.q1, q2: acc.q2, q3: acc.q3, q4: acc.q4 });
    assert.ok(!rest.includes("notes:morning") && !/morning notes/i.test(rest));
  }
  const A = a.accounts[0].q5.map((g) => g.title).join("\n");
  assert.match(A, /Was it actually delivered\? FB-10412/);
  assert.match(A, /finance contact/i);
});

t("no dollar amounts appear: GBP for A and EUR for B", () => {
  const { a } = run();
  assert.ok(!JSON.stringify(a.accounts).includes("$"));
  assert.ok(a.accounts[0].q3.top.every((m) => !/€/.test(m.reasoning)));
  assert.ok(a.accounts[1].q3.top.every((m) => !/£/.test(m.reasoning)));
});

test("flight log cleaning: names, months and the re-sent row", () => {
  assert.equal(parseMonth("05/2026"), "2026-05");
  assert.equal(parseMonth("Jun 2026"), "2026-06");
  assert.equal(parseMonth("Aug-26"), "2026-08");
  assert.equal(parseMonth("2026-09"), "2026-09");
  const csv = "force,month,docks_installed,docks_with_live_flights,live_missions,training_flights,notes\nMETRO CTRL,10/2026,9,3,21,4,\nMetro Central,2026-10,9,3,21,4,\nMetro Central,Oct 2026,9,,,,\"re-sent\"\nTarn Vly,Sep-26,4,0,0,0,";
  const { rows, dropped } = cleanForceMonthLog(csv, ["Westmere", "Metro Central", "Tarn Valley"]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.force === "Metro Central")!.docksLive, 3);
  assert.ok(dropped.some((d) => /re-sent/.test(d.reason)) && dropped.some((d) => /duplicate/.test(d.reason)));
});

test("analysis degrades gracefully with no data", () => {
  const a = analyse({ whoami: null, accounts: null, team: [], signals: [], signalsAt: null, paperwork: {}, files: {}, notes: null, index: {} });
  assert.equal(a.ready, false);
  assert.deepEqual(a.missing, ["get_my_accounts"]);
});
