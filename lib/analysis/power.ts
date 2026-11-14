// Q2: who holds the power? For each deal: who decides, pays, uses, could block, and where they stand with us.
// There is no decider/payer field in the data, so every assignment is derived from roles, facts and paperwork,
// marked "derived" and shown with the ids it rests on. Where nobody is on file we say "Unknown: <title>".
import type { Ctx } from "./ctx.ts";
import { words } from "./ctx.ts";
import type { ForceUsageResult, OpenItem } from "./detect.ts";
import { uniq } from "./util.ts";
import type { BookRow, DealPower, PowerEntry, Q1, SourceId } from "./types.ts";
import type { Stakeholder } from "../types.ts";

const SIGN = /\b(sign|signs|signed off|sign-off|approve|approval)\b/i;
const FIN = /(chief finance officer|finance director|\bcfo\b|call-off|finance sign-off)/i;
const USER_ROLE = /(inspector|unit|operator|plant manager)/i;
const NOT_USER = /(finance|data protection|insurance|controller)/i;

const possessive = (n: string) => (n.endsWith("s") ? `${n}'` : `${n}'s`);

function stakeholderEntry(ctx: Ctx, s: Stakeholder, role: PowerEntry["role"], why: string, sources: SourceId[], basis: PowerEntry["basis"] = "derived"): PowerEntry {
  return { role, who: `${s.name} (${s.role})`, stakeholderId: s.id, known: true, relationship: s.relationship, basis, why, sources: uniq([s.id, ...sources]) };
}
const unknown = (role: PowerEntry["role"], title: string, why: string, sources: SourceId[], basis: PowerEntry["basis"] = "derived"): PowerEntry => ({ role, who: `Unknown: ${title}`, known: false, basis, why, sources: uniq(sources) });

/** People whose label (e.g. "Group Finance") matches exactly one stakeholder's role words. */
function stakeholderByLabel(ctx: Ctx, label: string): Stakeholder | undefined {
  const lt = words(label.replace(/aldermoor|industrial|group|shared|mailbox/gi, (m) => (/group/i.test(m) ? "group" : "")));
  const toks = uniq([...lt, ...(/group/i.test(label) ? ["group"] : [])]);
  if (toks.length < 2) return undefined;
  const hits = ctx.account.stakeholders.filter((s) => toks.every((t) => words(s.role).includes(t) || s.role.toLowerCase().includes(t)));
  return hits.length === 1 ? hits[0] : undefined;
}

export function buildQ2(ctx: Ctx, q1: Q1, force: ForceUsageResult | null, items: OpenItem[]): DealPower[] {
  const A = ctx.account;
  const byId = new Map(A.stakeholders.map((s) => [s.id, s]));

  // ---- account-wide sign-off facts (who must approve spend)
  const signs: { who: string; why: string; sources: SourceId[] }[] = [];
  for (const f of A.facts) {
    if (!(SIGN.test(f.text) && FIN.test(f.text))) continue;
    const title = /chief finance officer/i.test(f.text) ? "chief finance officer" : /finance director/i.test(f.text) ? "finance director" : null;
    let who: string;
    if (title && /^\s*(his|her)\b/i.test(f.text)) who = `${possessive(f.said_by)} ${title}`;
    else if (title && /\beach\b/i.test(f.text)) who = ctx.forces.length ? `each member force's ${title}` : `each unit's ${title}`;
    else who = ctx.forces.length ? "each member force's finance sign-off" : "finance sign-off";
    const prior = signs.find((s) => s.who === who);
    if (prior) prior.sources = uniq([...prior.sources, f.id]);
    else signs.push({ who, why: `${f.said_by} (${f.status}): "${f.text}"`, sources: [f.id] });
  }

  // ---- how money moves: contract invoicing + budget facts
  const contract = ctx.text("contract.txt");
  const inv = /Invoicing\s*\n((?:-[^\n]*\n?)+)/.exec(contract)?.[1]?.split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean) ?? [];
  const budget = A.facts.find((f) => /\bown budget\b|\bbudget\b/i.test(f.text) && /\beach\b/i.test(f.text) && f.status !== "claim");
  const signed = /Signed:\s*[^,\n]+,\s*by\s+([^\n]+)/i.exec(contract)?.[1]?.replace(/\.$/, "").trim();
  const signer = signed ? A.stakeholders.find((s) => signed.toLowerCase().includes(s.name.toLowerCase().replace(/^insp\.\s*/, ""))) : undefined;

  // ---- users on file
  const users = ctx.json<any>("users.json")?.users ?? [];
  const operators = users.filter((u: any) => /operator/i.test(u.role));
  const accountUsers = A.stakeholders.filter((s) => USER_ROLE.test(s.role) && !NOT_USER.test(s.role));

  const dealsOf = (rows: BookRow[]) => rows.filter((r) => r.type !== "claim");
  return dealsOf(q1.rows).map((row): DealPower => {
    const opp = A.opportunities.find((o) => o.id === row.id);
    const offer = (A.offers ?? []).find((o) => o.id === row.id);
    const evidence = opp?.evidence ?? [];
    const evFacts = A.facts.filter((f) => evidence.includes(f.id));
    const pitch = offer?.pitch_to ? ctx.stakeholderByName(offer.pitch_to) : undefined;
    const isRenewal = /renew/i.test(row.title);
    const entries: PowerEntry[] = [];

    // connected people: who spoke to this deal, who it was pitched to, who is named in its evidence/blocker
    const connected = new Map<string, Stakeholder>();
    for (const f of evFacts) { const s = ctx.stakeholderByName(f.said_by); if (s) connected.set(s.id, s); }
    if (pitch) connected.set(pitch.id, pitch);
    const blockerText = opp?.blocker?.text ?? "";
    for (const s of A.stakeholders) {
      const title = s.role.split(",")[0].toLowerCase();
      if (title.length > 4 && [blockerText, ...evFacts.map((f) => f.text)].some((t) => t.toLowerCase().includes(title))) connected.set(s.id, s);
    }

    // ----- decides
    if (offer && pitch && offer.status === "won") entries.push(stakeholderEntry(ctx, pitch, "decides", `The offer was won; it was pitched to ${pitch.name}, who accepted it.`, [offer.id]));
    else if (offer && pitch) entries.push(stakeholderEntry(ctx, pitch, "decides", `Pitched to ${pitch.name}. No record says ${pitch.name} can sign it, so treat as the buyer we are talking to, not a confirmed signer.`, [offer.id]));
    if (!offer && signs.length) {
      const lead = signs.find((s) => /\beach\b/.test(s.who)) ?? signs[0];
      entries.push(unknown("decides", lead.who.replace(/^each/, "each"), signs.map((s) => s.why).join(" | ") + ". No one with that title is on file.", signs.flatMap((s) => s.sources)));
    }
    if (isRenewal && signer) entries.push(stakeholderEntry(ctx, signer, "decides", `Signed the current order (contract.txt: "by ${signed}"). The renewal needs a new order before the term ends.`, [ctx.src("contract.txt")], "stated"));
    else if (isRenewal && signed) entries.push(unknown("decides", `${signed} (signed the current order; not a named person)`, `Signed the current order (contract.txt).`, [ctx.src("contract.txt")], "stated"));
    const closest = [...connected.values()].sort((a, b) => Number(USER_ROLE.test(a.role)) - Number(USER_ROLE.test(b.role))).slice(0, 2);
    const speaks = (s: Stakeholder) => evFacts.filter((f) => ctx.stakeholderByName(f.said_by)?.id === s.id).map((f) => f.id);
    if (!entries.some((e) => e.role === "decides" && e.known)) {
      for (const s of closest) {
        if (entries.some((e) => e.stakeholderId === s.id && e.role === "decides")) continue;
        const caveat = signs.length ? ` But spend needs sign-off from ${signs[0].who}.` : " No record says they can sign.";
        entries.push(stakeholderEntry(ctx, s, "decides", `Closest owner on file, not a confirmed signer: ${s.name} supplied this deal's evidence.${caveat}`, speaks(s)));
      }
    }
    if (!entries.some((e) => e.role === "decides")) entries.push(unknown("decides", "who signs this", "No record names a signer.", [row.id]));

    // ----- pays
    if (offer && pitch) entries.push(unknown("pays", `budget holder for ${pitch.name}'s purchase`, "No record says whose budget pays for this offer.", [offer.id]));
    else {
      if (budget) entries.push(unknown("pays", "each force, from its own budget", `${budget.said_by} (${budget.status}): "${budget.text}"`, [budget.id]));
      if (inv.length) entries.push({ role: "pays", who: "Billed as set out in the contract", known: false, basis: "stated", why: `Invoicing section of the contract summary: ${inv.join(" ")}`, sources: [ctx.src("contract.txt")] });
      if (!entries.some((e) => e.role === "pays")) entries.push(unknown("pays", "who pays", "No record says who pays.", [row.id]));
    }

    // ----- uses
    const usersHere = [...connected.values()].filter((s) => USER_ROLE.test(s.role) && !NOT_USER.test(s.role));
    const pool = usersHere.length ? usersHere : accountUsers;
    for (const s of pool) entries.push(stakeholderEntry(ctx, s, "uses", `Runs the docks day to day (${s.role}).`, [...evFacts.filter((f) => ctx.stakeholderByName(f.said_by)?.id === s.id).map((f) => f.id)]));
    if (isRenewal && operators.length) entries.push({ role: "uses", who: `${operators.length} operators on file (names not recorded)`, known: false, basis: "derived", why: `${operators.length} logins with role "operator"; ${operators.reduce((n: number, u: any) => n + (u.sign_ins_last_90_days ?? 0), 0)} sign-ins in the last 90 days.`, sources: [ctx.src("users.json")] });
    if (!entries.some((e) => e.role === "uses")) entries.push(unknown("uses", "who uses this", "No record names the users.", [row.id]));

    // ----- blocks
    for (const s of connected.values()) {
      if (s.relationship === "guarded") entries.push(stakeholderEntry(ctx, s, "blocks", `Relationship is "guarded" in the discovery record, so ${s.name} could stall this.`, []));
    }
    for (const f of evFacts.concat(A.facts.filter((x) => /(has not signed off|cannot be signed|not signed)/i.test(x.text)))) {
      if (!/(has not signed off|cannot be signed|until we receive)/i.test(f.text)) continue;
      const s = A.stakeholders.find((st) => f.text.toLowerCase().includes(st.role.split(",")[0].toLowerCase())) ?? ctx.stakeholderByName(f.said_by);
      if (s && (opp?.evidence.includes(f.id) || connected.has(s.id))) {
        const cleared = opp?.blocker?.status === "cleared";
        entries.push(stakeholderEntry(ctx, s, "blocks", `${f.said_by} (${f.status}): "${f.text}"${cleared ? ` The deal's blocker is marked cleared in the discovery record, but sign-off itself is not on file.` : ""}`, [f.id]));
      }
    }
    if (isRenewal) {
      // gatekeepers: customer-side asks about the renewal that nobody answered
      for (const it of items) {
        if (!(it.kind === "email" && /renew/i.test(it.title + it.detail))) continue;
        const s = it.personId ? byId.get(it.personId) : stakeholderByLabel(ctx, it.from ?? "");
        const label = it.from ?? "customer";
        if (s) entries.push({ ...stakeholderEntry(ctx, s, "blocks", `${label} asked on ${it.since} for the renewal quote in a different form before a renewal is raised; no reply on file (unsigned, so it is not confirmed who wrote it).`, it.sources) });
        else entries.push(unknown("blocks", label, `Asked on ${it.since} for something before a renewal is raised; no reply on file.`, it.sources));
      }
      if (force) {
        const dead = force.forces.filter((f) => !f.everLive);
        if (dead.length) entries.push(unknown("blocks", `${dead.map((d) => d.force).join(" and ")} (no live missions)`, `The force-by-force flight log shows no live missions at ${dead.map((d) => d.force).join(" or ")} in any month; their chief finance officers have little usage to approve spend against.`, [force.fileId]));
      }
    }
    if (opp?.blocker?.status === "open" && !entries.some((e) => e.role === "blocks" && e.known)) {
      const owners = closest.filter((s) => !USER_ROLE.test(s.role) && !entries.some((e) => e.stakeholderId === s.id && e.role === "blocks"));
      for (const s of owners) entries.push(stakeholderEntry(ctx, s, "blocks", `Open blocker: "${opp.blocker.text}". ${s.name} is the closest person on file to it; no record says who controls it.`, [opp.id, ...speaks(s)]));
      if (!owners.length) entries.push(unknown("blocks", "owner of the open blocker", `Open blocker: ${opp.blocker.text}. No record says who controls it.`, [opp.id]));
    }
    if (!entries.some((e) => e.role === "blocks")) entries.push({ role: "blocks", who: "No one identified", known: true, basis: "derived", why: "No guarded contact is connected to this deal and no record names an objection.", sources: [row.id] });

    const clean = entries.some((e) => e.role === "blocks" && e.who !== "No one identified") ? entries.filter((e) => e.who !== "No one identified") : entries;
    return { dealId: row.id, title: row.title, value: row.value, stage: row.stage, entries: dedupe(clean) };
  });
}

function dedupe(es: PowerEntry[]): PowerEntry[] {
  const seen = new Set<string>();
  return es.filter((e) => (seen.has(e.role + e.who) ? false : (seen.add(e.role + e.who), true)));
}
