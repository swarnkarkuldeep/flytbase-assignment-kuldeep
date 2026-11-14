// Q5: what do we still not know? The gaps the plan rests on, why each matters, and who could fill it.
// "Who" is always a named person with the source for why them. Morning-note hints appear here only,
// labelled unconfirmed, and never feed anything else.
import type { Ctx } from "./ctx.ts";
import { words } from "./ctx.ts";
import type { Deadlines, ForceUsageResult, IdleDocks, OpenItem } from "./detect.ts";
import { checkRoiSheet } from "./book.ts";
import { uniq } from "./util.ts";
import { MORNING_NOTES } from "../hints.ts";
import type { DealPower, Gap, Q1, SourceId } from "./types.ts";

type Ask = Gap["whoCouldFill"][number];

export interface GapInputs {
  ctx: Ctx;
  q1: Q1;
  q2: DealPower[];
  items: OpenItem[];
  idle: IdleDocks | null;
  force: ForceUsageResult | null;
  deadlines: Deadlines;
}

const stem = (w: string) => w.replace(/ies$/, "y").replace(/s$/, "");

function askStakeholder(ctx: Ctx, name: string, why: string, sources: SourceId[]): Ask {
  const s = ctx.stakeholderByName(name);
  return { who: s ? `${s.name} (${s.role})` : name, stakeholderId: s?.id, why, sources: uniq([...(s ? [s.id] : []), ...sources]) };
}

/** The customer-side person who is "the main contact" per the profile notes. */
function mainContact(ctx: Ctx): Ask | null {
  const c = (ctx.profile?.contacts_on_file ?? []).find((x: any) => /main contact|alone/i.test(x.note ?? "")) ?? (ctx.profile?.contacts_on_file ?? [])[0];
  if (!c) return null;
  return askStakeholder(ctx, c.name, `Main contact on file: "${c.note}" He or she can introduce others.`, [ctx.src("profile.json")]);
}

/** Customers who said something matching `re` on a call, most frequent first (transcripts are "Name: line"). */
function whoSpokeAbout(ctx: Ctx, re: RegExp): Ask[] {
  const hits = new Map<string, { n: number; path: string; line: string }>();
  for (const r of ctx.records) {
    if (r.kind !== "call" || !r.text) continue;
    for (const line of r.text.split("\n")) {
      const m = /^([A-Z][\w.' \-]+):\s+(.*)$/.exec(line.trim());
      if (!m || !re.test(m[2])) continue;
      const s = ctx.stakeholderByName(m[1]);
      if (!s) continue;
      const cur = hits.get(s.id);
      hits.set(s.id, { n: (cur?.n ?? 0) + 1, path: r.path, line: m[2] });
    }
  }
  return [...hits.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 2).map(([id, h]) => {
    const s = ctx.account.stakeholders.find((x) => x.id === id)!;
    return { who: `${s.name} (${s.role})`, stakeholderId: id, why: `Spoke about it on a call: "${h.line.slice(0, 110)}"`, sources: [id, ctx.src(h.path)] };
  });
}

function factSpeakers(ctx: Ctx, factIds: string[]): Ask[] {
  const out: Ask[] = [];
  for (const id of factIds) {
    const f = ctx.account.facts.find((x) => x.id === id);
    if (!f) continue;
    const s = ctx.stakeholderByName(f.said_by);
    out.push({ who: s ? `${s.name} (${s.role})` : f.said_by, stakeholderId: s?.id, why: `${f.said_by} said: "${f.text.slice(0, 120)}"`, sources: uniq([f.id, ...(s ? [s.id] : [])]) });
  }
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.who) ? false : (seen.add(a.who), true)));
}

export function buildGaps(inp: GapInputs): Gap[] {
  const { ctx, q1, q2, items, idle, force, deadlines } = inp;
  const A = ctx.account;
  const gaps: Gap[] = [];
  const push = (g: Gap) => gaps.push({ ...g, sources: uniq(g.sources) });
  const main = mainContact(ctx);
  const forceNames = ctx.forces;

  // ---- 1. what the profile itself says is not on file
  for (const [i, text] of ((ctx.profile?.not_on_file ?? []) as string[]).entries()) {
    const src = [ctx.src("profile.json")];
    const asks: Ask[] = [];
    let why = "The plan leans on people and facts that are not recorded.";
    if (/named contact at/i.test(text)) {
      const unit = forceNames.length ? "force" : "plant";
      why = `Without a named person at each ${unit}, the renewal and anything new depend on one person relaying for everyone.`;
      for (const f of forceNames) {
        const s = A.stakeholders.find((x) => x.role.toLowerCase().includes(f.toLowerCase()));
        if (s) asks.push(askStakeholder(ctx, s.name, `Holds a role at ${f} and spoke to us in the discovery session.`, A.facts.filter((x) => ctx.stakeholderByName(x.said_by)?.id === s.id).map((x) => x.id)));
      }
      if (main) asks.push(main);
    } else if (/procurement lead/i.test(text)) {
      why = "She said anything larger than this order needs a formal process and asked to be kept informed; nobody has.";
      if (main) asks.push({ ...main, why: `Was on the 16 Dec 2025 pilot review call with her and is the alliance contact. ${main.why}`, sources: [...main.sources, ctx.src("calls/2025-12-16_pilot_review.txt")] });
    } else if (/finance contact/i.test(text)) {
      why = "Each force's finance sign-off decides a call-off; nobody who signs is on file.";
      asks.push(...factSpeakers(ctx, A.facts.filter((f) => /finance/i.test(f.text) && /(sign|approve)/i.test(f.text)).map((f) => f.id)));
      const fin = A.stakeholders.find((s) => /finance/i.test(s.role) && !asks.some((a) => a.stakeholderId === s.id));
      if (fin) asks.push(askStakeholder(ctx, fin.name, `Finance role on file (${fin.role}).`, [fin.id]));
    } else if (/which dock sits at/i.test(text)) {
      why = "Without the dock-to-site list we cannot say which force or plant an idle dock belongs to, or build usage by site for finance or the insurer.";
      const calls = ctx.json<{ calls: any[] }>("calls_index.json")?.calls ?? [];
      for (const c of calls) for (const a of (c.actions ?? []) as string[]) {
        if (!/(install list|dock numbers and sites|dock-by-force|sites for each)/i.test(a)) continue;
        const s = (c.customer ?? []).map((n: string) => ctx.stakeholderByName(n)).find(Boolean);
        asks.push({ who: s ? `${s.name} (${s.role})` : (c.customer ?? [])[0] ?? "the customer", stakeholderId: s?.id, why: `Call action on ${c.date}: "${a}"`, sources: uniq([ctx.src("calls_index.json", c.date), ...(s ? [s.id] : [])]) });
      }
      if (main) asks.push(main);
    } else if (/deputy/i.test(text)) {
      why = "The customer-side knowledge of the rollout sits with one unnamed person.";
      asks.push(...whoSpokeAbout(ctx, /deputy/i));
      if (main) asks.push(main);
    } else if (/group finance|anyone in .*finance/i.test(text)) {
      why = "Group Finance asked for the renewal quote by plant and nobody replied; finance decides whether a projection counts as a saving.";
      const fin = A.stakeholders.find((s) => /finance/i.test(s.role));
      if (fin) asks.push(askStakeholder(ctx, fin.name, `Finance role on file (${fin.role}).`, [fin.id]));
    } else if (/\bIT\b/.test(text)) {
      why = "A dock at one plant keeps dropping offline and the customer's IT team has not looked at the link.";
      asks.push(...whoSpokeAbout(ctx, /\bIT\b/));
    } else if (main) asks.push(main);
    push({ id: `gap:profile:${i}`, kind: "unknown", title: text.replace(/\.$/, ""), whyItMatters: why, whoCouldFill: dedupeAsks(asks), sources: src });
  }

  // ---- 2. deciders and payers the power map could not name
  const unknowns = new Map<string, { entry: DealPower["entries"][number]; deals: string[] }>();
  for (const d of q2) for (const e of d.entries) {
    if (e.known || !(e.role === "decides" || e.role === "pays")) continue;
    if (/^Billed as set out/.test(e.who)) continue;
    const k = /^Unknown: budget holder for/.test(e.who) ? "pays:offer-budget" : `${e.role}:${e.who}`;
    const cur = unknowns.get(k) ?? { entry: e, deals: [] };
    cur.deals.push(d.title);
    unknowns.set(k, cur);
  }
  for (const [k, { entry, deals }] of unknowns) {
    const factIds = entry.sources.filter((s) => A.facts.some((f) => f.id === s));
    const asks = [...factSpeakers(ctx, factIds), ...(main ? [main] : [])];
    push({
      id: `gap:q2:${k}`, kind: "unknown", title: k === "pays:offer-budget" ? `Whose budget pays for the offers: ${deals.join("; ")}` : `${entry.role === "decides" ? "Who signs" : "Who pays"}: ${entry.who.replace(/^Unknown:\s*/, "")}`,
      whyItMatters: `${entry.why} It affects ${deals.slice(0, 3).join("; ")}${deals.length > 3 ? ` and ${deals.length - 3} more` : ""}.`,
      whoCouldFill: dedupeAsks(asks), sources: entry.sources,
    });
  }

  // ---- 3. deadlines with no exact date
  for (const u of deadlines.undated) {
    const tw = new Set(words(u.text).map(stem));
    const facts = A.facts.filter((f) => words(f.text).map(stem).filter((w) => w.length >= 5 && tw.has(w)).length >= 2).map((f) => f.id);
    push({
      id: `gap:undated:${u.text.slice(0, 20)}`, kind: "unknown", title: `Exact date: ${u.text}`,
      whyItMatters: "It is marked as coming up soon, so a move may have to land before it, but no date is recorded.",
      whoCouldFill: dedupeAsks(factSpeakers(ctx, facts)), sources: u.sources,
    });
  }
  for (const r of deadlines.relative) {
    push({
      id: `gap:relative:${r.factId}`, kind: "unknown", title: `Exact date of: ${r.text}`,
      whyItMatters: `We derived ${r.date} from "${r.phrase}" counted from the export date. Anything planned against it is only as good as that guess.`,
      whoCouldFill: dedupeAsks(factSpeakers(ctx, [r.factId])), sources: r.sources,
    });
  }

  // ---- 4. records that disagree: an open ticket vs a blocker marked cleared
  for (const it of items.filter((i) => i.kind === "ticket" && i.waitingOn === "us")) {
    const opp = A.opportunities.find((o) => o.blocker?.status === "cleared" && o.evidence.some((e) => it.sources.includes(e) || it.title.includes(e)));
    if (!opp) continue;
    const speakers = factSpeakers(ctx, opp.evidence.filter((e) => A.facts.some((f) => f.id === e)));
    const asks = [...(it.personId ? [askStakeholder(ctx, A.stakeholders.find((s) => s.id === it.personId)!.name, "Raised the request.", it.sources)] : []), ...speakers.filter((s) => /Suyal|SRV/i.test(s.who) || s.stakeholderId === it.personId)];
    push({
      id: `gap:reconcile:${it.id}`, kind: "unconfirmed", title: `Was it actually delivered? ${it.title} is still open, but "${opp.title}" shows its blocker as cleared`,
      whyItMatters: `The discovery record says the blocker is cleared, while the ticket record still shows it open and unassigned (${it.detail}). One of them is out of date, and ${opp.worth_up_to ? `a ${q1.currency} ${opp.worth_up_to.toLocaleString("en-GB")} deal` : "a deal"} rests on it.`,
      whoCouldFill: dedupeAsks(asks.length ? asks : speakers), sources: uniq([...it.sources, opp.id]),
    });
  }

  // ---- 5. what rests on someone's word with no file behind it, for deals that carry real value
  const valuable = q1.rows.filter((r) => r.type === "deal" && (r.backed || r.bucket === "projection") && r.value);
  const told = new Map<string, number>();
  for (const r of valuable) {
    const opp = A.opportunities.find((o) => o.id === r.id);
    for (const e of opp?.evidence ?? []) {
      const f = A.facts.find((x) => x.id === e);
      if (f && f.status !== "verified" && !deadlines.relative.some((x) => x.factId === f.id)) told.set(f.id, Math.max(told.get(f.id) ?? 0, r.value ?? 0));
    }
  }
  const topTold = [...told.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [id, value] of topTold) {
    const f = A.facts.find((x) => x.id === id)!;
    const dealTitles = valuable.filter((r) => A.opportunities.find((o) => o.id === r.id)?.evidence.includes(id)).map((r) => r.title);
    push({
      id: `gap:told:${id}`, kind: "unknown", title: `${f.status === "claim" ? "Only a claim" : "Told, no file"}: "${f.text}"`,
      whyItMatters: `${f.said_by}'s ${f.status === "claim" ? "claim" : "word"} is the evidence for ${dealTitles.join("; ")} (${q1.currency} ${value.toLocaleString("en-GB")}) and no file backs it.`,
      whoCouldFill: dedupeAsks(factSpeakers(ctx, [id])), sources: [id],
    });
  }

  // ---- 6. idle docks: why, and where
  if (idle) {
    const n = idle.byClass.never_flew.length + idle.byClass.went_quiet.length + idle.byClass.rarely.length;
    if (n > 0) push({
      id: "gap:idle-why", kind: "unknown", title: `Why do ${n} docks barely fly?`,
      whyItMatters: "The data shows that they do not fly, not why. The fix differs: no operator, no schedule, a connectivity fault, or no wish to fly.",
      whoCouldFill: dedupeAsks([...whoSpokeAbout(ctx, /\b(fly|flying|flew|usage)\b/i), ...(main ? [main] : [])]), sources: idle.sources,
    });
  }

  // ---- 7. a saving that has not been booked
  const roi = checkRoiSheet(ctx);
  if (roi && roi.bookedByFinance === 0) {
    const fin = A.stakeholders.find((s) => /finance/i.test(s.role));
    push({
      id: "gap:roi-booked", kind: "unknown", title: "Is any of the claimed saving real? No guard contract is reduced and finance has booked none",
      whyItMatters: `The ${roi.plantRows} plant rows sum to ${roi.sum.toLocaleString("en-GB")}, ${roi.contractReduced} show a guard contract reduced and ${roi.bookedByFinance} are booked by finance. Until finance sees a measured change, it is a projection.`,
      whoCouldFill: dedupeAsks([...(fin ? [askStakeholder(ctx, fin.name, `Finance role on file (${fin.role}); would confirm what is booked.`, [fin.id, roi.fileId])] : []), ...factSpeakers(ctx, A.facts.filter((f) => f.verified_by === roi.fileId).map((f) => f.id))]), sources: [roi.fileId],
    });
  }

  // ---- 8. the morning notes: unconfirmed, no record behind them
  for (const h of MORNING_NOTES[A.id] ?? []) {
    push({
      id: `gap:${h.id}`, kind: "unconfirmed_note", title: h.title, whyItMatters: `${h.text} ${h.whyItMatters}`,
      whoCouldFill: h.confirmWith.map((n) => askStakeholder(ctx, n, "Could confirm it directly.", [])), sources: ["notes:morning"],
    });
  }
  return gaps;
}

function dedupeAsks(asks: Ask[]): Ask[] {
  const seen = new Set<string>();
  return asks.filter((a) => (seen.has(a.who) ? false : (seen.add(a.who), true))).slice(0, 4);
}
