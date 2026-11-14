// Q4: what is about to go wrong, and on what date does each thing turn bad?
// Every risk carries the date it turns bad (stated, or derived with the rule shown) and its sources.
import type { Ctx } from "./ctx.ts";
import type { ContactTemp, Deadlines, ForceUsageResult, IdleDocks, OpenItem } from "./detect.ts";
import { RULES } from "./detect.ts";
import { addDays, daysBetween, findDateInText, findMonthInText, iso, money, uniq, ymd } from "./util.ts";
import type { DatedPoint, Q1, Risk, SignalView, SourceId } from "./types.ts";

export interface RiskInputs {
  ctx: Ctx;
  q1: Q1;
  items: OpenItem[];
  idle: IdleDocks | null;
  force: ForceUsageResult | null;
  contacts: ContactTemp[];
  single: { who: string; since: string; calls: number; sources: SourceId[] } | null;
  deadlines: Deadlines;
  signals: SignalView[];
}

export const REPLY_SLA_DAYS = 7; // an ask we owe a reply to goes bad this long after it arrived
export const CHASE_AFTER_DAYS = 14; // something waiting on the customer needs a chase after this long

export function buildRisks(inp: RiskInputs): Risk[] {
  const { ctx, q1, items, idle, force, contacts, single, deadlines, signals } = inp;
  const out: Risk[] = [];
  const cur = ctx.currency;
  const point = (date: string, derived: boolean, how: string | undefined, sources: SourceId[]): DatedPoint => ({ date, derived, how, sources });
  const isOver = (p: DatedPoint | null) => !!p && ymd(p.date) <= ctx.now;
  const renewal = q1.rows.find((r) => /renew/i.test(r.title));
  const renewalOpp = renewal && ctx.account.opportunities.find((o) => o.id === renewal.id);
  const lead = deadlines.renewalLead ? point(deadlines.renewalLead.date, true, deadlines.renewalLead.how, deadlines.renewalLead.sources) : null;

  // ----- 1. renewal clock
  if (deadlines.termEnd && renewal) {
    const days = daysBetween(ctx.now, ymd(deadlines.termEnd.date));
    const why: string[] = [`No automatic renewal: a new order is needed before ${deadlines.termEnd.date} (${days} days away).`];
    if (renewalOpp?.blocker?.status === "open") why.push(`Open blocker: ${renewalOpp.blocker.text}.`);
    if (renewal.value) why.push(`${money(renewal.value, cur)} a year rides on it.`);
    out.push({
      id: "risk:renewal", kind: "deadline", title: `Renewal clock: ${renewal.title}`, detail: why.join(" "), turnsBadOn: lead,
      overdue: isOver(lead), severity: 6 + (renewalOpp?.blocker?.status === "open" ? 2 : 0) + (days <= 60 ? 2 : 0),
      sources: uniq([...deadlines.termEnd.sources, renewal.id, ...(lead?.sources ?? [])]),
    });
  }

  // ----- 2. deadlines the data states without a date
  for (const u of deadlines.undated) {
    if (u.passed) continue;
    out.push({
      id: `risk:undated:${u.text.slice(0, 20)}`, kind: "deadline", title: `Deadline with no date: ${u.text}`,
      detail: `The discovery record says this is coming up${u.soon ? " soon" : ""} but gives no date${u.met !== undefined ? `; the condition attached to it is ${u.met ? "marked met" : "NOT met"}` : ""}. Until the date is confirmed we cannot say when it turns bad.`,
      turnsBadOn: null, overdue: false, severity: u.met === false ? 7 : 4, sources: u.sources,
    });
  }

  // ----- 3. stuck deals: an open blocker on a deal that is not won
  for (const o of ctx.account.opportunities) {
    if (o.blocker?.status !== "open") continue;
    const isRenewal = o.id === renewal?.id;
    const row = q1.rows.find((r) => r.id === o.id);
    out.push({
      id: `risk:stuck:${o.id}`, kind: "stuck_deal", title: `Stuck: ${o.title}`,
      detail: `Stage "${o.stage}" with an open blocker: ${o.blocker.text}.${row?.value ? ` Worth up to ${money(row.value, cur)} (${row.bucket.replace("_", " ")}).` : ""}`,
      turnsBadOn: isRenewal ? lead : null, overdue: isRenewal ? isOver(lead) : false,
      severity: isRenewal ? 7 : row?.backed ? 5 : 3, sources: [o.id, ...o.evidence.slice(0, 3)],
    });
  }

  // ----- 4. people going cold
  for (const c of contacts) {
    if (c.state === "cold" || c.state === "cooling") {
      out.push({
        id: `risk:cold:${c.stakeholderId}`, kind: "cold_contact", title: `${c.name} ${c.state === "cold" ? "has gone cold" : "is going cold"}`,
        detail: `Last contact ${c.lastContact} (${c.lastContactHow}). Counted as cold after ${RULES.coldAfterDays} days without contact.`,
        turnsBadOn: point(c.coldOn!, true, `last contact ${c.lastContact} + ${RULES.coldAfterDays} days`, c.sources), overdue: c.state === "cold", severity: c.state === "cold" ? 6 : 4, sources: c.sources,
      });
    } else if (c.state === "unknown") {
      out.push({
        id: `risk:nocontact:${c.stakeholderId}`, kind: "cold_contact", title: `No contact on file with ${c.name}`,
        detail: `No call, email or discovery fact ties ${c.name} to a date, so we cannot tell if this relationship is warm or cold.`,
        turnsBadOn: null, overdue: false, severity: 3, sources: c.sources,
      });
    }
  }

  // ----- 5. asks nobody answered
  for (const it of items) {
    if ((it.ageDays ?? 0) < 7) continue;
    const days = it.waitingOn === "us" ? REPLY_SLA_DAYS : CHASE_AFTER_DAYS;
    const due = it.since ? point(iso(addDays(ymd(it.since), days)), true, `${it.since} + ${days} days (${it.waitingOn === "us" ? "reply" : "chase"} rule)`, it.sources) : null;
    out.push({
      id: `risk:item:${it.id}`, kind: "unanswered", title: `${it.kind === "unexplored" ? "Closed without asking why" : it.waitingOn !== "us" ? "No chase" : it.kind === "followup" ? "Not done" : "No reply"}: ${it.title}`,
      detail: `${it.detail} Waiting ${it.ageDays} days.${it.hasOwner ? "" : " Nobody owns it."}`,
      turnsBadOn: due, overdue: isOver(due), severity: Math.min(9, 3 + (it.ageDays ?? 0) / 40 + (it.hasOwner ? 0 : 1)), sources: it.sources,
    });
  }

  // ----- 6. docks that barely fly
  if (idle) {
    const never = idle.byClass.never_flew, quiet = idle.byClass.went_quiet, rarely = idle.byClass.rarely;
    const n = never.length + quiet.length + rarely.length;
    const rel = deadlines.relative[0];
    const when = rel ? point(rel.date, true, rel.how, rel.sources) : lead;
    const atStake = q1.evidencedSavings[0];
    if (n > 0) out.push({
      id: "risk:idle-docks", kind: "idle_docks", title: `${n} of ${idle.total} docks barely fly`,
      detail: `${never.length} never flew, ${quiet.length} stopped after flying regularly, ${rarely.length} fly under ${RULES.rarelyPerWeek} a week, although every dock was last seen online ${idle.lastSeenOnline}.${atStake ? ` ${atStake.label} Documented at stake: ${money(atStake.amount, cur)} ${atStake.period}.` : ""}${rel ? ` The review is "${rel.phrase}" (derived date).` : ""}`,
      turnsBadOn: when, overdue: isOver(when), severity: atStake ? 8 : 6, sources: uniq([...idle.sources, ...(atStake?.sources ?? [])]),
    });
  }

  // ----- 7. usage by force (from the held flight-log file)
  if (force) {
    const dead = force.forces.filter((f) => !f.everLive);
    if (dead.length) out.push({
      id: "risk:usage:dead", kind: "usage", title: `${dead.map((d) => d.force).join(" and ")}: no live missions in any month`,
      detail: dead.map((d) => `${d.force}: ${d.latest.docksLive ?? 0}/${d.latest.docksInstalled ?? "?"} docks live in ${d.latest.month} (${d.note}).`).join(" ") + " Their chief finance officers have little usage to approve a renewal against.",
      turnsBadOn: lead, overdue: isOver(lead), severity: 7, sources: [force.fileId],
    });
    for (const f of force.forces.filter((x) => x.everLive && x.note.startsWith("down"))) {
      const drop = (f.peak.docksLive ?? 0) - (f.latest.docksLive ?? 0);
      if (drop < 3) continue;
      out.push({
        id: `risk:usage:${f.force}`, kind: "usage", title: `${f.force}: live docks fell from ${f.peak.docksLive} to ${f.latest.docksLive}`,
        detail: `${f.force} had ${f.peak.docksLive} of ${f.peak.docksInstalled} docks flying live in ${f.peak.month} and ${f.latest.docksLive} of ${f.latest.docksInstalled} in ${f.latest.month}.`,
        turnsBadOn: lead, overdue: isOver(lead), severity: 6, sources: [force.fileId],
      });
    }
  }

  // ----- 8. one person is the whole relationship
  if (single) out.push({
    id: "risk:single-thread", kind: "single_thread", title: `Single-threaded: every call since ${single.since} was with ${single.who}`,
    detail: `${single.calls} calls, one customer contact. If ${single.who} leaves or goes quiet there is no second route in.`,
    turnsBadOn: lead, overdue: isOver(lead), severity: 5, sources: single.sources,
  });

  // ----- 9. live events (those not already folded into a move are still shown as risks)
  for (const sg of signals) {
    const body = sg.date ? sg.text.replace(sg.date, "") : sg.text;
    const ev = findDateInText(body, ctx.now);
    const month = ev ? null : findMonthInText(body, sg.date ? ymd(sg.date) : ctx.now);
    const date = ev ? iso(ev) : month ? iso(month) : sg.date ? iso(addDays(ymd(sg.date), REPLY_SLA_DAYS)) : null;
    const how = ev ? "the date named in the event" : month ? "the month named in the event; it gives no day, so counted from the 1st" : `event date + ${REPLY_SLA_DAYS} days`;
    const p = date ? point(date, true, how, sg.sources) : null;
    const head = sg.headline ?? `${sg.text.slice(0, 90)}${sg.text.length > 90 ? "…" : ""}`;
    out.push({ id: `risk:signal:${sg.key}`, kind: "signal", title: `Live event with no FlytBase reply: ${head}`, detail: `${sg.title ? `${sg.title}. ` : ""}${sg.text}`, turnsBadOn: p, overdue: isOver(p), severity: 8, sources: sg.sources });
  }

  out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.severity - a.severity || (a.turnsBadOn?.date ?? "9999").localeCompare(b.turnsBadOn?.date ?? "9999"));
  return out;
}
