// Q1: what is the book worth? Backed vs unbacked, never one headline total.
//
// Rules:
//   closed     stage agreed/cleared, or an offer that is won           -> backed
//   evidenced  open deal whose AMOUNT appears in a contract, invoice,   -> backed (value evidenced, outcome not yet won)
//              profile or deal history we hold
//   open_offer an offer pitched but not won                             -> unbacked (no customer commitment)
//   projection an open deal whose amount is in no hard record           -> unbacked
//   claim_only something only a person said, no value or document       -> unbacked, listed apart
import type { Ctx } from "./ctx.ts";
import { words } from "./ctx.ts";
import { money, parseCsv, uniq } from "./util.ts";
import type { BookRow, Q1, SourceId } from "./types.ts";

type Amounts = Map<number, SourceId[]>;

/** Every amount that appears in a hard record (contract, invoices, profile, deal history). */
function hardAmounts(ctx: Ctx): Amounts {
  const m: Amounts = new Map();
  const add = (n: unknown, src: SourceId) => {
    const v = typeof n === "number" ? n : NaN;
    if (!Number.isFinite(v) || v <= 0) return;
    m.set(v, uniq([...(m.get(v) ?? []), src]));
  };
  for (const hit of ctx.text("contract.txt").match(/\d{1,3}(?:,\d{3})+|\b\d{5,}\b/g) ?? []) add(Number(hit.replace(/,/g, "")), ctx.src("contract.txt"));
  add(ctx.profile?.renewal?.annual_value, ctx.src("profile.json"));
  const dh = ctx.json<any>("deal_history.json");
  for (const h of dh?.history ?? []) add(h.value, ctx.src("deal_history.json"));
  for (const h of dh?.on_file_as_open_at_handover ?? []) add(h.value, ctx.src("deal_history.json"));
  const inv = ctx.json<any>("invoices.json");
  add(inv?.first_year_total, ctx.src("invoices.json"));
  for (const i of inv?.invoices ?? []) add(i.amount, ctx.src("invoices.json", i.number));
  return m;
}

/** Computed checks on a ROI-style spreadsheet (guard hours the drones *could* replace). */
export interface RoiCheck { fileId: string; plantRows: number; sum: number; stated: number | null; gap: number | null; contractReduced: number; bookedByFinance: number; note: string }
export function checkRoiSheet(ctx: Ctx): RoiCheck | null {
  for (const [id, f] of Object.entries(ctx.files)) {
    const text: string | undefined = f?.text;
    if (!text || !/saving_eur/.test(text.split("\n")[0]) || !/contract_reduced/.test(text.split("\n")[0])) continue;
    const rows = parseCsv(text);
    const plants = rows.filter((r) => /^plant\s+\d+/i.test(r.plant ?? ""));
    const sum = plants.reduce((s, r) => s + (Number(r.saving_eur) || 0), 0);
    const totalRow = rows.find((r) => /^total/i.test(r.plant ?? ""));
    const stated = totalRow ? Number(totalRow.saving_eur) || null : null;
    return {
      fileId: id, plantRows: plants.length, sum, stated, gap: stated !== null ? stated - sum : null,
      contractReduced: plants.filter((r) => /^yes/i.test(r.contract_reduced ?? "")).length,
      bookedByFinance: plants.filter((r) => (r.booked_by_finance ?? "") !== "").length,
      note: rows.find((r) => /^note/i.test(r.plant ?? ""))?.guard_hours_replaceable_per_year ?? "",
    };
  }
  return null;
}

function backingFor(ctx: Ctx, evidence: string[]): BookRow["backing"] {
  const out: BookRow["backing"] = [];
  for (const id of evidence) {
    const fact = ctx.account.facts.find((f) => f.id === id);
    if (fact) {
      const files = fact.verified_by ? [fact.verified_by] : [];
      out.push({ label: `${fact.said_by} (${fact.status}${fact.verified_by ? `, backed by file ${fact.verified_by}` : ""}): "${fact.text}"`, sources: [fact.id, ...files] });
      continue;
    }
    const file = ctx.fileRefs.find((f) => f.id === id);
    if (file) out.push({ label: `File: ${file.title}`, sources: [file.id] });
    else out.push({ label: id, sources: [id] });
  }
  return out;
}

const topicOf = (id: string) => id.replace(/_\d+$/, "");

export function buildQ1(ctx: Ctx): Q1 {
  const hard = hardAmounts(ctx);
  const rows: BookRow[] = [];
  const A = ctx.account;
  const cur = ctx.currency;
  const nameOf = (id: string) => A.facts.find((f) => f.id === id)?.said_by;

  const qualifiers = (evidence: string[]) => {
    const out: NonNullable<BookRow["qualifiedBy"]> = [];
    for (const id of evidence) {
      const f = A.facts.find((x) => x.id === id);
      if (f?.status !== "claim") continue;
      for (const other of A.facts.filter((x) => x.id !== f.id && topicOf(x.id) === topicOf(f.id) && x.status !== "claim"))
        out.push({ text: `${other.said_by} (${other.status}): "${other.text}"`, sources: [other.id, ...(other.verified_by ? [other.verified_by] : [])] });
    }
    return out;
  };

  // ----- export opportunities
  for (const o of A.opportunities) {
    const value = o.worth_up_to ?? null;
    const closed = o.stage === "agreed" || o.stage === "cleared";
    const matched = value !== null ? hard.get(value) : undefined;
    let bucket: BookRow["bucket"];
    if (closed) bucket = "closed";
    else if (value === null) bucket = "claim_only";
    else if (matched) bucket = "evidenced";
    else bucket = "projection";
    const backing = backingFor(ctx, o.evidence);
    if (closed) backing.unshift({ label: `Stage "${o.stage}" in the discovery record`, sources: [o.id] });
    if (matched && bucket === "evidenced") backing.unshift({ label: `The amount ${money(value!, cur)} appears in the contract/records we hold`, sources: matched });
    const people = uniq(o.evidence.map(nameOf).filter((x): x is string => !!x));
    let note = o.blocker ? `Blocker (${o.blocker.status}): ${o.blocker.text}` : undefined;
    if (bucket === "projection" || bucket === "claim_only") note = `${note ? note + ". " : ""}${value === null ? "No value on record." : "This amount is not in any contract, invoice or letter we hold."}`;
    const onFile = (ctx.json<any>("deal_history.json")?.on_file_as_open_at_handover ?? []).find((h: any) => words(h.what).some((w) => w.length >= 6 && words(o.title).includes(w)));
    if (onFile && (bucket === "claim_only" || bucket === "projection")) {
      backing.push({ label: `On file at handover: ${onFile.basis}`, sources: [ctx.src("deal_history.json")] });
    }
    rows.push({
      id: o.id, title: o.title, type: "deal", value, stage: o.stage, bucket, backed: bucket === "closed" || bucket === "evidenced",
      backing, people, note, qualifiedBy: qualifiers(o.evidence), sources: uniq([o.id, ...o.evidence]),
    });
  }

  // ----- offers
  const declined: Q1["declined"] = [];
  for (const of of A.offers ?? []) {
    const pitch = of.pitch_to ? ctx.stakeholderByName(of.pitch_to) : undefined;
    const src = uniq([of.id, ...(pitch ? [pitch.id] : [])]);
    if (of.status === "declined") { declined.push({ id: of.id, title: of.title, value: of.value, pitchTo: of.pitch_to ?? null, sources: src }); continue; }
    const won = of.status === "won";
    rows.push({
      id: of.id, title: of.title, type: "offer", value: of.value, stage: of.status, bucket: won ? "closed" : "open_offer", backed: won,
      backing: [{ label: won ? `Offer won (pitched to ${of.pitch_to ?? "n/a"})` : `Pitched to ${of.pitch_to ?? "n/a"}; the customer has not committed`, sources: src }],
      people: of.pitch_to ? [of.pitch_to] : [], note: won ? undefined : "Pitched, not won: no customer commitment on file.", sources: src,
    });
  }

  // ----- deals the paperwork holds that the export does not list (e.g. the renewal on an account whose export has none)
  const dh = ctx.json<any>("deal_history.json");
  for (const h of dh?.on_file_as_open_at_handover ?? []) {
    const hw = words(h.what).filter((w) => w.length >= 6);
    const covered = A.opportunities.some((o) => (h.value != null && o.worth_up_to === h.value) || words(o.title).some((w) => hw.includes(w)));
    if (covered) continue;
    const matched = h.value != null ? hard.get(h.value) : undefined;
    const sources = uniq([ctx.src("deal_history.json"), ...(matched ?? []), ...(/contract/i.test(h.basis ?? "") ? [ctx.src("contract.txt")] : [])]);
    const hwL = words(h.what).filter((w) => w.length >= 6);
    const claimFacts = A.facts.filter((f) => words(f.text).some((w) => hwL.includes(w)));
    const mail = ctx.records.filter((r) => r.kind === "email" && r.text && hwL.some((w) => r.text!.toLowerCase().includes(w))).map((r) => ctx.src(r.path));
    rows.push({
      id: ctx.src("deal_history.json", h.what.slice(0, 24)), title: h.what, type: "deal", value: h.value ?? null,
      stage: h.due ? `due ${h.due}` : "on file", bucket: h.value != null && matched ? "evidenced" : "claim_only", backed: h.value != null && !!matched,
      backing: [{ label: `On file at handover: ${h.basis}`, sources }, ...claimFacts.map((f) => ({ label: `${f.said_by} (${f.status}): "${f.text}"`, sources: [f.id] })), ...mail.map((m) => ({ label: "Email on file", sources: [m] }))],
      people: uniq(claimFacts.map((f) => f.said_by)), qualifiedBy: qualifiers(claimFacts.map((f) => f.id)), note: h.due ? `Term ends ${h.due}; no automatic renewal, a new order is needed.` : undefined, sources,
    });
  }

  // ----- computed ROI check: attach to the row whose evidence names the spreadsheet
  const roi = checkRoiSheet(ctx);
  if (roi) {
    const row = rows.find((r) => r.sources.includes(roi.fileId) || r.sources.some((s) => A.facts.find((f) => f.id === s)?.verified_by === roi.fileId));
    if (row) {
      row.note = `${row.note ? row.note + " " : ""}Computed from ${roi.fileId}: the ${roi.plantRows} plant rows sum to ${money(roi.sum, cur)}; the stated total is ${roi.stated !== null ? money(roi.stated, cur) : "n/a"} (gap ${roi.gap !== null ? money(roi.gap, cur) : "n/a"}, explained in the sheet as rounding and a plant with no row). ${roi.contractReduced} of ${roi.plantRows} rows show a guard contract reduced; ${roi.bookedByFinance} are booked by finance.`;
      row.sources = uniq([...row.sources, roi.fileId]);
    }
  }

  // ----- totals
  const sum = (bs: BookRow["bucket"][]) => {
    const rs = rows.filter((r) => bs.includes(r.bucket) && r.value != null);
    // an empty bucket cites every row that was classified, so a zero is justified rather than bare
    return { amount: rs.reduce((s, r) => s + (r.value ?? 0), 0), sources: (rs.length ? rs : rows).map((r) => r.id) };
  };
  const closed = sum(["closed"]), evidenced = sum(["evidenced"]), openOffers = sum(["open_offer"]), projection = sum(["projection"]);

  // ----- context: money already under contract
  const signed = (dh?.history ?? []).find((h: any) => /order form signed/i.test(h.what));
  const inForce = signed?.value
    ? { label: `Contract in force: ${signed.detail}`, amount: signed.value as number, period: "a year", sources: uniq([ctx.src("contract.txt"), ctx.src("deal_history.json"), ctx.src("invoices.json")]) }
    : null;

  // ----- documented customer-side savings: verified facts that state a yearly figure and name a file
  const evidencedSavings: Q1["evidencedSavings"] = [];
  for (const f of A.facts) {
    const m = f.status === "verified" && f.verified_by ? /([\d,]{5,})\s*(?:euros|pounds|dollars)?\s*a year/i.exec(f.text) : null;
    if (m && /saving|premium|cut|reduc/i.test(f.text)) evidencedSavings.push({ label: `${f.said_by}: "${f.text}"`, amount: Number(m[1].replace(/,/g, "")), period: "a year", sources: [f.id, f.verified_by!] });
  }

  // ----- claims only
  const claimsOnly: Q1["claimsOnly"] = A.facts.filter((f) => f.status === "claim").map((f) => ({
    id: f.id, text: f.text, saidBy: f.said_by,
    qualifiedBy: A.facts.filter((x) => x.id !== f.id && topicOf(x.id) === topicOf(f.id) && x.status !== "claim")
      .map((x) => ({ text: `${x.said_by} (${x.status}): "${x.text}"`, sources: [x.id, ...(x.verified_by ? [x.verified_by] : [])] })),
    sources: [f.id],
  }));

  const backedAmt = closed.amount + evidenced.amount;
  const unbackedAmt = openOffers.amount + projection.amount;
  return {
    currency: cur, rows, declined,
    totals: {
      closed, evidenced,
      backed: { amount: backedAmt, sources: uniq([...(closed.amount ? closed.sources : []), ...(evidenced.amount ? evidenced.sources : [])]).length ? uniq([...(closed.amount ? closed.sources : []), ...(evidenced.amount ? evidenced.sources : [])]) : closed.sources },
      openOffers, projection,
      unbacked: { amount: unbackedAmt, sources: uniq([...(openOffers.amount ? openOffers.sources : []), ...(projection.amount ? projection.sources : [])]).length ? uniq([...(openOffers.amount ? openOffers.sources : []), ...(projection.amount ? projection.sources : [])]) : openOffers.sources },
    },
    inForce, evidencedSavings, claimsOnly,
  };
}
