// Write-back: turn each account's top three next steps and top risks into write_note jobs.
// Pure planning only (no I/O). Duplicates are avoided three ways: a stable ref tag inside every note, what
// list_notes says is already there, and a local record of what we wrote (or tried to write).
import type { Job } from "./types.ts";
import type { Analysis } from "./analysis/index.ts";
import type { AccountAnalysis, Move, Risk } from "./analysis/types.ts";

export const REF_RE = /\[crm:ref:([a-z0-9]+)\]/;
export interface WrittenRec { status: "written" | "unknown"; at: string }
export type Written = Record<string, WrittenRec>;

const TOP_MOVES = 3;
const TOP_RISKS = 3;
const MAX_TEXT = 1500;

export function noteRef(accountId: string, kind: string, id: string): string {
  let h = 5381;
  for (const c of `${accountId}|${kind}|${id}`) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return `${h.toString(36)}${accountId.toLowerCase()}`;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function moveNote(a: AccountAnalysis, m: Move): Job {
  const ref = noteRef(a.id, "next_step", m.id);
  const lines = [
    `Owner: ${m.owner}${m.helpers.length ? ` (with ${m.helpers.join("; ")})` : ""}. Due: ${m.due}.`,
    `Moves: ${m.dealTitles.length ? m.dealTitles.join("; ") : "no deal linked"}.`,
    ...(m.insideDeadlines.length ? [`Inside: ${m.insideDeadlines.map((d) => `${d.label} ${d.date}${d.derived ? " (derived)" : ""}`).join("; ")}.`] : []),
    `Why: ${m.reasoning}`,
    ...m.detail.slice(0, 2).map((d) => `- ${clip(d, 220)}`),
    `Sources: ${m.sources.slice(0, 8).join(", ")}${m.sources.length > 8 ? ` (+${m.sources.length - 8} more)` : ""}.`,
  ];
  const tag = `[crm:ref:${ref}]`;
  return {
    tool: "write_note",
    args: { account: a.id, kind: "next_step", title: clip(`Next step ${m.rank}: ${m.title}`, 120), text: `${clip(lines.join("\n"), MAX_TEXT - tag.length - 1)}\n${tag}` },
    reason: `write back next step ${m.rank} for account ${a.id}`,
  };
}

function riskNote(a: AccountAnalysis, r: Risk): Job {
  const ref = noteRef(a.id, "risk", r.id);
  const when = r.turnsBadOn ? `${r.overdue ? "Turned bad" : "Turns bad"} on ${r.turnsBadOn.date}${r.turnsBadOn.derived ? ` (derived: ${r.turnsBadOn.how})` : ""}.` : "No date is known for when this turns bad.";
  const lines = [clip(r.detail, 700), when, `Sources: ${r.sources.slice(0, 8).join(", ")}.`];
  const tag = `[crm:ref:${ref}]`;
  return {
    tool: "write_note",
    args: { account: a.id, kind: "risk", title: clip(`Risk: ${r.title}`, 120), text: `${clip(lines.join("\n"), MAX_TEXT - tag.length - 1)}\n${tag}` },
    reason: `write back a top risk for account ${a.id}`,
  };
}

/** The risks worth writing back: highest severity first, already-bad ones winning ties. */
export function topRisks(a: AccountAnalysis): Risk[] {
  return [...a.q4].sort((x, y) => y.severity - x.severity || Number(y.overdue) - Number(x.overdue)).slice(0, TOP_RISKS);
}

export const refOf = (job: Job) => REF_RE.exec(String((job.args as { text?: string }).text ?? ""))?.[1] ?? null;

/**
 * Jobs still to write. `notesData` is whatever list_notes last returned (any shape); `notesAt` when we fetched it.
 * A ref already visible in list_notes, or recorded as written, is skipped. A write that failed ("unknown") is only
 * redone if a list_notes taken AFTER the failure still lacks it, so a timed-out write is never blindly repeated.
 */
export function planNotes(analysis: Analysis, notesData: unknown, notesAt: string | null, written: Written): Job[] {
  if (!analysis.ready) return [];
  const existing = JSON.stringify(notesData ?? "");
  const jobs: Job[] = [];
  for (const a of analysis.accounts) {
    const wanted: Job[] = [...a.q3.top.slice(0, TOP_MOVES).map((m) => moveNote(a, m)), ...topRisks(a).map((r) => riskNote(a, r))];
    for (const job of wanted) {
      const ref = refOf(job)!;
      if (existing.includes(`crm:ref:${ref}`)) continue;
      const w = written[ref];
      if (w?.status === "written") continue;
      if (w?.status === "unknown" && !(notesAt && notesAt > w.at)) continue;
      jobs.push(job);
    }
  }
  return jobs;
}
