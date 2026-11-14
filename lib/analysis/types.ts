// Output shapes of the rules engine. Every item carries `sources`: ids the UI turns into chips
// that open the raw record or file. Source id forms:
//   fact / file / opportunity / offer / stakeholder ids as in the export (e.g. km_usage_1, a_renewal)
//   "<account>:<record path>"            a paperwork record, e.g. A:calls/2026-10-20_check_in.txt
//   "<account>:<record path>#<anchor>"   a row inside a record, e.g. A:tickets.json#FB-10412
//   "signal:<key>"                       a live event
//   "notes:morning"                      the user's own morning notes (never evidence)
export type SourceId = string;

export type Basis = "stated" | "derived";

export interface DatedPoint {
  /** YYYY-MM-DD */
  date: string;
  derived: boolean;
  /** how a derived date was computed */
  how?: string;
  sources: SourceId[];
}

// ---------- Q1 ----------
export type Bucket = "closed" | "evidenced" | "open_offer" | "projection" | "claim_only";
export interface BookRow {
  id: string;
  title: string;
  /** deal | offer | claim */
  type: "deal" | "offer" | "claim";
  value: number | null;
  stage: string;
  bucket: Bucket;
  backed: boolean;
  /** who/what backs the figure, each with ids */
  backing: { label: string; sources: SourceId[] }[];
  people: string[];
  note?: string;
  /** claims this row's figure contradicts or is qualified by */
  qualifiedBy?: { text: string; sources: SourceId[] }[];
  sources: SourceId[];
}
export interface Q1 {
  currency: string;
  rows: BookRow[];
  totals: {
    closed: { amount: number; sources: SourceId[] };
    evidenced: { amount: number; sources: SourceId[] };
    backed: { amount: number; sources: SourceId[] };
    openOffers: { amount: number; sources: SourceId[] };
    projection: { amount: number; sources: SourceId[] };
    unbacked: { amount: number; sources: SourceId[] };
  };
  /** money already flowing under contract (context, not added to the book) */
  inForce: { label: string; amount: number; period: string; sources: SourceId[] } | null;
  /** hard customer-side savings with a document behind them (not FlytBase revenue) */
  evidencedSavings: { label: string; amount: number; period: string; sources: SourceId[] }[];
  declined: { id: string; title: string; value: number; pitchTo: string | null; sources: SourceId[] }[];
  claimsOnly: { id: string; text: string; saidBy: string; qualifiedBy: { text: string; sources: SourceId[] }[]; sources: SourceId[] }[];
}

// ---------- Q2 ----------
export type PowerRole = "decides" | "pays" | "uses" | "blocks";
export interface PowerEntry {
  role: PowerRole;
  /** a name, or "Unknown: <title>" */
  who: string;
  stakeholderId?: string;
  known: boolean;
  relationship?: string;
  basis: Basis;
  why: string;
  sources: SourceId[];
}
export interface DealPower {
  dealId: string;
  title: string;
  value: number | null;
  stage: string;
  entries: PowerEntry[];
}

// ---------- Q3 ----------
export interface Move {
  id: string;
  rank?: number;
  title: string;
  detail: string[];
  owner: string;
  helpers: string[];
  due: string;
  /** every deadline the due date sits inside */
  insideDeadlines: { label: string; date: string; derived: boolean; sources: SourceId[] }[];
  dealIds: string[];
  dealTitles: string[];
  weOwe: boolean;
  score: { urgency: number; value: number; promise: number; total: number };
  reasoning: string;
  valueAtRisk: { backed: number; unbacked: number; weighted: number };
  sources: SourceId[];
}

// ---------- Q4 ----------
export interface Risk {
  id: string;
  kind: "deadline" | "cold_contact" | "stuck_deal" | "unanswered" | "idle_docks" | "usage" | "single_thread" | "signal";
  title: string;
  detail: string;
  /** when it turns bad */
  turnsBadOn: DatedPoint | null;
  /** already past that point */
  overdue: boolean;
  severity: number;
  sources: SourceId[];
}

// ---------- Q5 ----------
export interface Gap {
  id: string;
  title: string;
  whyItMatters: string;
  /** who could fill it: a named person, with the source for why them */
  whoCouldFill: { who: string; stakeholderId?: string; why: string; sources: SourceId[] }[];
  /** "unknown" gaps come from the data; "unconfirmed_note" come from the user's notes with no record behind them */
  kind: "unknown" | "unconfirmed" | "unconfirmed_note";
  sources: SourceId[];
}

export interface SignalView {
  key: string;
  /** the signal's own title and the part after "Account: " */
  title: string | null;
  headline: string | null;
  text: string;
  date: string | null;
  accountId: string | null;
  people: string[];
  raw: unknown;
  sources: SourceId[];
}

export interface AccountAnalysis {
  id: string;
  name: string;
  currency: string;
  asOf: string;
  dataAsOf: string;
  q1: Q1;
  q2: DealPower[];
  q3: { top: Move[]; considered: Move[] };
  q4: Risk[];
  q5: Gap[];
  signals: SignalView[];
  /** numbers the UI can show in a header strip */
  facts: { label: string; value: string; sources: SourceId[] }[];
  /**
   * "Today" for this account's date calculations: the later of the real clock and the latest live event about
   * it, because the scenario dates its events ahead of the real clock. Each account has its own timeline.
   */
  clock: { real: string; world: string; shifted: boolean; because: string | null };
  /** docks by how much they fly (from usage_weekly.csv / flights.csv); null when the account has no usage data */
  fleet: { total: number; active: number; rarely: number; neverFlew: number; wentQuiet: number; weeks: [string, string]; sources: SourceId[] } | null;
  /** days from the analysis time to the contract term end, when the contract states one */
  termEnd: { date: string; sources: SourceId[] } | null;
}
