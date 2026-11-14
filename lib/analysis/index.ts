// Compose the five answers for each account from what the sync queue has stored.
import type { Bundle } from "../data.ts";
import type { Signal } from "../types.ts";
import { makeCtx } from "./ctx.ts";
import { overlaySignalRecords } from "./inline.ts";
import type { Ctx } from "./ctx.ts";
import { buildQ1 } from "./book.ts";
import { buildQ2 } from "./power.ts";
import { buildMoves } from "./moves.ts";
import { buildRisks } from "./risks.ts";
import { buildGaps } from "./gaps.ts";
import { contactTemperature, findDeadlines, findForceUsage, findIdleDocks, findOpenItems, singleThreaded, viewSignal } from "./detect.ts";
import { money } from "./util.ts";
import type { AccountAnalysis, SignalView } from "./types.ts";

export interface Analysis {
  ready: boolean;
  missing: string[];
  generatedAt: string;
  /**
   * "Today" for every date calculation. It is the later of the real clock and the latest live event's date,
   * because the scenario dates its events ahead of the real clock (e.g. 17 and 18 Nov).
   */
  clock: { real: string; world: string; shifted: boolean; because: string | null };
  accounts: AccountAnalysis[];
  /** every live event, including any that could not be tied to an account */
  signals: SignalView[];
}

/** Which account is a signal about? Explicit field first, then names, then the people it mentions. */
function attribute(sig: Signal, views: Map<string, SignalView>, ctxs: Ctx[]): string | null {
  const explicit = [(sig as any).account, (sig as any).account_id, (sig as any).accountId].find((v) => typeof v === "string" && ctxs.some((c) => c.account.id === v));
  if (explicit) return explicit as string;
  const text = JSON.stringify(sig).toLowerCase();
  const byName = ctxs.filter((c) => {
    const toks = c.account.name.toLowerCase().split(/\s+/).filter((t) => t.length > 5 && !["alliance", "group", "industrial", "counties", "eastern"].includes(t));
    return toks.some((t) => text.includes(t)) || text.includes(c.account.name.toLowerCase());
  });
  if (byName.length === 1) return byName[0].account.id;
  const people = ctxs.map((c) => ({ id: c.account.id, n: c.account.stakeholders.filter((s) => views.get(c.account.id)?.people.includes(s.id)).length }));
  const best = [...people].sort((a, b) => b.n - a.n);
  return best[0]?.n > 0 && best[0].n > (best[1]?.n ?? 0) ? best[0].id : null;
}

export function analyse(bundle: Bundle, now = new Date()): Analysis {
  const exp = bundle.accounts?.data;
  const missing: string[] = [];
  if (!exp) missing.push("get_my_accounts");
  const dated = bundle.signals.map((s) => ({ id: String((s as { id?: unknown }).id ?? ""), d: String((s as { dated?: unknown; date?: unknown }).dated ?? (s as { date?: unknown }).date ?? "").slice(0, 10) })).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d)).sort((a, b) => a.d.localeCompare(b.d));
  const latest = dated.at(-1);
  const worldMs = latest ? Date.parse(`${latest.d}T09:00:00Z`) : 0;
  const shifted = worldMs > now.getTime();
  const realNow = now;
  now = shifted ? new Date(worldMs) : now;
  const out: Analysis = {
    ready: false, missing, generatedAt: realNow.toISOString(), accounts: [], signals: [],
    clock: { real: realNow.toISOString(), world: now.toISOString(), shifted, because: shifted ? latest!.id : null },
  };
  if (!exp) return out;
  const paperwork = overlaySignalRecords(bundle.paperwork, bundle.signals); // records carried inline by live events
  for (const a of exp.accounts) if (!paperwork[a.id]?.length) missing.push(`get_all_paperwork ${a.id}`);
  if (missing.length) return out;

  const base = (accountId: string, signals: Signal[]) => {
    const account = exp.accounts.find((a) => a.id === accountId)!;
    const refs = exp.files.filter((f) => !f.account || f.account === accountId);
    return makeCtx({
      now, exportedAt: new Date(exp.exported_at), exportMinute: exp.minute, account, records: paperwork[accountId], fileRefs: refs,
      files: Object.fromEntries(refs.filter((f) => bundle.files[f.id] !== undefined).map((f) => [f.id, bundle.files[f.id]])), signals, team: bundle.team,
    });
  };
  const ctxs = exp.accounts.map((a) => base(a.id, bundle.signals));

  // attribute each signal to an account
  const bySignal = bundle.signals.map((sig) => {
    const views = new Map(ctxs.map((c) => [c.account.id, viewSignal(sig, c)]));
    const accountId = attribute(sig, views, ctxs);
    const view = { ...(views.get(accountId ?? ctxs[0].account.id)!), accountId };
    return { accountId, view };
  });
  out.signals = bySignal.map((s) => s.view);

  for (const ctx of ctxs) {
    const id = ctx.account.id;
    const signals = bySignal.filter((s) => s.accountId === id).map((s) => viewSignal(s.view.raw as Signal, ctx)).map((v) => ({ ...v, accountId: id }));
    const q1 = buildQ1(ctx);
    const items = findOpenItems(ctx);
    const idle = findIdleDocks(ctx);
    const force = findForceUsage(ctx);
    const deadlines = findDeadlines(ctx);
    const contacts = contactTemperature(ctx);
    const single = singleThreaded(ctx);
    const q2 = buildQ2(ctx, q1, force, items);
    const q3 = buildMoves({ ctx, q1, items, idle, force, deadlines, signals, single });
    const q4 = buildRisks({ ctx, q1, items, idle, force, contacts, single, deadlines, signals });
    const q5 = buildGaps({ ctx, q1, q2, items, idle, force, deadlines, signals });
    const cur = ctx.currency;
    const barely = idle ? idle.byClass.never_flew.length + idle.byClass.went_quiet.length + idle.byClass.rarely.length : null;
    out.accounts.push({
      id, name: ctx.account.name, currency: cur, asOf: now.toISOString(), dataAsOf: exp.exported_at, q1, q2, q3, q4, q5, signals,
      fleet: idle ? { total: idle.total, active: idle.byClass.active.length, rarely: idle.byClass.rarely.length, neverFlew: idle.byClass.never_flew.length, wentQuiet: idle.byClass.went_quiet.length, weeks: idle.weeks, sources: idle.sources } : null,
      termEnd: deadlines.termEnd,
      facts: [
        { label: "Backed", value: money(q1.totals.backed.amount, cur), sources: q1.totals.backed.sources },
        { label: "Unbacked", value: money(q1.totals.unbacked.amount, cur), sources: q1.totals.unbacked.sources },
        ...(deadlines.termEnd ? [{ label: "Term ends", value: deadlines.termEnd.date, sources: deadlines.termEnd.sources }] : []),
        ...(idle && barely !== null ? [{ label: "Docks barely flying", value: `${barely} of ${idle.total}`, sources: idle.sources }] : []),
        { label: "Open asks", value: String(items.length), sources: items.flatMap((i) => i.sources).slice(0, 12) },
      ],
    });
  }
  out.ready = true;
  return out;
}
