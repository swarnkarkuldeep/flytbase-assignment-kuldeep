// Shapes of the data the MCP returns. Verified against snapshot/ on 2026-11-14.
export type Relationship = "guarded" | "neutral" | "warm" | "ally";
export type FactStatus = "claim" | "told" | "verified";
export type Stage = "identified" | "qualified" | "cleared" | "agreed";

export interface Stakeholder { id: string; name: string; role: string; relationship: Relationship; available?: boolean }
export interface Fact { id: string; text: string; said_by: string; status: FactStatus; verified_by?: string; learned_at_minute: number }
export interface Blocker { text: string; status: "open" | "cleared" }
export interface DealDeadline { text: string; minute?: number; soon?: boolean; passed?: boolean; met?: boolean; moves_left?: number | null }
export interface Opportunity {
  id: string; title: string; stage: Stage; worth_up_to?: number | null; size?: "base" | "big" | null;
  blocker?: Blocker | null; evidence: string[]; deadline?: DealDeadline | null;
}
export interface Offer { id: string; title: string; value: number; pitch_to?: string; status: "open" | "won" | "declined" }
export interface AccountDeadline { text: string; minute?: number; passed?: boolean }
export interface Account {
  id: string; name: string; official_story?: string;
  stakeholders: Stakeholder[]; facts: Fact[]; opportunities: Opportunity[]; offers?: Offer[]; deadlines: AccountDeadline[];
  /** set on accounts released later: the clock of the export they came in, so their `minute` fields can become dates */
  export_meta?: { exported_at: string; minute: number };
}
export interface FileRef { id: string; title: string; path: string; account?: string }
export interface Export { format: string; player: string; exported_at: string; minute: number; world_closed: boolean; accounts: Account[]; files: FileRef[] }

export interface PaperRecord { path: string; kind: string; text?: string; data?: unknown }
export interface Paperwork { account: string; records: PaperRecord[] }

/** Signal shape is unknown until the first arrives, so keep it loose and keep the raw payload. */
export type Signal = Record<string, unknown>;
export interface Whoami {
  player_id?: string; your_morning_over?: boolean; new_accounts?: unknown[];
  pack?: { account: string; open: boolean }[]; signals?: number; paths?: string[];
}
export interface TeamMember { id: string; name: string; role: string }

/** Everything stored is wrapped so the UI can show how fresh it is. */
export interface Envelope<T = unknown> { at: string; data: T }

export interface Job { tool: string; args: Record<string, unknown>; reason?: string }
export interface LogEntry { at: string; job: string; ok: boolean; ms: number; note?: string }
export interface Meta {
  lastCallAt: number | null;
  calls: number;
  alt: "get_signals" | "whoami";
  /** calls made since the last whoami/get_signals poll; keeps live events from being starved by a long queue */
  sincePoll?: number;
  fails: Record<string, { n: number; at: number }>;
  lastError?: { at: string; job: string; message: string };
  log: LogEntry[];
}
