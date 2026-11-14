// Per-account working context: everything the rules need, with small lookup helpers.
import type { Account, FileRef, PaperRecord, Signal, TeamMember } from "../types.ts";

export interface Ctx {
  now: Date;
  exportedAt: Date;
  /** minutes after discovery opened when the export was taken */
  exportMinute: number;
  account: Account;
  currency: string;
  records: PaperRecord[];
  fileRefs: FileRef[];
  files: Record<string, any>;
  signals: Signal[];
  team: TeamMember[];
  rec(path: string): PaperRecord | undefined;
  json<T = any>(path: string): T | undefined;
  text(path: string): string;
  /** "A:path" */
  src(path: string, anchor?: string): string;
  profile: any;
  /** forces named in the profile, e.g. ["Westmere","Metro Central",...] */
  forces: string[];
  stakeholderByName(name: string): Account["stakeholders"][number] | undefined;
}

export function makeCtx(args: {
  now: Date; exportedAt: Date; exportMinute: number; account: Account; records: PaperRecord[]; fileRefs: FileRef[];
  files: Record<string, any>; signals: Signal[]; team: TeamMember[];
}): Ctx {
  const { account, records } = args;
  const byPath = new Map(records.map((r) => [r.path, r]));
  const json = <T = any>(p: string) => {
    const r = byPath.get(p);
    if (!r) return undefined;
    if (r.data !== undefined) return r.data as T;
    if (r.text) { try { return JSON.parse(r.text) as T; } catch { return undefined; } }
    return undefined;
  };
  const profile = json("profile.json") ?? {};
  const forces = parseForces(profile?.what_they_bought ?? "");
  return {
    ...args,
    currency: profile?.currency ?? "GBP",
    profile,
    forces,
    rec: (p) => byPath.get(p),
    json,
    text: (p) => byPath.get(p)?.text ?? "",
    src: (p, a) => `${account.id}:${p}${a ? "#" + a : ""}`,
    stakeholderByName: (name) => {
      const n = name.toLowerCase().replace(/^insp\.\s*/, "");
      return account.stakeholders.find((s) => {
        const sn = s.name.toLowerCase().replace(/^insp\.\s*/, "");
        return sn === n || n.includes(sn) || sn.includes(n);
      });
    },
  };
}

/** "...for the four member forces (Westmere, Metro Central, Tarn Valley, Norwold)." -> list */
export function parseForces(s: string): string[] {
  const m = /\(([^)]+)\)/.exec(s);
  return m ? m[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
}

export const STOP = new Set("the a an and or of to for in on at with from by is are was were be been it its this that these those as we our their his her not no any all have has had will would can could should may might do does did about after before into than then them they you your one two".split(" "));
export const words = (s: string) => (s.toLowerCase().match(/[a-z][a-z\-']{3,}/g) ?? []).filter((w) => !STOP.has(w));
