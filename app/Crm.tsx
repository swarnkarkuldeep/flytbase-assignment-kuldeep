"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Analysis } from "@/lib/analysis/index";
import type { AccountAnalysis, SignalView } from "@/lib/analysis/types";
import type { Status } from "@/lib/sync";
import { Q1View, Q2View, Q3View, Q4View, Q5View } from "./sections";
import { Badge, Chips, Icon } from "./ui";
import { ago, daysFrom, money } from "./fmt";

interface StateResp {
  status: Status;
  analysis: Analysis;
  held: { records: Record<string, number>; files: number; signals: number; signalsAt: string | null; dataAsOf: string | null; notes: { kind: string | null; account: string | null; title: string }[] };
}
interface SourceResp { id: string; kind: string; title: string; content: unknown; pending?: boolean; error?: string }

const POLL_MS = 20_000;
const GAP_S = 61;

export default function Crm() {
  const [data, setData] = useState<StateResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  // optional ?q=3 shows a single question (useful for a focused demo)
  const [only, setOnly] = useState<number | null>(null);
  useEffect(() => {
    const q = Number(new URLSearchParams(window.location.search).get("q"));
    if (q >= 1 && q <= 5) setOnly(q);
  }, []);
  // theme: auto follows the system; light/dark override it. Stored only as a per-viewer convenience.
  const [theme, setTheme] = useState<"auto" | "light" | "dark">("auto");
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("theme");
      const saved = q ?? window.localStorage.getItem("aq-theme");
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch { /* storage may be blocked */ }
  }, []);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "auto") el.removeAttribute("data-theme"); else el.setAttribute("data-theme", theme);
    try { window.localStorage.setItem("aq-theme", theme); } catch { /* ignore */ }
  }, [theme]);
  const stateAt = useRef(Date.now());
  const seen = useRef<Set<string> | null>(null);
  const inflight = useRef(false);

  // ---- poll: ask the server to make its next queued call (it decides if one is due), then read the stored state
  const tick = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      await fetch("/api/sync", { cache: "no-store" }).catch(() => undefined);
      const r = await fetch("/api/state", { cache: "no-store" });
      if (!r.ok) throw new Error(`state ${r.status}`);
      const j = (await r.json()) as StateResp;
      setData(j);
      stateAt.current = Date.now();
      setErr(null);
      const keys = (j.analysis.signals ?? []).map((s) => s.key);
      if (seen.current === null) seen.current = new Set(keys);
      else {
        const add = keys.filter((k) => !seen.current!.has(k));
        if (add.length) { add.forEach((k) => seen.current!.add(k)); setFresh((f) => new Set([...f, ...add])); }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not reach the server");
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    tick();
    const poll = setInterval(tick, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const vis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(poll); clearInterval(clock); document.removeEventListener("visibilitychange", vis); };
  }, [tick]);

  // ---- remember the tab (hash first, then storage); both optional
  useEffect(() => {
    try {
      const raw = window.location.hash.replace("#", "");
      const h = /^[A-Za-z0-9_-]{1,12}$/.test(raw) && !/^q[1-5]$/.test(raw) ? raw : ""; // #q3 is a jump link, not a tab
      const saved = h || window.localStorage.getItem("aq-tab") || "";
      if (saved) setTab(saved);
    } catch { /* storage may be blocked */ }
  }, []);
  const pick = (id: string) => {
    setTab(id);
    try { window.history.replaceState(null, "", `#${id}`); window.localStorage.setItem("aq-tab", id); } catch { /* ignore */ }
  };

  const analysis = data?.analysis;
  const accounts = analysis?.ready ? analysis.accounts : [];
  const current: AccountAnalysis | undefined = accounts.find((a) => a.id === tab) ?? accounts[0];
  const st = data?.status;
  const nextIn = st ? Math.max(0, st.nextCallInSec - Math.floor((now - stateAt.current) / 1000)) : null;
  const lastCall = st?.lastCallAt ?? null;
  const cooldownPct = st ? (st.dry ? 0 : nextIn === 0 ? 100 : ((GAP_S - (nextIn ?? GAP_S)) / GAP_S) * 100) : 0;
  const queued = st ? st.pending.filter((p) => p.reason !== "poll").length : 0;

  return (
    <>
      <header className="hud">
        <div className="hud-in">
          <div className="brand">
            <span className="brand-mark"><Icon name="drone" size={22} /></span>
            <span className="brand-name">Account CRM</span>
            <button type="button" className="btn small" onClick={() => setTheme(theme === "auto" ? "light" : theme === "light" ? "dark" : "auto")} aria-label={`Theme: ${theme}. Click to change.`} title="Switch between system, light and dark">
              {theme === "auto" ? "Theme: auto" : theme === "light" ? "Theme: light" : "Theme: dark"}
            </button>
          </div>
          <div className="telemetry" role="status" aria-live="polite">
            {err ? (
              <span className="cell bad"><i className="led err" />Offline: {err}. Showing the last data.</span>
            ) : st ? (
              <>
                <span className="cell"><i className={`led ${busy ? "busy" : ""}`} /><span><small>Link</small><b>{busy ? "syncing" : "live"}</b></span></span>
                <span className="cell cool">
                  <span><small>Next MCP call</small><b>{st.dry ? "paused" : nextIn === 0 ? "ready" : `${nextIn}s`}</b></span>
                  <span className="cool-bar" aria-hidden="true"><i style={{ width: `${cooldownPct}%` }} /></span>
                </span>
                <span className="cell"><span><small>Last call</small><b>{ago(lastCall, now)}</b></span></span>
                <span className="cell"><span><small>Queued</small><b>{queued}</b></span></span>
                <span className="cell"><span><small>Calls made</small><b>{st.calls}</b></span></span>
              </>
            ) : (
              <span className="cell"><i className="led busy" />Connecting…</span>
            )}
          </div>
        </div>
        {(accounts.length > 0 || (analysis?.pending.length ?? 0) > 0) && (
          <div className="hud-in select" role="tablist" aria-label="Accounts">
            {accounts.map((a) => (
              <button key={a.id} role="tab" type="button" className="tile" aria-selected={a.id === current?.id} onClick={() => pick(a.id)}>
                <span className="tile-letter">{a.id}</span>
                <span className="tile-text">
                  <b>{a.name}</b>
                  <small>{money(a.q1.totals.closed.amount, a.currency)} closed, {money(a.q1.totals.unbacked.amount, a.currency)} unbacked</small>
                </span>
              </button>
            ))}
            {(analysis?.pending ?? []).map((p) => (
              <div key={p.id} className="tile pending" role="status" title={`Waiting for: ${p.waitingFor.join(", ")}`}>
                <span className="tile-letter">{p.id}</span>
                <span className="tile-text">
                  <b>{p.name ?? `New account ${p.id}`}</b>
                  <small>New account: fetching its data</small>
                </span>
              </div>
            ))}
          </div>
        )}
      </header>

      <div className="shell">
        {current && <Rail a={current} />}
        <main className="stage">
          {!data && !err && <p className="banner">Loading the CRM…</p>}
          {err && !data && <p className="banner bad">Could not load: {err}</p>}
          {data && !analysis?.ready && (
            <div className="banner">
              <b>Syncing.</b> Waiting for {analysis?.missing.join(", ") || "data"}. The server makes one call a minute, and this page fills in by itself.
              {st && st.pending.length > 0 && <div className="small">Queue: {st.pending.slice(0, 6).map((p) => p.tool + (p.args.account ? ` ${p.args.account}` : "")).join(", then ")}</div>}
            </div>
          )}

          {current && (
            <>
              <Banner a={current} dataAsOf={data?.held.dataAsOf ?? null} open={setSrc} />
              <LiveEvents
                signals={[...current.signals, ...(analysis?.signals ?? []).filter((s) => s.accountId === null)]}
                fresh={fresh}
                open={setSrc}
                unattributedKeys={new Set((analysis?.signals ?? []).filter((s) => s.accountId === null).map((s) => s.key))}
                dismiss={() => setFresh(new Set())}
                checkedAt={st?.lastCallAt ?? null}
                now={now}
              />
              {(!only || only === 1) && <Q1View a={current} open={setSrc} />}
              {(!only || only === 2) && <Q2View a={current} open={setSrc} />}
              {(!only || only === 3) && <Q3View a={current} open={setSrc} />}
              {(!only || only === 4) && <Q4View a={current} open={setSrc} />}
              {(!only || only === 5) && <Q5View a={current} open={setSrc} />}
              {!only && <WrittenBack notes={(data?.held.notes ?? []).filter((n) => n.account === current.id || n.account === null)} pending={(st?.pending ?? []).filter((p) => p.tool === "write_note" && p.args.account === current.id).length} paused={st?.writeback === "paused"} />}
              <p className="foot">
                Everything here is computed by rules from the stored MCP data; no model writes any of it. Open any tag to see the raw record or file behind a number.
                Discovery data as of {data?.held.dataAsOf?.slice(0, 16).replace("T", " ")} UTC.
                {current.clock.shifted
                  ? ` For this account, today is treated as ${current.clock.world.slice(0, 10)}, the date of its latest live event (${current.clock.because}); the real date is ${current.clock.real.slice(0, 10)}.`
                  : ` Analysis run at ${current.asOf.slice(11, 16)} UTC.`}
              </p>
            </>
          )}
        </main>
      </div>
      {src && <Drawer id={src} close={() => setSrc(null)} />}
    </>
  );
}

/** The side rail doubles as a quest log: where to jump, and what is waiting in each section. */
function Rail({ a }: { a: AccountAnalysis }) {
  const over = a.q4.filter((r) => r.overdue).length;
  const unknowns = a.q5.filter((g) => g.kind !== "unconfirmed_note").length;
  const items: { href: string; icon: Parameters<typeof Icon>[0]["name"]; label: string; badge: string; tone?: string }[] = [
    { href: "#q1", icon: "coin", label: "Book", badge: `${money(a.q1.totals.closed.amount, a.currency)} closed` },
    { href: "#q2", icon: "party", label: "Power", badge: `${a.q2.length} deals` },
    { href: "#q3", icon: "flag", label: "First moves", badge: `${a.q3.top.length}`, tone: "gold" },
    { href: "#q4", icon: "siren", label: "Risks", badge: over ? `${over} late` : `${a.q4.length}`, tone: over ? "bad" : undefined },
    { href: "#q5", icon: "fog", label: "Unknowns", badge: `${unknowns}` },
  ];
  return (
    <nav className="rail" aria-label="Jump to a question">
      {items.map((i) => (
        <a key={i.href} href={i.href} className="rail-item">
          <Icon name={i.icon} size={18} />
          <span className="rail-label">{i.label}</span>
          <span className={`rail-badge ${i.tone ?? ""}`}>{i.badge}</span>
        </a>
      ))}
    </nav>
  );
}

function Banner({ a, dataAsOf, open }: { a: AccountAnalysis; dataAsOf: string | null; open: (id: string) => void }) {
  const t = a.q1.totals;
  const total = t.closed.amount + t.evidenced.amount + t.unbacked.amount;
  const closedPct = total ? (t.closed.amount / total) * 100 : 0;
  const evidPct = total ? (t.evidenced.amount / total) * 100 : 0;
  const days = a.termEnd ? daysFrom(a.asOf, a.termEnd.date) : null;
  const asks = a.facts.find((f) => f.label === "Open asks");
  const f = a.fleet;
  const segs: string[] = f ? [...Array(f.active).fill("a"), ...Array(f.rarely).fill("r"), ...Array(f.neverFlew).fill("n"), ...Array(f.wentQuiet).fill("q")] : [];
  return (
    <div className="banner-wrap">
      <div className="title-row">
        <h1>{a.name}</h1>
        <p className="sub">Account {a.id}. Amounts in {a.currency}.{dataAsOf ? ` Discovery data as of ${dataAsOf.slice(0, 10)}.` : ""}</p>
      </div>
      <div className="gauges">
        <section className="gauge wide" aria-label="Book">
          <header><h2>Book</h2><span className="hint">no headline total</span></header>
          <div className="split" role="img" aria-label={`Closed ${money(t.closed.amount, a.currency)}, in the contract but not yet won ${money(t.evidenced.amount, a.currency)}, unbacked ${money(t.unbacked.amount, a.currency)}`}>
            <span className="split-closed" style={{ ["--w" as string]: `${closedPct}%` }} />
            <span className="split-evid" style={{ ["--w" as string]: `${evidPct}%` }} />
          </div>
          <div className="legend">
            <span><i className="sw closed" /> <b>{money(t.closed.amount, a.currency)}</b> closed</span>
            <span><i className="sw evid" /> <b>{money(t.evidenced.amount, a.currency)}</b> in the contract, not yet won</span>
            <span><i className="sw unbacked" /> <b>{money(t.unbacked.amount, a.currency)}</b> unbacked</span>
          </div>
          <Chips ids={[...t.closed.sources.slice(0, 2), ...t.evidenced.sources.slice(0, 1), ...t.unbacked.sources.slice(0, 1)]} open={open} max={4} />
        </section>

        {f && (
          <section className="gauge" aria-label="Fleet">
            <header><h2>Fleet</h2><span className="hint">{f.total} docks</span></header>
            <div className="fleet" role="img" aria-label={`${f.active} flying, ${f.rarely} rarely, ${f.neverFlew} never flew, ${f.wentQuiet} stopped`}>
              {segs.map((k, i) => <i key={i} className={`seg ${k}`} style={{ ["--d" as string]: `${i * 12}ms` }} />)}
            </div>
            <div className="legend">
              <span><i className="sw a" /> <b>{f.active}</b> flying</span>
              <span><i className="sw r" /> <b>{f.rarely}</b> rarely</span>
              <span><i className="sw n" /> <b>{f.neverFlew}</b> never</span>
              {f.wentQuiet > 0 && <span><i className="sw q" /> <b>{f.wentQuiet}</b> stopped</span>}
            </div>
            <Chips ids={f.sources} open={open} max={2} />
          </section>
        )}

        <section className="gauge" aria-label="Clocks">
          <header><h2>Clocks</h2></header>
          <div className="clock">
            {a.termEnd ? (
              <div className="clock-main">
                <b>{days}</b><span>days to term end<br /><small>{a.termEnd.date}</small></span>
              </div>
            ) : <div className="muted small">No term end on file.</div>}
            {asks && <div className="clock-sub"><b>{asks.value}</b> open asks nobody has closed</div>}
          </div>
          <Chips ids={[...(a.termEnd?.sources ?? []), ...(asks?.sources.slice(0, 2) ?? [])]} open={open} max={3} />
        </section>
      </div>
    </div>
  );
}

function LiveEvents({ signals, fresh, open, unattributedKeys, dismiss, checkedAt, now }: {
  signals: SignalView[]; fresh: Set<string>; open: (id: string) => void; unattributedKeys: Set<string>; dismiss: () => void; checkedAt: number | null; now: number;
}) {
  const has = signals.length > 0;
  return (
    <aside className={`feed ${has ? "has" : ""} ${fresh.size ? "fresh" : ""}`} aria-label="Live events">
      <header>
        <span className={`beacon ${has ? "on" : ""}`} aria-hidden="true" />
        <h2>Live events</h2>
        {has && <Badge tone="bad">{signals.length}</Badge>}
        {fresh.size > 0 && <button type="button" className="btn small" onClick={dismiss}>Mark as seen</button>}
      </header>
      {!has && <p className="empty">Quiet so far. The server checks for new events every minute (last check {ago(checkedAt, now)}), and they will appear here without a reload.</p>}
      {signals.map((s) => (
        <div className="event" key={s.key}>
          <div className="event-head">
            {fresh.has(s.key) && <span className="new">new</span>}
            <b>{s.date ?? "undated"}</b>
            {unattributedKeys.has(s.key) && <Badge tone="warn">not tied to an account</Badge>}
            <Chips ids={s.sources} open={open} />
          </div>
          {s.title && <p className="event-title">{s.title}</p>}
          <p>{s.text}</p>
        </div>
      ))}
    </aside>
  );
}

function WrittenBack({ notes, pending, paused }: { notes: { kind: string | null; title: string }[]; pending: number; paused: boolean }) {
  return (
    <section className="win" aria-label="Written back to the MCP">
      <header className="win-bar">
        <span className="hex"><Icon name="scroll" size={16} /></span>
        <h2>Notes this CRM has written to the MCP</h2>
      </header>
      <p className="win-answer">The top three next steps and top risks are saved with <code>write_note</code> through the same one-call-a-minute queue, once each. {paused ? <b>Write-back is paused, so nothing is being written.</b> : pending > 0 ? `${pending} still queued.` : "Nothing waiting."}</p>
      <div className="win-body">
        {notes.length === 0 ? <p className="empty">None written yet.</p> : (
          <ul className="list">{notes.map((n, i) => <li key={i}>{n.kind && <Badge tone={n.kind === "risk" ? "warn" : "acc"}>{n.kind.replace("_", " ")}</Badge>} {n.title}</li>)}</ul>
        )}
      </div>
    </section>
  );
}

function Drawer({ id, close }: { id: string; close: () => void }) {
  const [res, setRes] = useState<SourceResp | null>(null);
  const [loading, setLoading] = useState(true);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setRes(null);
    fetch(`/api/source?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => live && setRes(j))
      .catch((e) => live && setRes({ id, kind: "error", title: "Could not load", content: String(e), error: String(e) }))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    btn.current?.focus();
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [close]);

  const body = res?.content;
  const text = typeof body === "string" ? body : typeof (body as { text?: unknown })?.text === "string" && Object.keys(body as object).every((k) => ["id", "name", "text"].includes(k)) ? ((body as { text: string }).text) : JSON.stringify(body, null, 2);
  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Source record">
        <header>
          <div>
            <div className="drawer-title">{loading ? "Loading…" : res?.error ? "Not found" : res?.title}</div>
            <div className="drawer-id">{id}</div>
            <div className="badges">{res?.kind && !res.error && <Badge>{res.kind}</Badge>} {res?.pending && <Badge tone="warn">not fetched yet</Badge>}</div>
          </div>
          <button ref={btn} type="button" className="btn" onClick={close}>Close</button>
        </header>
        <div className="content">
          {res?.error ? <p className="banner bad">{res.error}</p> : <pre>{text}</pre>}
        </div>
      </aside>
    </>
  );
}
