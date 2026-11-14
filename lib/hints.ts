// The user's own morning notes. These are HINTS, never evidence: nothing here is in the fetched data, so the app
// shows them only under Q5 ("what we still don't know") as unconfirmed, with who could confirm. They never feed a
// number, a ranking or a date.
export interface Hint { id: string; title: string; text: string; whyItMatters: string; confirmWith: string[] }

export const MORNING_NOTES: Record<string, Hint[]> = {
  A: [
    {
      id: "note-a-usage-report",
      title: "Unconfirmed (your notes): the usage report went to the wrong person",
      text: "Your notes say a force-by-force usage report was sent to the wrong person (Ewan Brooks) and there is one try left. Nothing in the data records this.",
      whyItMatters: "If the usage proof reached the wrong person, the renewal blocker (no force-by-force proof) is still open for the people who must approve it.",
      confirmWith: ["Ewan Brooks"],
    },
    {
      id: "note-a-bid-window",
      title: "Unconfirmed (your notes): Metro Central's bid window has passed",
      text: "Your notes say Metro Central's bid window has passed. The discovery record still shows it as not passed (passed: false, condition met).",
      whyItMatters: "It decides whether extra Metro Central docks can still be bid for this round.",
      confirmWith: ["Ewan Brooks"],
    },
  ],
  B: [
    {
      id: "note-b-nadia",
      title: "Unconfirmed (your notes): what moves Nadia Rahman and how costs are allocated",
      text: "Your notes say Nadia Rahman accepts measured changes, not projections, and that security costs are allocated to plants by headcount and site size. No fact or record in the data says this.",
      whyItMatters: "It decides what evidence will move group finance, and how the per-plant renewal quote must be built.",
      confirmWith: ["Nadia Rahman"],
    },
    {
      id: "note-b-beatriz",
      title: "Unconfirmed (your notes): why Beatriz Alonso values the dock, and why she is guarded",
      text: "Your notes say Beatriz Alonso values the Plant 7 dock most at night and felt abandoned after install. The data holds no fact from her; only one closed support ticket.",
      whyItMatters: "It is the case for the night-support offer, and it is the strongest read on why she is guarded.",
      confirmWith: ["Beatriz Alonso"],
    },
  ],
};
