// Q3: what do you do first? Candidate moves from the findings, ranked by
//   score = urgency x value x promise
//   urgency  the tightest dated deadline (or, for something we owe, how long it has waited, capped below a hard deadline);
//            a live event is new information, so it never scores below 3
//   value    0.25 + log10(1 + weighted/5000), where weighted = backed value of the deals the move protects
//            + 10% of unbacked value (never more than 30,000): a claim can't outrank a contract
//   promise  2.0 if we owe it on something we SOLD (a won offer), 1.5 if we owe a reply or follow-up, else 1
// Every move gets an owner, a due date that sits inside every relevant deadline, and the deals it moves.
import type { Ctx } from "./ctx.ts";
import { words } from "./ctx.ts";
import type { Deadlines, IdleDocks, OpenItem, ForceUsageResult } from "./detect.ts";
import { RULES } from "./detect.ts";
import { addDays, daysBetween, findDateInText, iso, money, uniq, ymd } from "./util.ts";
import type { BookRow, Move, Q1, SignalView, SourceId } from "./types.ts";

interface Deadline { label: string; date: string; derived: boolean; sources: SourceId[] }

export interface MoveInputs {
  ctx: Ctx;
  q1: Q1;
  items: OpenItem[];
  idle: IdleDocks | null;
  force: ForceUsageResult | null;
  deadlines: Deadlines;
  signals: SignalView[];
}

const stem = (w: string) => w.replace(/ies$/, "y").replace(/s$/, "");
const round2 = (n: number) => Math.round(n * 100) / 100;

export const SCORE = { unbackedWeight: 0.1, unbackedCap: 30_000, signalFloor: 3, ageBase: 3, ageMax: 2, ageDays: 60, staleFactor: 0.5 };

/** Which deals does this text touch? Strong links: a person it was pitched to or who supplied the evidence. */
export function linkDeals(ctx: Ctx, rows: BookRow[], text: string, personIds: string[]): { rows: BookRow[]; why: string[] } {
  const tw = new Set(words(text).map(stem));
  const scored = rows.filter((r) => r.type !== "claim").map((r) => {
    let score = 0;
    const why: string[] = [];
    const offer = (ctx.account.offers ?? []).find((o) => o.id === r.id);
    const opp = ctx.account.opportunities.find((o) => o.id === r.id);
    const pitch = offer?.pitch_to ? ctx.stakeholderByName(offer.pitch_to)?.id : undefined;
    if (pitch && personIds.includes(pitch)) { score += 3; why.push(`we ${offer!.status === "won" ? "sold" : "pitched"} "${r.title}" to ${offer!.pitch_to}`); }
    if (opp) {
      const said = ctx.account.facts.filter((f) => opp.evidence.includes(f.id) && personIds.includes(ctx.stakeholderByName(f.said_by)?.id ?? ""));
      if (said.length) { score += 2; why.push(`${said[0].said_by} is evidence for "${r.title}"`); }
    }
    const shared = words(r.title).map(stem).filter((w) => w.length >= 5 && tw.has(w));
    if (shared.length) { score += Math.min(2, shared.length); why.push(`it mentions ${shared.join(", ")} (in "${r.title}")`); }
    return { r, score, why };
  });
  const picked = scored.filter((s) => s.score >= 3);
  return { rows: picked.map((p) => p.r), why: picked.flatMap((p) => p.why) };
}

function valueAtRisk(rows: BookRow[], extraBacked = 0) {
  let backed = extraBacked, unbacked = 0;
  for (const r of rows) {
    if (r.value == null) continue;
    if (r.backed) backed += r.value; else unbacked += r.value;
  }
  return { backed, unbacked, weighted: backed + Math.min(SCORE.unbackedWeight * unbacked, SCORE.unbackedCap) };
}

const deadlineUrgency = (d: number) => (d <= 0 ? 5 + Math.min(1, Math.abs(d) / 90) : 1 + 4 * Math.exp(-d / 21));
const ageUrgency = (age: number) => SCORE.ageBase + Math.min(SCORE.ageMax, age / SCORE.ageDays);
const valueFactor = (weighted: number) => 0.25 + Math.log10(1 + weighted / 5000);

/** Who owns it at FlytBase, and who helps. Rules cite the record that tells us. */
function ownersFor(ctx: Ctx, text: string): { owner: string; helpers: string[]; sources: SourceId[] } {
  const helpers: string[] = [];
  const sources: SourceId[] = [ctx.src("profile.json")];
  const team = (id: string) => ctx.team.find((t) => t.id === id);
  const commercial = team(ctx.profile?.flytbase_side?.commercial_owner ?? "");
  if (/\b(quote|pricing|price|proposal|stadium)\b/i.test(text) && commercial) helpers.push(`${commercial.name} (${commercial.role}), commercial owner`);
  if (/data-flow|dpia|retention|storage location|access control|document request/i.test(text)) {
    const f = ctx.account.facts.find((x) => /engineering can produce/i.test(x.text));
    const eng = team((f?.said_by ?? "").toLowerCase()) ?? ctx.team.find((t) => /engineering/i.test(t.role));
    if (eng) { helpers.push(`${eng.name} (${eng.role}) to produce or re-issue the pack`); if (f) sources.push(f.id); }
  }
  if (/battery|aircraft|\bdock\b.*(fault|offline|sensor|lid)|offline|hardware|propeller/i.test(text)) {
    const tickets = ctx.json<{ tickets: any[] }>("tickets.json")?.tickets ?? [];
    const hw = tickets.filter((t) => /hardware/i.test(t.category ?? "") && t.assignee);
    const mode = [...hw.reduce((m, t) => m.set(t.assignee, (m.get(t.assignee) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (mode) { helpers.push(`${mode} (assignee on the account's hardware tickets)`); sources.push(ctx.src("tickets.json")); }
  }
  if (/\bFB-\d+|support queue|no assignee|unassigned/i.test(text)) { const sd = team("support_desk"); if (sd) helpers.push(`${sd.name}: assign the ticket`); }
  return { owner: "You (CSM)", helpers: uniq(helpers), sources };
}

function dueDate(ctx: Ctx, slaDays: number, deadlines: Deadline[]): string {
  const sla = addDays(ctx.now, slaDays);
  const limits = deadlines.map((d) => addDays(ymd(d.date), -RULES.dueBufferDays));
  const due = [sla, ...limits].reduce((a, b) => (a < b ? a : b));
  return iso(due < ctx.now ? ctx.now : due);
}

interface Cand {
  id: string; title: string; detail: string[]; weOwe: boolean; dls: Deadline[]; text: string; ageDays: number | null;
  sources: SourceId[]; rows: BookRow[]; whyLinked: string[]; hasSignal?: boolean; stale?: string; extraBacked?: { amount: number; label: string; sources: SourceId[] };
}

export function buildMoves(inp: MoveInputs): { top: Move[]; considered: Move[] } {
  const { ctx, q1, items, idle, force, deadlines, signals } = inp;
  const cur = ctx.currency;
  const cands: Cand[] = [];
  const renewalRow = q1.rows.find((r) => /renew/i.test(r.title));
  const termDeadline: Deadline | null = deadlines.termEnd ? { label: `Term ends (${renewalRow?.title ?? "contract"})`, date: deadlines.termEnd.date, derived: false, sources: deadlines.termEnd.sources } : null;
  const leadDeadline: Deadline | null = deadlines.renewalLead ? { label: "Latest sensible start of the renewal", date: deadlines.renewalLead.date, derived: true, sources: deadlines.renewalLead.sources } : null;
  const covered = new Set<string>();

  // ---- renewal move: the term end is a hard date, and open asks about it fold in
  if (renewalRow && termDeadline) {
    const asks = items.filter((it) => /renew/i.test(it.title + " " + it.detail));
    asks.forEach((a) => covered.add(a.id));
    const oppRow = ctx.account.opportunities.find((o) => o.id === renewalRow.id);
    const detail = [
      `Term ends ${termDeadline.date}; there is no automatic renewal, so a new order must be signed before then.`,
      ...(oppRow?.blocker ? [`Open blocker on the deal: ${oppRow.blocker.text}.`] : []),
      ...asks.map((a) => `Unanswered since ${a.since}: ${a.detail}`),
      ...(force ? [`Force-by-force usage: ${force.forces.map((f) => `${f.force} ${f.latest.docksLive ?? "?"}/${f.latest.docksInstalled ?? "?"} docks live in ${f.latest.month}`).join("; ")}.`] : []),
    ];
    cands.push({
      id: `move:renewal:${renewalRow.id}`, title: `Open the renewal: ${renewalRow.title}${asks.length ? " (answer the open asks first)" : ""}`,
      detail, weOwe: asks.length > 0, dls: [termDeadline, ...(leadDeadline ? [leadDeadline] : [])], text: detail.join(" "),
      ageDays: asks.length ? Math.max(...asks.map((a) => a.ageDays ?? 0)) : null,
      sources: [...asks.flatMap((a) => a.sources), ...termDeadline.sources, ...(force ? [force.fileId] : [])], rows: [renewalRow], whyLinked: ["it is the renewal the term end puts on a clock"],
    });
  }

  // ---- open items and live signals, grouped by the person they concern
  type G = { person: string | null; label: string; items: OpenItem[]; sigs: SignalView[]; texts: string[] };
  const groups = new Map<string, G>();
  const gk = (person: string | undefined, label: string | null) => person ?? `label:${label}`;
  for (const it of items) {
    if (covered.has(it.id)) continue;
    const k = gk(it.personId, it.from);
    const g = groups.get(k) ?? { person: it.personId ?? null, label: (it.personId && ctx.account.stakeholders.find((x) => x.id === it.personId)?.name) || it.from || "the customer", items: [], sigs: [], texts: [] };
    g.items.push(it); g.texts.push(`${it.title} ${it.detail} ${it.from ?? ""}`);
    groups.set(k, g);
  }
  const looksLikeDocks = (t: string) => /\b(flew|flown|flying|not fl\w+|no flights|idle|offline|nothing)\b/i.test(t) && /\bdocks?\b/i.test(t);
  const idleSignals: SignalView[] = [];
  for (const sg of signals) {
    if (!sg.people.length && looksLikeDocks(sg.text) && idle) { idleSignals.push(sg); continue; }
    const k = gk(sg.people[0], sg.text.slice(0, 20));
    const g = groups.get(k) ?? { person: sg.people[0] ?? null, label: sg.people[0] ? (ctx.account.stakeholders.find((s) => s.id === sg.people[0])?.name ?? "the customer") : "the customer", items: [], sigs: [], texts: [] };
    g.sigs.push(sg); g.texts.push(sg.text);
    groups.set(k, g);
  }
  for (const [key, g] of groups) {
    const personIds = g.person ? [g.person] : [];
    const text = g.texts.join(" ");
    const linked = linkDeals(ctx, q1.rows, text, personIds);
    const oldest = g.items.reduce<OpenItem | null>((a, b) => (!a || (b.ageDays ?? 0) > (a.ageDays ?? 0) ? b : a), null);
    const owed = g.items.some((i) => i.weOwe) || g.sigs.length > 0;
    const dls: Deadline[] = [];
    for (const sg of g.sigs) {
      const ev = findDateInText(sg.date ? sg.text.replace(sg.date, "") : sg.text, ctx.now);
      if (ev && ev >= ctx.now) dls.push({ label: `Date named in the live event`, date: iso(ev), derived: true, sources: sg.sources });
      if (/this week/i.test(sg.text) && sg.date) dls.push({ label: `"this week" in the live event of ${sg.date}`, date: iso(addDays(ymd(sg.date), 7)), derived: true, sources: sg.sources });
    }
    const sold = linked.rows.filter((r) => r.type === "offer" && r.backed);
    const detail = [
      ...g.sigs.map((sg) => `LIVE EVENT${sg.date ? ` (${sg.date})` : ""}: ${sg.text}. No FlytBase reply to it is on file.`),
      ...(sold.length && owed ? [`We sold ${sold.map((r) => `"${r.title}"`).join(" and ")} to ${g.label}, so what ${g.label} is asking for is a promise we owe.`] : []),
      ...g.items.map((i) => `${i.weOwe ? "We owe" : "Chase"}: ${i.title} (since ${i.since}, ${i.ageDays} days). ${i.detail}`),
    ];
    const first = g.items[0];
    const total = g.items.length + g.sigs.length;
    let title: string;
    if (g.sigs.length) title = `Respond to ${g.label}'s live event${total > 1 ? ` and ${g.items.length} older ask${g.items.length === 1 ? "" : "s"}` : ""}: ${g.sigs[0].text.slice(0, 80)}${g.sigs[0].text.length > 80 ? "…" : ""}`;
    else if (total === 1 && first.kind === "ticket") title = first.waitingOn === "customer" ? `Chase ${g.label} on ${first.title}` : `Own and answer ticket ${first.title}`;
    else if (total === 1) title = `${first.kind === "unexplored" ? "Call" : first.weOwe ? "Reply to" : "Chase"} ${g.label}: ${first.title}`;
    else title = `${owed ? "Reply to" : "Chase"} ${g.label}: ${total} open asks (${g.items.map((i) => i.title.replace(/\.$/, "")).slice(0, 2).join("; ")}${total > 2 ? "…" : ""})`;
    // a ticket whose gating blocker is already marked cleared is probably stale: it may only need closing
    const clearedAll = linked.rows.length > 0 && linked.rows.every((r) => ctx.account.opportunities.find((o) => o.id === r.id)?.blocker?.status === "cleared");
    const stale = clearedAll && g.items.every((i) => i.kind === "ticket") && g.sigs.length === 0
      ? `the discovery record marks the blocker on ${linked.rows.map((r) => `"${r.title}"`).join(", ")} as cleared, so this ticket may only need closing: confirm it was actually sent`
      : undefined;
    cands.push({
      id: `move:group:${key}`, title, detail, weOwe: owed, dls, text, ageDays: oldest?.ageDays ?? null,
      sources: [...g.items.flatMap((i) => i.sources), ...g.sigs.flatMap((s) => s.sources)], rows: linked.rows, whyLinked: linked.why, hasSignal: g.sigs.length > 0, stale,
    });
  }

  // ---- idle docks (plus any live event about docks)
  if (idle) {
    const never = idle.byClass.never_flew, quiet = idle.byClass.went_quiet, rarely = idle.byClass.rarely;
    const n = never.length + quiet.length + rarely.length;
    if (n > 0 || idleSignals.length) {
      const rel = deadlines.relative[0];
      const dls: Deadline[] = [];
      if (rel) dls.push({ label: `Review that idle docks put at risk ("${rel.phrase}", derived)`, date: rel.date, derived: true, sources: rel.sources });
      if (termDeadline) dls.push(termDeadline);
      const linkedRows = q1.rows.filter((r) => /renew/i.test(r.title) || ctx.account.facts.some((f) => /idle|not flown|never flown/i.test(f.text) && (ctx.account.opportunities.find((o) => o.id === r.id)?.evidence ?? []).includes(f.id)));
      const sv = q1.evidencedSavings[0];
      const detail = [
        ...idleSignals.map((sg) => `LIVE EVENT${sg.date ? ` (${sg.date})` : ""}: ${sg.text}. No FlytBase reply to it is on file.`),
        `${n} of ${idle.total} docks barely fly: ${never.length} never flew, ${quiet.length} stopped after flying regularly, ${rarely.length} fly under ${RULES.rarelyPerWeek} a week (weeks ${idle.weeks[0]} to ${idle.weeks[1]}; all docks last seen online ${idle.lastSeenOnline}).`,
        ...(quiet.length ? [`Stopped: ${quiet.map((d) => d.dockId).join(", ")}.`] : []),
        ...(never.length ? [`Never flew: ${never.map((d) => d.dockId).join(", ")}.`] : []),
        ...(sv ? [`Documented at stake: ${money(sv.amount, cur)} ${sv.period} insurer saving. ${sv.label}`] : []),
        "Which force or plant each dock sits at is not on file, so the first job is to get the dock-to-site list.",
      ];
      cands.push({
        id: "move:idle-docks", title: `Find out why ${n} docks barely fly${quiet.length ? ` (start with the ${quiet.length} that stopped)` : ""}${idleSignals.length ? ", prompted by the live event" : ""}`,
        detail, weOwe: idleSignals.length > 0, dls, text: detail.join(" "), ageDays: idleSignals[0]?.date ? Math.max(0, daysBetween(ymd(idleSignals[0].date), ctx.now)) : null,
        sources: [...idle.sources, ...idleSignals.flatMap((s) => s.sources), ...(sv ? sv.sources : [])], rows: linkedRows, whyLinked: ["idle docks undermine the renewal case"], hasSignal: idleSignals.length > 0,
        extraBacked: sv && /idle|not flown|regular|patrol/i.test(`${sv.label} ${ctx.account.facts.map((f) => f.text).join(" ")}`) ? { amount: sv.amount, label: `${money(sv.amount, cur)} ${sv.period} documented saving`, sources: sv.sources } : undefined,
      });
    }
  }

  // ---- score
  const moves: Move[] = cands.map((c) => {
    const vr = valueAtRisk(c.rows, c.extraBacked?.amount ?? 0);
    const days = c.dls.length ? Math.min(...c.dls.map((d) => daysBetween(ctx.now, ymd(d.date)))) : null;
    const parts: string[] = [];
    let urgency = 1;
    if (days !== null) { urgency = deadlineUrgency(days); parts.push(`tightest deadline ${days <= 0 ? `${-days} days ago` : `in ${days} days`} (${urgency.toFixed(1)})`); }
    if (c.weOwe && c.ageDays != null && c.ageDays > 0) { const a = ageUrgency(c.ageDays); if (a > urgency || days === null) parts.push(`waiting ${c.ageDays} days with no reply (${a.toFixed(1)})`); urgency = Math.max(urgency, a); }
    if (c.hasSignal && urgency < SCORE.signalFloor) { urgency = SCORE.signalFloor; parts.push(`a live event is new information (floor ${SCORE.signalFloor})`); }
    if (!parts.length) parts.push("no dated deadline, so the baseline (1.0)");
    const sold = c.weOwe && c.rows.some((r) => r.type === "offer" && r.backed);
    const promise = sold ? 2 : c.weOwe ? 1.5 : 1;
    const value = valueFactor(vr.weighted) * (c.stale ? SCORE.staleFactor : 1);
    const total = urgency * value * promise;
    const own = ownersFor(ctx, c.text);
    const sla = c.weOwe ? RULES.sla.weOwe : RULES.sla.other;
    const reasoning = [
      `Urgency ${urgency.toFixed(1)}: ${parts.join("; ")}.`,
      `Value ${value.toFixed(2)}: ${money(vr.backed, cur)} backed${vr.unbacked ? ` + ${money(Math.min(SCORE.unbackedWeight * vr.unbacked, SCORE.unbackedCap), cur)} counted from ${money(vr.unbacked, cur)} unbacked` : ""} at stake${c.rows.length ? ` (${c.rows.map((r) => r.title).join("; ")})` : " (no deal linked)"}${c.extraBacked ? `, including ${c.extraBacked.label}` : ""}${c.stale ? `; halved because ${c.stale}` : ""}.`,
      `Promise ${promise}${sold ? ": we sold the linked offer(s) and owe this" : c.weOwe ? ": FlytBase owes this" : ""}.`,
      `Score ${urgency.toFixed(1)} x ${value.toFixed(2)} x ${promise} = ${total.toFixed(1)}.`,
      ...(c.whyLinked.length ? [`Deals linked because ${uniq(c.whyLinked).join("; ")}.`] : []),
    ].join(" ");
    return {
      id: c.id, title: c.title, detail: c.detail, owner: own.owner, helpers: own.helpers,
      due: dueDate(ctx, sla, c.dls), insideDeadlines: c.dls,
      dealIds: c.rows.map((r) => r.id), dealTitles: c.rows.map((r) => r.title), weOwe: c.weOwe,
      score: { urgency: round2(urgency), value: round2(value), promise, total: round2(total) },
      reasoning, valueAtRisk: { backed: vr.backed, unbacked: vr.unbacked, weighted: vr.weighted },
      sources: uniq([...c.sources, ...own.sources, ...c.rows.map((r) => r.id), ...(c.extraBacked?.sources ?? [])]),
    };
  });
  moves.sort((a, b) => b.score.total - a.score.total);
  return { top: moves.slice(0, 3).map((m, i) => ({ ...m, rank: i + 1 })), considered: moves.slice(3, 11) };
}
