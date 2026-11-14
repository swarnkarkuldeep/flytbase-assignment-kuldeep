// Rules that read the paperwork and find things. Nothing here is hardcoded to an account:
// every finding comes from a record, file or signal and carries the ids it came from.
import type { Ctx } from "./ctx.ts";
import { words } from "./ctx.ts";
import { addDays, addMonths, daysBetween, findDateInText, iso, mentions, parseCsv, parseLongDate, uniq, ymd } from "./util.ts";
import { cleanForceMonthLog } from "./flightlog.ts";
import type { ForceMonth } from "./flightlog.ts";
import type { SignalView, SourceId } from "./types.ts";
import type { Signal } from "../types.ts";

// ---------------------------------------------------------------- thresholds (rules, not data)
export const RULES = {
  coldAfterDays: 60, // a contact with no contact for this long is "cold"
  renewalLeadDays: 60, // latest sensible start of a renewal, before term end
  dueBufferDays: 7, // a move's due date sits at least this far inside any deadline
  idleWeeks: 2, // latest N weekly rows with zero flights while online
  priorWeeks: 8, // window before that, used to tell "stopped" from "never really flew"
  regularPerWeek: 1.5, // prior mean at or above this means the dock used to fly regularly
  rarelyPerWeek: 1, // mean below this over the last priorWeeks means "rarely flies"
  minDaysOnline: 5,
  sla: { weOwe: 3, other: 7 }, // default days to act
};

// ---------------------------------------------------------------- open items
export interface OpenItem {
  id: string;
  kind: "email" | "ticket" | "request" | "followup" | "unexplored";
  title: string;
  from: string | null;
  personId?: string;
  since: string | null;
  ageDays: number | null;
  hasOwner: boolean;
  weOwe: boolean;
  waitingOn: "us" | "customer";
  detail: string;
  sources: SourceId[];
}

const NOT_DONE = /\b(not (?:yet )?(?:done|received|set up|started|answered|issued|sent|replied)|no further note|none recorded|still pending|no (?:quote|reply))\b/i;
const FLYTBASE_SENDER = /flytbase|support desk|^sam\b|customer success/i;
const ASKS = /\?|\b(can we|could you|please|i (?:will )?want|when can|where is|i need)\b/i;

interface Msg { from: string; to: string; date: Date | null; subject: string; body: string }

function parseThread(text: string): { msgs: Msg[]; trailer: string } {
  const parts = text.split(/\n---\n/);
  const msgs: Msg[] = [];
  let trailer = "";
  for (const part of parts) {
    const tr = /\[[^\]]*\]\s*$/.exec(part.trim());
    if (tr) trailer = tr[0];
    const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "mi").exec(part)?.[1]?.trim() ?? "";
    const from = get("From");
    if (!from) continue;
    const dm = get("Date");
    msgs.push({ from, to: get("To"), date: dm ? parseLongDate(dm) : null, subject: get("Subject").replace(/^RE:\s*/i, ""), body: part.split(/\n\n/).slice(1).join("\n\n") });
  }
  return { msgs, trailer };
}

export function findOpenItems(ctx: Ctx): OpenItem[] {
  const items: OpenItem[] = [];
  const A = ctx.account.id;
  const age = (d: string | null) => (d ? daysBetween(ymd(d), ctx.now) : null);
  const person = (name: string | null) => (name ? ctx.stakeholderByName(name)?.id : undefined);

  // 1. email threads nobody answered, or a customer ask that is still waiting
  for (const r of ctx.records.filter((r) => r.kind === "email" && r.text)) {
    const { msgs, trailer } = parseThread(r.text!);
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    const fromCustomer = !FLYTBASE_SENDER.test(last.from);
    const unanswered = /No reply/i.test(trailer) && !/Nobody asked/i.test(trailer);
    const unexplored = /Nobody asked/i.test(trailer);
    const waitingAsk = fromCustomer && ASKS.test(last.body) && !trailer;
    if (!(unanswered || unexplored || waitingAsk)) continue;
    const custMsg = [...msgs].reverse().find((m) => !FLYTBASE_SENDER.test(m.from)) ?? last;
    const dateStr = custMsg.date ? iso(custMsg.date) : (/(\d{4}-\d{2}-\d{2})/.exec(r.path)?.[1] ?? null);
    const fromName = custMsg.from.replace(/\s*\(.*?\)\s*/g, "").trim();
    items.push({
      id: `email:${r.path}`,
      kind: unexplored ? "unexplored" : "email",
      title: custMsg.subject || r.path,
      from: fromName,
      personId: person(fromName),
      since: dateStr, ageDays: age(dateStr),
      hasOwner: false,
      weOwe: !unexplored,
      waitingOn: "us",
      detail: unexplored
        ? `${fromName} asked a question; support answered and closed it. ${trailer.replace(/[\[\]]/g, "")}`
        : `${fromName} wrote on ${dateStr}: "${custMsg.body.trim().replace(/\s+/g, " ").slice(0, 160)}…" ${trailer ? trailer.replace(/[\[\]]/g, "") : "No reply on file."}`,
      sources: [ctx.src(r.path)],
    });
  }

  // 2. tickets that are not closed
  const tickets = ctx.json<{ tickets: any[] }>("tickets.json")?.tickets ?? [];
  // a held ticket-history file can name a requester the ticket record hides
  const ticketFile = new Map<string, { requester: string; account: string; fileId: string }>();
  for (const [fid, f] of Object.entries(ctx.files)) {
    const txt: string | undefined = f?.text;
    if (!txt || !/^ticket_id,/.test(txt)) continue;
    for (const r of parseCsv(txt)) ticketFile.set(r.ticket_id, { requester: r.requester, account: r.account, fileId: fid });
  }
  for (const t of tickets.filter((t) => t.status !== "Closed")) {
    const lastC = t.conversation?.[t.conversation.length - 1];
    const tf = ticketFile.get(t.id);
    const requesterLabel = tf && /details with the support desk|unknown/i.test(t.requester) ? `${tf.requester} (${tf.account})` : t.requester;
    const waitingOn: "us" | "customer" = /customer/i.test(t.status) ? "customer" : "us";
    const since = waitingOn === "us" ? t.opened : (lastC?.date ?? t.opened);
    items.push({
      id: `ticket:${t.id}`,
      kind: "ticket",
      title: `${t.id}: ${t.subject}`,
      from: requesterLabel,
      personId: person(t.requester) ?? stakeholderByRoleWords(ctx, tf ? tf.requester : t.requester),
      since, ageDays: age(since),
      hasOwner: !!t.assignee,
      weOwe: waitingOn === "us",
      waitingOn,
      detail: `${t.status}${t.assignee ? `, with ${t.assignee}` : ", no assignee (sits in the queue)"}. Opened ${t.opened}; last message ${lastC?.date} from ${lastC?.from}.${waitingOn === "customer" ? " Waiting on the customer; nothing sent since." : ""}`,
      sources: [ctx.src("tickets.json", t.id), ...(tf ? [tf.fileId] : [])],
    });
  }

  // 3. CS's own request list: attach to tickets/emails already found, else add
  for (const q of parseCsv(ctx.text("requests.csv"))) {
    if (/^closed$/i.test(q.status ?? "")) continue;
    const src = ctx.src("requests.csv", q.request_id && q.request_id !== "(none)" ? q.request_id : q.opened + ":" + q.from);
    const byId = items.find((i) => i.id === `ticket:${q.request_id}`);
    const byMail = items.find((i) => i.kind !== "ticket" && i.since === q.opened && nameOverlap(i.from ?? "", q.from));
    const target = byId ?? byMail;
    if (target) { target.sources = uniq([...target.sources, src]); continue; }
    items.push({
      id: `request:${q.request_id}:${q.opened}`, kind: "request",
      title: q.summary, from: q.from, personId: person(q.from), since: q.opened, ageDays: age(q.opened),
      hasOwner: !!q.owner, weOwe: true, waitingOn: /customer/i.test(q.status) ? "customer" : "us",
      detail: `${q.status}${q.owner ? `, owner ${q.owner}` : ", no owner"}. ${q.summary}`, sources: [src],
    });
  }

  // 4. call follow-ups marked as not done
  const calls = ctx.json<{ calls: any[] }>("calls_index.json")?.calls ?? [];
  for (const c of calls) {
    for (const action of (c.actions ?? []) as string[]) {
      if (!NOT_DONE.test(action)) continue;
      const clean = action.replace(/\s*\([^)]*\)\s*$/, "").trim();
      const custName = (c.customer ?? []).find((n: string) => action.toLowerCase().startsWith(n.toLowerCase()) || action.toLowerCase().includes(`from ${n.toLowerCase()}`));
      const weOwe = !custName;
      const cp = custName ?? (c.customer ?? [])[0] ?? null;
      const dup = items.find((i) => similar(i.title + " " + i.detail, clean, ctx));
      const src = ctx.src("calls_index.json", c.date);
      if (dup) { dup.sources = uniq([...dup.sources, src, ...(c.path ? [ctx.src(c.path)] : [])]); continue; }
      items.push({
        id: `followup:${c.date}:${clean.slice(0, 30)}`, kind: "followup", title: clean, from: cp, personId: person(cp),
        since: c.date, ageDays: age(c.date), hasOwner: true, weOwe, waitingOn: weOwe ? "us" : "customer",
        detail: `Follow-up from the ${c.date} ${c.title.toLowerCase()}: "${action}"`,
        sources: [src, ...(c.path ? [ctx.src(c.path)] : [])],
      });
    }
  }
  return items.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
}

function nameOverlap(a: string, b: string) {
  const wa = words(a), wb = new Set(words(b));
  return wa.some((w) => wb.has(w));
}
const GENERIC = new Set(["customer", "handover", "contact", "account", "another", "meeting"]);
const stem = (w: string) => w.replace(/ies$/, "y").replace(/s$/, "");
function similar(existing: string, action: string, _ctx: Ctx) {
  const a = new Set(words(action).map(stem).filter((w) => w.length >= 4));
  const e = new Set(words(existing).map(stem));
  const shared = [...a].filter((w) => e.has(w));
  // two shared words, or one distinctive long word (e.g. "stadium", "install")
  return shared.length >= 2 || shared.some((w) => w.length >= 7 && !GENERIC.has(w));
}
const ALIASES: Record<string, string> = { dpo: "data protection officer" };
function stakeholderByRoleWords(ctx: Ctx, label: string): string | undefined {
  let l = label.toLowerCase();
  for (const [k, v] of Object.entries(ALIASES)) l = l.replace(new RegExp(`\\b${k}\\b`), v);
  const cand = ctx.account.stakeholders.filter((s) => {
    const title = s.role.split(",")[0].toLowerCase();
    const place = (s.role.split(",")[1] ?? "").trim().toLowerCase();
    return l.includes(title) && (!place || l.includes(place));
  });
  return cand.length === 1 ? cand[0].id : undefined;
}

// ---------------------------------------------------------------- idle docks
export type DockClass = "never_flew" | "went_quiet" | "rarely" | "active";
export interface DockStat { dockId: string; cls: DockClass; totalFlights: number; lastFlight: string | null; recent: number[]; priorMean: number; mean: number }
export interface IdleDocks {
  total: number;
  byClass: Record<DockClass, DockStat[]>;
  weeks: [string, string];
  flightsThrough: string | null;
  lastSeenOnline: string | null;
  sources: SourceId[];
}

export function findIdleDocks(ctx: Ctx): IdleDocks | null {
  const usage = parseCsv(ctx.text("usage_weekly.csv"));
  if (!usage.length) return null;
  const flights = parseCsv(ctx.text("flights.csv"));
  const weeks = uniq(usage.map((u) => u.week_start)).sort();
  const docks = uniq(usage.map((u) => u.dock_id));
  const lastFlightBy = new Map<string, string>();
  for (const f of flights) if (!lastFlightBy.has(f.dock_id) || f.date > lastFlightBy.get(f.dock_id)!) lastFlightBy.set(f.dock_id, f.date);
  const R = RULES;
  const recentW = weeks.slice(-R.idleWeeks);
  const priorW = weeks.slice(-(R.idleWeeks + R.priorWeeks), -R.idleWeeks);
  const last8 = weeks.slice(-R.priorWeeks);
  const cell = (d: string, w: string) => usage.find((u) => u.dock_id === d && u.week_start === w);
  const mean = (d: string, ws: string[]) => (ws.length ? ws.reduce((s, w) => s + Number(cell(d, w)?.flights ?? 0), 0) / ws.length : 0);
  const byClass: IdleDocks["byClass"] = { never_flew: [], went_quiet: [], rarely: [], active: [] };
  for (const d of docks) {
    const total = weeks.reduce((s, w) => s + Number(cell(d, w)?.flights ?? 0), 0);
    const recent = recentW.map((w) => Number(cell(d, w)?.flights ?? 0));
    const onlineEnough = recentW.every((w) => Number(cell(d, w)?.days_online ?? 0) >= R.minDaysOnline);
    const priorMean = mean(d, priorW);
    let cls: DockClass = "active";
    if (total === 0) cls = "never_flew";
    else if (onlineEnough && recent.every((n) => n === 0) && priorMean >= R.regularPerWeek) cls = "went_quiet";
    else if (mean(d, last8) < R.rarelyPerWeek) cls = "rarely";
    byClass[cls].push({ dockId: d, cls, totalFlights: total, lastFlight: lastFlightBy.get(d) ?? null, recent, priorMean: round1(priorMean), mean: round1(mean(d, last8)) });
  }
  const devices = ctx.json<{ docks: any[] }>("devices.json")?.docks ?? [];
  const seen = devices.map((x) => x.last_seen_online as string).filter(Boolean).sort();
  return {
    total: docks.length, byClass, weeks: [recentW[0], recentW[recentW.length - 1]],
    flightsThrough: flights.length ? flights.map((f) => f.date).sort().at(-1)! : null,
    lastSeenOnline: seen.at(-1) ?? null,
    sources: [ctx.src("usage_weekly.csv"), ctx.src("flights.csv"), ctx.src("devices.json")],
  };
}
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- force-by-force usage (from a held file)
export interface ForceUsage {
  force: string;
  latest: ForceMonth;
  peak: ForceMonth;
  everLive: boolean;
  note: string;
}
export interface ForceUsageResult { rows: ForceMonth[]; forces: ForceUsage[]; dropped: { raw: string; reason: string }[]; fileId: string }

export function findForceUsage(ctx: Ctx): ForceUsageResult | null {
  for (const [id, f] of Object.entries(ctx.files)) {
    const text: string | undefined = f?.text;
    if (!text || !/docks_with_live_flights/.test(text.split("\n")[0])) continue;
    const { rows, dropped } = cleanForceMonthLog(text, ctx.forces);
    const forces: ForceUsage[] = [];
    for (const force of uniq(rows.map((r) => r.force))) {
      const mine = rows.filter((r) => r.force === force);
      const latest = mine[mine.length - 1];
      const peak = [...mine].sort((a, b) => (b.docksLive ?? 0) - (a.docksLive ?? 0))[0];
      const everLive = mine.some((r) => (r.docksLive ?? 0) > 0);
      let note = "";
      if (!everLive) note = (mine.some((r) => /training|trg/i.test(r.notes)) || mine.every((r) => (r.trainingFlights ?? 0) > 0)) ? "training flights only, no live missions" : "no live missions in any month";
      else if ((latest.docksLive ?? 0) < (peak.docksLive ?? 0)) note = `down from ${peak.docksLive} live docks in ${peak.month}`;
      forces.push({ force, latest, peak, everLive, note });
    }
    return { rows, forces, dropped, fileId: id };
  }
  return null;
}

// ---------------------------------------------------------------- contacts
export interface ContactTemp {
  stakeholderId: string; name: string;
  lastContact: string | null; lastContactHow: string | null;
  lastWeReached: string | null;
  coldOn: string | null;
  daysSince: number | null;
  state: "unknown" | "ok" | "cooling" | "cold";
  sources: SourceId[];
}

export function contactTemperature(ctx: Ctx): ContactTemp[] {
  const calls = ctx.json<{ calls: any[] }>("calls_index.json")?.calls ?? [];
  const mail = ctx.json<{ mail: any[] }>("mail_log.json")?.mail ?? [];
  const onFile = (ctx.profile?.contacts_on_file ?? []) as any[];
  return ctx.account.stakeholders.map((s) => {
    const hits: { date: string; how: string; reach: boolean; src: string }[] = [];
    for (const c of calls) if ((c.customer ?? []).some((n: string) => mentions(n, s.name) && ctx.stakeholderByName(n)?.id === s.id)) hits.push({ date: c.date, how: `call: ${c.title}`, reach: true, src: ctx.src("calls_index.json", c.date) });
    for (const m of mail.filter((m) => m.kind === "person")) {
      const fromThem = ctx.stakeholderByName(String(m.from).replace(/\s*\(.*\)/, ""))?.id === s.id;
      const toThem = ctx.stakeholderByName(String(m.to).replace(/\s*\(.*\)/, ""))?.id === s.id;
      if (fromThem || toThem) hits.push({ date: m.date, how: `email ${fromThem ? "from" : "to"} them: ${m.subject}`, reach: toThem, src: ctx.src("mail_log.json", m.thread) });
    }
    for (const f of ctx.account.facts) {
      if (ctx.stakeholderByName(f.said_by)?.id !== s.id) continue;
      const when = new Date(ctx.exportedAt.getTime() - (ctx.exportMinute - f.learned_at_minute) * 60_000);
      hits.push({ date: iso(when), how: "spoke to us in the discovery session", reach: true, src: f.id });
    }
    const fileRow = onFile.find((o) => o.id === s.id);
    if (fileRow?.last_contact_before_handover) hits.push({ date: fileRow.last_contact_before_handover, how: "profile: last contact before handover", reach: false, src: ctx.src("profile.json") });
    hits.sort((a, b) => b.date.localeCompare(a.date));
    const last = hits[0];
    const reached = hits.find((h) => h.reach);
    if (!last) return { stakeholderId: s.id, name: s.name, lastContact: null, lastContactHow: null, lastWeReached: null, coldOn: null, daysSince: null, state: "unknown" as const, sources: [s.id] };
    const coldOn = addDays(ymd(last.date), RULES.coldAfterDays);
    const days = daysBetween(ymd(last.date), ctx.now);
    return {
      stakeholderId: s.id, name: s.name, lastContact: last.date, lastContactHow: last.how, lastWeReached: reached?.date ?? null,
      coldOn: iso(coldOn), daysSince: days,
      state: ctx.now >= coldOn ? "cold" as const : daysBetween(ctx.now, coldOn) <= 14 ? "cooling" as const : "ok" as const,
      sources: uniq([s.id, last.src]),
    };
  });
}

/** Who has been on every customer-side call since the current CSM started? */
export function singleThreaded(ctx: Ctx): { who: string; since: string; calls: number; sources: SourceId[] } | null {
  const calls = ctx.json<{ calls: any[] }>("calls_index.json")?.calls ?? [];
  const csm = (ctx.profile?.flytbase_side?.csm ?? [])[0];
  if (!csm?.from) return null;
  const from = `${csm.from}-01`;
  const recent = calls.filter((c) => c.date >= from);
  const names = uniq(recent.flatMap((c) => (c.customer ?? []) as string[]));
  if (recent.length >= 3 && names.length === 1) return { who: names[0], since: csm.from, calls: recent.length, sources: [ctx.src("calls_index.json"), ctx.src("profile.json")] };
  return null;
}

// ---------------------------------------------------------------- dates
export interface Deadlines {
  termEnd: { date: string; sources: SourceId[] } | null;
  renewalValue: number | null;
  renewalLead: { date: string; how: string; sources: SourceId[] } | null;
  /** "in five months" style phrases in facts, turned into dates */
  relative: { factId: string; phrase: string; date: string; how: string; text: string; sources: SourceId[] }[];
  /** deadlines the data states without a date */
  undated: { dealId: string | null; text: string; soon?: boolean; passed?: boolean; met?: boolean; sources: SourceId[] }[];
}

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

export function findDeadlines(ctx: Ctx): Deadlines {
  const contract = ctx.text("contract.txt");
  const m = /Term:.*?\bto\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i.exec(contract);
  const fromContract = m ? parseLongDate(m[1]) : null;
  const fromProfile = ctx.profile?.renewal?.term_ends ? ymd(ctx.profile.renewal.term_ends) : null;
  const end = fromContract ?? fromProfile;
  const termEnd = end ? { date: iso(end), sources: [ctx.src("contract.txt"), ...(fromProfile ? [ctx.src("profile.json")] : [])] } : null;
  const relative: Deadlines["relative"] = [];
  for (const f of ctx.account.facts) {
    const r = /\b(?:in|within)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(week|month)s?\b/i.exec(f.text);
    if (!r || !/review|deadline|window|closes|due|renew|audit/i.test(f.text)) continue;
    const n = NUM[r[1].toLowerCase()] ?? Number(r[1]);
    const date = r[2].toLowerCase() === "month" ? addMonths(ctx.exportedAt, n) : addDays(ctx.exportedAt, 7 * n);
    relative.push({
      factId: f.id, phrase: r[0], date: iso(date), text: f.text,
      how: `"${r[0]}" said by ${f.said_by}, counted from the export date ${iso(ctx.exportedAt)}`,
      sources: [f.id, "export:exported_at"],
    });
  }
  const undated: Deadlines["undated"] = [];
  for (const d of ctx.account.deadlines ?? []) undated.push({ dealId: null, text: d.text, passed: d.passed, sources: [ctx.account.id] });
  for (const o of ctx.account.opportunities) {
    if (o.deadline) undated.push({ dealId: o.id, text: o.deadline.text, soon: o.deadline.soon, passed: o.deadline.passed, met: o.deadline.met, sources: [o.id] });
  }
  // the same text can appear on the account and on the deal: keep the deal-linked one
  const seen = new Set<string>();
  const dedup = undated.sort((a, b) => (a.dealId ? 0 : 1) - (b.dealId ? 0 : 1)).filter((u) => (seen.has(u.text) ? false : (seen.add(u.text), true)));
  return {
    termEnd,
    renewalValue: ctx.profile?.renewal?.annual_value ?? null,
    renewalLead: termEnd ? { date: iso(addDays(ymd(termEnd.date), -RULES.renewalLeadDays)), how: `${RULES.renewalLeadDays} days before the term ends (rule)`, sources: termEnd.sources } : null,
    relative, undated: dedup,
  };
}

// ---------------------------------------------------------------- signals
const DATE_KEYS = ["date", "at", "created_at", "timestamp", "time", "when", "ts", "occurred_at", "logged_at"];
function flattenStrings(v: unknown, out: string[] = [], key = ""): string[] {
  if (typeof v === "string") { if (!/^(id|signal_id|event_id|key|type|kind|account|account_id|accountId|date|at|created_at|timestamp|time|when|ts|occurred_at|logged_at)$/.test(key)) out.push(v); }
  else if (typeof v === "number") { if (/count|days|hours/i.test(key)) out.push(`${key}: ${v}`); }
  else if (Array.isArray(v)) v.forEach((x) => flattenStrings(x, out, key));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) flattenStrings(x, out, k);
  return out;
}

export function viewSignal(sig: Signal, ctx: Ctx): SignalView {
  const parts = flattenStrings(sig);
  const text = parts.join(" · ");
  let date: string | null = null;
  for (const k of DATE_KEYS) {
    const v = (sig as any)[k];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) { date = v.slice(0, 10); break; }
    if (typeof v === "number") { date = new Date(v > 1e12 ? v : v * 1000).toISOString().slice(0, 10); break; }
  }
  if (!date) { const d = findDateInText(text, ctx.now); if (d) date = iso(d); }
  const people = ctx.account.stakeholders.filter((s) => mentions(text, s.name)).map((s) => s.id);
  const key = signalViewKey(sig);
  return { key, text, date, accountId: null, people, raw: sig, sources: [`signal:${key}`] };
}
export function signalViewKey(sig: Signal): string {
  const id = (sig as any).id ?? (sig as any).signal_id ?? (sig as any).event_id;
  return id !== undefined ? String(id) : String(Math.abs(hash(JSON.stringify(sig))));
}
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
