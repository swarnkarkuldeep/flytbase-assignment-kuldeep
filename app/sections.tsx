"use client";
import type { ReactNode } from "react";
import type { AccountAnalysis, BookRow, DealPower, Gap, Move, PowerEntry, Risk } from "@/lib/analysis/types";
import { Avatar, Badge, Chips, Fold, Icon, Medal, Meter, Rel, Standing } from "./ui";
import { daysFrom, money, splitWho } from "./fmt";

type Open = (id: string) => void;
type IconName = Parameters<typeof Icon>[0]["name"];

/** One question, drawn as a window: a title bar with the question number, a one-line answer, then the body. */
export function Section({ n, icon, title, answer, children }: { n: number; icon: IconName; title: string; answer: ReactNode; children: ReactNode }) {
  return (
    <section className="win" id={`q${n}`} aria-labelledby={`q${n}-h`}>
      <header className="win-bar">
        <span className="hex" aria-label={`Question ${n}`}>{n}</span>
        <h2 id={`q${n}-h`}>{title}</h2>
        <Icon name={icon} />
      </header>
      <p className="win-answer">{answer}</p>
      <div className="win-body">{children}</div>
    </section>
  );
}

// ------------------------------------------------------------------ Q1  the book
const BUCKET: Record<BookRow["bucket"], { label: string; tone: "good" | "warn" | "acc" | undefined }> = {
  closed: { label: "Won or agreed", tone: "good" },
  evidenced: { label: "Amount is in the contract, not yet won", tone: "good" },
  open_offer: { label: "Pitched, not won", tone: "warn" },
  projection: { label: "Projection", tone: "warn" },
  claim_only: { label: "Claim only", tone: "warn" },
};

function BookCard({ r, cur, open }: { r: BookRow; cur: string; open: Open }) {
  const b = BUCKET[r.bucket];
  return (
    <article className={`item ${r.backed ? "backed" : "unbacked"}`}>
      <div className="item-head">
        <div className="item-title">
          <h3>{r.title}</h3>
          <div className="badges">
            <Badge tone={b.tone}>{b.label}</Badge>
            <Badge>{r.type === "offer" ? "Offer" : "Deal"}: {r.stage}</Badge>
            {r.people.map((p) => <Badge key={p} tone="acc">{p}</Badge>)}
          </div>
        </div>
        <div className="amount">{r.value != null ? money(r.value, cur) : <span className="muted small">no value on record</span>}</div>
      </div>
      {r.note && <p className="note">{r.note}</p>}
      {r.qualifiedBy && r.qualifiedBy.length > 0 && (
        <div className="against">
          <b>Set against</b>
          <ul>{r.qualifiedBy.map((q, i) => <li key={i}>{q.text} <Chips ids={q.sources} open={open} /></li>)}</ul>
        </div>
      )}
      <Fold summary={`What backs this (${r.backing.length})`}>
        <ul className="list">{r.backing.map((x, i) => <li key={i}>{x.label} <Chips ids={x.sources} open={open} max={4} /></li>)}</ul>
      </Fold>
      <Chips ids={r.sources} open={open} max={6} />
    </article>
  );
}

export function Q1View({ a, open }: { a: AccountAnalysis; open: Open }) {
  const q = a.q1, cur = a.currency, t = q.totals;
  const closed = q.rows.filter((r) => r.bucket === "closed");
  const contracted = q.rows.filter((r) => r.bucket === "evidenced");
  const unbacked = q.rows.filter((r) => !r.backed);
  return (
    <Section n={1} icon="coin" title="What is the book worth?"
      answer={<>Closed <b>{money(t.closed.amount, cur)}</b>. A further <b>{money(t.evidenced.amount, cur)}</b> is written in the contract but not yet won, so it is backed but not closed. Unbacked <b>{money(t.unbacked.amount, cur)}</b>. These stay apart: there is no single headline total.</>}>
      <div className="group">
        <div className="group-head"><h3>Closed</h3><span className="amount">{money(t.closed.amount, cur)}</span></div>
        <p className="note">Won or agreed in the discovery record. <Chips ids={t.closed.sources} open={open} max={5} /></p>
        {closed.map((r) => <BookCard key={r.id} r={r} cur={cur} open={open} />)}
        {!closed.length && <p className="empty">Nothing is closed yet.</p>}
      </div>

      <div className="group">
        <div className="group-head"><h3>Backed by a document, not yet won</h3><span className="amount">{money(t.evidenced.amount, cur)}</span></div>
        <p className="note">The amount is written in a contract or record we hold, but nobody has agreed it yet. It counts as backed, never as closed. <Chips ids={t.evidenced.sources} open={open} max={5} /></p>
        {contracted.map((r) => <BookCard key={r.id} r={r} cur={cur} open={open} />)}
        {!contracted.length && <p className="empty">Nothing here.</p>}
      </div>

      <div className="group">
        <div className="group-head"><h3>Unbacked</h3><span className="amount warn">{money(t.unbacked.amount, cur)}</span></div>
        <p className="note">Pitched, projected or only claimed: {money(t.openOffers.amount, cur)} in open offers and {money(t.projection.amount, cur)} in projections. Claims with no value are listed below. <Chips ids={t.unbacked.sources} open={open} max={5} /></p>
        {unbacked.map((r) => <BookCard key={r.id} r={r} cur={cur} open={open} />)}
        {!unbacked.length && <p className="empty">Nothing unbacked on the book.</p>}
      </div>

      {(q.inForce || q.evidencedSavings.length > 0 || q.declined.length > 0) && (
        <div className="group">
          <div className="group-head"><h3>For context, not added to the book</h3></div>
          {q.inForce && (
            <div className="item plain">
              <div className="item-head"><span>{q.inForce.label}</span><span className="amount">{money(q.inForce.amount, cur)} {q.inForce.period}</span></div>
              <Chips ids={q.inForce.sources} open={open} />
            </div>
          )}
          {q.evidencedSavings.map((s, i) => (
            <div className="item backed" key={i}>
              <div className="item-head"><span><Badge tone="good">Hard saving, customer side</Badge> {s.label}</span><span className="amount">{money(s.amount, cur)} {s.period}</span></div>
              <p className="note">The only saving with a document behind it. It is the customer's saving, not FlytBase revenue.</p>
              <Chips ids={s.sources} open={open} />
            </div>
          ))}
          {q.declined.map((d) => (
            <div className="item plain" key={d.id}>
              <div className="item-head"><span><Badge>Declined</Badge> {d.title}{d.pitchTo ? ` (pitched to ${d.pitchTo})` : ""}</span><span className="amount muted">{money(d.value, cur)}</span></div>
              <Chips ids={d.sources} open={open} />
            </div>
          ))}
        </div>
      )}

      {q.claimsOnly.length > 0 && (
        <div className="group">
          <div className="group-head"><h3>Claims with nothing behind them</h3></div>
          {q.claimsOnly.map((c) => (
            <div className="item unbacked" key={c.id}>
              <div className="item-head"><h3 className="quote">"{c.text}"</h3><Badge tone="warn">claim by {c.saidBy}</Badge></div>
              {c.qualifiedBy.length > 0 && (
                <div className="against"><b>Against it</b>
                  <ul>{c.qualifiedBy.map((x, i) => <li key={i}>{x.text} <Chips ids={x.sources} open={open} /></li>)}</ul>
                </div>
              )}
              <Chips ids={c.sources} open={open} />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Q2  the roster
const ROLE_ORDER: PowerEntry["role"][] = ["decides", "pays", "uses", "blocks"];
const ROLE_LABEL: Record<PowerEntry["role"], string> = { decides: "Decides", pays: "Pays", uses: "Uses", blocks: "Could block" };

function Seat({ e, open }: { e: PowerEntry; open: Open }) {
  const { name, role } = splitWho(e.who.replace(/^Unknown:\s*/, ""));
  const fogged = !e.known;
  return (
    <div className={`seat ${fogged ? "fog" : ""}`}>
      <div className="seat-top">
        <Avatar name={name} level={e.relationship} unknown={fogged} />
        <div className="seat-who">
          <b>{name}</b>
          {role && <span className="muted small">{role}</span>}
          {fogged && /^Unknown:/.test(e.who) && (e.role === "decides" || e.role === "pays") && <span className="muted small">Nobody named on file</span>}
        </div>
      </div>
      <div className="badges">
        {e.relationship && <Standing level={e.relationship} />}
        <Badge derived={e.basis === "derived"} title={e.basis === "derived" ? "Worked out from roles, facts and paperwork; not stated outright" : "Stated in a record"}>{e.basis}</Badge>
      </div>
      <Fold summary="Why">
        <p className="note">{e.why}</p>
      </Fold>
      <Chips ids={e.sources} open={open} max={4} />
    </div>
  );
}

function DealRoster({ d, cur, open }: { d: DealPower; cur: string; open: Open }) {
  return (
    <article className="roster">
      <div className="item-head">
        <h3>{d.title}</h3>
        <div className="badges">{d.value != null ? <span className="amount sm">{money(d.value, cur)}</span> : <span className="muted small">no value</span>}<Badge>{d.stage}</Badge></div>
      </div>
      <div className="cols">
        {ROLE_ORDER.map((role) => {
          const es = d.entries.filter((e) => e.role === role);
          if (!es.length) return null;
          return (
            <div className="col" key={role}>
              <h4>{ROLE_LABEL[role]}</h4>
              {es.map((e, i) => <Seat key={i} e={e} open={open} />)}
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function Q2View({ a, open }: { a: AccountAnalysis; open: Open }) {
  const unknown = a.q2.flatMap((d) => d.entries).filter((e) => !e.known && (e.role === "decides" || e.role === "pays")).length;
  return (
    <Section n={2} icon="party" title="Who holds the power?"
      answer={<>{a.q2.length} deals. No record says who decides or pays, so every seat is <b>derived</b> and shows the facts it rests on. Hatched seats are people nobody has named: {unknown} deciders or payers are still unknown.</>}>
      {a.q2.map((d) => <DealRoster key={d.dealId} d={d} cur={a.currency} open={open} />)}
    </Section>
  );
}

// ------------------------------------------------------------------ Q3  the quest log
function Quest({ m, a, open }: { m: Move; a: AccountAnalysis; open: Open }) {
  const days = daysFrom(a.asOf, m.due);
  return (
    <article className={`quest r${m.rank ?? 0}`}>
      <div className="quest-medal">{m.rank ? <Medal rank={m.rank} /> : null}</div>
      <div className="quest-main">
        <h3>{m.title}</h3>
        <dl className="facts">
          <div><dt>Owner</dt><dd>{m.owner}{m.helpers.length > 0 && <span className="muted"> with {m.helpers.join("; ")}</span>}</dd></div>
          <div><dt>Due</dt><dd><b>{m.due}</b> <span className={`pill ${days <= 3 ? "hot" : ""}`}>{days === 0 ? "today" : days > 0 ? `in ${days} days` : `${-days} days ago`}</span></dd></div>
          <div><dt>Moves</dt><dd>{m.dealTitles.length ? m.dealTitles.join("; ") : <span className="muted">no deal linked</span>}</dd></div>
          {m.insideDeadlines.length > 0 && (
            <div><dt>Inside</dt><dd>{m.insideDeadlines.map((d, i) => <div key={i}>{d.label}: <b>{d.date}</b>{d.derived && <> <Badge derived>derived</Badge></>}</div>)}</dd></div>
          )}
        </dl>
        <Fold summary="Show the maths and what is behind it">
          <p className="maths">{m.reasoning}</p>
          <ul className="list">{m.detail.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </Fold>
        <Chips ids={m.sources} open={open} max={6} />
      </div>
      <div className="quest-stats" aria-label="Score">
        <div className="score"><b>{m.score.total.toFixed(1)}</b><span>score</span></div>
        <Meter label="Urgency" value={m.score.urgency.toFixed(1)} pct={(m.score.urgency / 6) * 100} />
        <Meter label="Value" value={m.score.value.toFixed(2)} pct={(m.score.value / 2.6) * 100} />
        <Meter label="Promise" value={`x${m.score.promise}`} pct={(m.score.promise - 1) * 100} />
      </div>
    </article>
  );
}

export function Q3View({ a, open }: { a: AccountAnalysis; open: Open }) {
  const { top, considered } = a.q3;
  return (
    <Section n={3} icon="flag" title="What do you do first?"
      answer={<>The first three moves, ranked by deadline urgency, value at risk and whether we owe it. Each has an owner, a due date inside every relevant deadline, and the deal it moves.</>}>
      {top.map((m) => <Quest key={m.id} m={m} a={a} open={open} />)}
      {considered.length > 0 && (
        <Fold summary={`Also considered, ranked lower (${considered.length})`}>
          {considered.map((m) => (
            <article className="item plain" key={m.id}>
              <div className="item-head"><h3>{m.title}</h3><span className="badge">score {m.score.total.toFixed(1)}</span></div>
              <p className="note">{m.reasoning}</p>
              <Chips ids={m.sources} open={open} max={5} />
            </article>
          ))}
        </Fold>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Q4  threat timers
function Threat({ r, a, open }: { r: Risk; a: AccountAnalysis; open: Open }) {
  const t = r.turnsBadOn;
  const d = t ? daysFrom(a.asOf, t.date) : null;
  return (
    <article className={`threat ${r.overdue ? "over" : ""}`}>
      <div className="timer" aria-label={t ? `${r.overdue ? "Turned bad" : "Turns bad"} ${t.date}` : "No date known"}>
        {d === null ? <><b>?</b><span>no date</span></> : <><b>{Math.abs(d)}</b><span>{r.overdue ? "days late" : "days left"}</span></>}
      </div>
      <div className="threat-main">
        <div className="item-head">
          <h3>{r.title}</h3>
          {t && <Badge tone={r.overdue ? "bad" : "warn"} derived={t.derived} title={t.how}>{r.overdue ? "Turned bad" : "Turns bad"} {t.date}{t.derived ? ", derived" : ""}</Badge>}
        </div>
        <p className="body-text">{r.detail}</p>
        {t?.how && <p className="note">How the date was worked out: {t.how}. <Rel date={t.date} asOf={a.asOf} /></p>}
        <Chips ids={r.sources} open={open} max={6} />
      </div>
    </article>
  );
}

export function Q4View({ a, open }: { a: AccountAnalysis; open: Open }) {
  const over = a.q4.filter((r) => r.overdue);
  const soon = a.q4.filter((r) => !r.overdue);
  return (
    <Section n={4} icon="siren" title="What is about to go wrong?"
      answer={<>{a.q4.length} risks, {over.length} already past the date they turn bad. Each shows when it turns bad, and how that date was worked out when it is derived.</>}>
      {over.length > 0 && <div className="group"><div className="group-head"><h3>Already turned bad ({over.length})</h3></div>{over.map((r) => <Threat key={r.id} r={r} a={a} open={open} />)}</div>}
      {soon.length > 0 && <div className="group"><div className="group-head"><h3>Still coming ({soon.length})</h3></div>{soon.map((r) => <Threat key={r.id} r={r} a={a} open={open} />)}</div>}
    </Section>
  );
}

// ------------------------------------------------------------------ Q5  fog of war
function Fog({ g, open }: { g: Gap; open: Open }) {
  const note = g.kind === "unconfirmed_note";
  return (
    <article className={`fogcard ${note ? "note-card" : ""} ${g.kind === "unconfirmed" ? "clash" : ""}`}>
      <div className="item-head">
        <h3>{g.title}</h3>
        {note && <Badge tone="warn">no record behind it</Badge>}
        {g.kind === "unconfirmed" && <Badge tone="bad">records disagree</Badge>}
      </div>
      <p className="body-text"><b>Why it matters.</b> {g.whyItMatters}</p>
      <div className="askers">
        <b>Who could lift the fog</b>
        <ul>
          {g.whoCouldFill.map((w, i) => {
            const { name, role } = splitWho(w.who);
            return (
              <li key={i}>
                <Avatar name={name} />
                <div>
                  <b>{name}</b>{role && <span className="muted small"> {role}</span>}
                  <p className="note">{w.why} <Chips ids={w.sources} open={open} max={4} /></p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {!note && <Chips ids={g.sources} open={open} max={6} />}
    </article>
  );
}

export function Q5View({ a, open }: { a: AccountAnalysis; open: Open }) {
  const notes = a.q5.filter((g) => g.kind === "unconfirmed_note");
  const rest = a.q5.filter((g) => g.kind !== "unconfirmed_note");
  return (
    <Section n={5} icon="fog" title="What do you still not know?"
      answer={<>{rest.length} gaps the plan rests on, each with why it matters and a named person who could fill it.{notes.length > 0 && <> {notes.length} more come from your own morning notes and have no record behind them.</>}</>}>
      {rest.map((g) => <Fog key={g.id} g={g} open={open} />)}
      {notes.length > 0 && (
        <div className="group">
          <div className="group-head"><h3>From your morning notes: unconfirmed, never used as evidence</h3></div>
          {notes.map((g) => <Fog key={g.id} g={g} open={open} />)}
        </div>
      )}
    </Section>
  );
}
