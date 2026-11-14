"use client";
import type { ReactNode } from "react";
import { DAY_MS, LEVEL, cap, daysFrom, initials } from "./fmt";

/** A source id shown as a tag. Clicking opens the raw record or file behind it. */
export function Chip({ id, open }: { id: string; open: (id: string) => void }) {
  const label = id.replace(/^[A-Za-z0-9]+:(?=[^#]*[./])/, "");
  return (
    <button type="button" className="tag" title={`Open source: ${id}`} onClick={() => open(id)}>
      {label}
    </button>
  );
}

export function Chips({ ids, open, max = 8 }: { ids: string[]; open: (id: string) => void; max?: number }) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return null;
  const shown = uniq.slice(0, max);
  const rest = uniq.slice(max);
  return (
    <div className="tags" aria-label="Sources">
      {shown.map((id) => <Chip key={id} id={id} open={open} />)}
      {rest.length > 0 && (
        <details className="more">
          <summary className="tag tag-more">+{rest.length} more</summary>
          <div className="tags">{rest.map((id) => <Chip key={id} id={id} open={open} />)}</div>
        </details>
      )}
    </div>
  );
}

export function Badge({ tone, children, title, derived }: { tone?: "good" | "warn" | "bad" | "acc"; children: ReactNode; title?: string; derived?: boolean }) {
  return <span className={`badge ${tone ?? ""} ${derived ? "derived" : ""}`} title={title}>{children}</span>;
}

export function Fold({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="fold">
      <summary>{summary}</summary>
      <div className="fold-in">{children}</div>
    </details>
  );
}

/** "in 46 days" / "95 days ago" relative to a reference time. */
export function Rel({ date, asOf }: { date: string; asOf: string }) {
  const d = daysFrom(asOf, date);
  const txt = d === 0 ? "today" : d > 0 ? `in ${d} day${d === 1 ? "" : "s"}` : `${-d} day${d === -1 ? "" : "s"} ago`;
  return <span className="muted">{txt}</span>;
}

// ---------------------------------------------------------------- game-UI pieces
type IconName = "coin" | "party" | "flag" | "siren" | "fog" | "drone" | "scroll";
const PATHS: Record<IconName, ReactNode> = {
  coin: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9M9.5 10c0-1 1-1.6 2.5-1.6s2.5.6 2.5 1.6-1 1.5-2.5 1.8-2.5.8-2.5 1.8 1 1.6 2.5 1.6 2.5-.6 2.5-1.6" /></>,
  party: <><circle cx="8.5" cy="9" r="3" /><circle cx="16.5" cy="10" r="2.4" /><path d="M3.5 19c.4-3 2.4-4.6 5-4.6s4.6 1.6 5 4.6M14.5 14.8c2.6-.5 5 .9 5.6 4" /></>,
  flag: <><path d="M6 21V4" /><path d="M6 5h11l-2.4 3.6L17 12H6" /></>,
  siren: <><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4.5M12 17.4v.2" /></>,
  fog: <><circle cx="12" cy="12" r="8.5" /><path d="M9.4 9.6c.2-1.5 1.3-2.3 2.7-2.3 1.5 0 2.6.9 2.6 2.2 0 2-2.6 2-2.6 4M12 16.6v.2" /></>,
  drone: <><circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="18" r="2.4" /><rect x="9.5" y="9.5" width="5" height="5" rx="1.2" /><path d="M8 8l1.8 1.8M16 8l-1.8 1.8M8 16l1.8-1.8M16 16l-1.8-1.8" /></>,
  scroll: <><path d="M7 4h10a2 2 0 012 2v12a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2z" /><path d="M9 9h6M9 13h6M9 17h3" /></>,
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** Four pips for how a person stands with us: guarded, neutral, warm, ally. */
export function Standing({ level, label }: { level: string; label?: string }) {
  const n = LEVEL[level] ?? 0;
  return (
    <span className={`standing s${n}`} title={`Standing with us: ${level}`}>
      <span className="pips" aria-hidden="true">{[1, 2, 3, 4].map((i) => <i key={i} className={i <= n ? "on" : ""} />)}</span>
      <span className="standing-label">{label ?? cap(level)}</span>
    </span>
  );
}

/** Initials in a square; hatched with a question mark when we do not know who it is. */
export function Avatar({ name, level, unknown }: { name: string; level?: string; unknown?: boolean }) {
  if (unknown) return <span className="avatar unknown" aria-hidden="true">?</span>;
  return <span className={`avatar s${LEVEL[level ?? ""] ?? 0}`} aria-hidden="true">{initials(name)}</span>;
}

/** Gold, silver and bronze for the first three moves. */
export function Medal({ rank }: { rank: number }) {
  return <span className={`medal m${rank}`} role="img" aria-label={`Rank ${rank}`}>{rank}</span>;
}

/** A labelled stat bar. `pct` is 0..100. */
export function Meter({ label, value, pct, tone }: { label: string; value: string; pct: number; tone?: string }) {
  return (
    <div className={`meter ${tone ?? ""}`}>
      <div className="meter-top"><span>{label}</span><b>{value}</b></div>
      <div className="meter-track"><span className="meter-fill" style={{ ["--w" as string]: `${Math.max(2, Math.min(100, pct))}%` }} /></div>
    </div>
  );
}

export { DAY_MS };
