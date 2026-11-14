# Walkthrough video: 3 minutes

Record in a private window at https://flytbase-assignment-kuldeep.vercel.app. Dark theme looks best on video. `?q=3` shows one question on its own if you want a tight shot. Aim for about 440 spoken words.

| Time | On screen | Say |
|---|---|---|
| 0:00 | The page, account A selected | "This is a live CRM for three customer accounts. Each answers five questions, and every number cites the record it came from. I'll walk through Eastern Counties, the police alliance." |
| 0:15 | Book bar and Q1 | "One. What's the book worth? There is no single total, on purpose. £555,000 is closed. Another £350,000 is the renewal: the amount is in the contract, but nobody has won it yet, so it's backed, not closed. Unbacked is zero." |
| 0:35 | Q2 roster, hatched seats | "Two. Who holds the power? No record says who signs, so every seat is derived and marked that way. The force finance officers sign each call-off, and nobody is named for them. Those are the hatched seats." |
| 0:50 | Q3 quest log | "Three. What do I do first? Karen Mbeki's event is number one. She wants training dates and failure cover in writing this week, ahead of a public event on 5 December. We sold her both, so it's a promise we owe. Owner, due date inside both deadlines, and the deals it moves." Open "Show the maths". |
| 1:10 | Q4 then Q5 | "Four. Risks, each with the date it turns bad, and how that date was worked out. Rhys Calder is leaving in January. Five. What we still don't know, and who could answer it." |
| 1:25 | Click the `contract.txt` chip on the renewal card | "Now let me trace one number. The renewal, £350,000. Click its source." The drawer shows the contract. "350,000 a year, no automatic renewal. That's where it came from. Every tag opens the raw record." |
| 1:50 | Live events panel, then the K tile | "It also keeps itself up to date. The server makes one call a minute, and the page watches. While I was building, three live events arrived, and this third account, Kestrel Estates, was released. The queue spotted it, fetched its data, and it appeared with no code change." Show K's top move. |
| 2:15 | Code: `lib/plan.ts`, then `lib/sync.ts` | "The code. This is the queue. One call every 61 seconds, behind a Redis lock, and new events jump the line." |
| 2:30 | `lib/analysis/` folder, `moves.ts` | "The rules engine is plain TypeScript. No model runs at load. Moves are ranked by urgency, times value, times promise, and the reasoning is on the page." |
| 2:45 | `tests/analysis.test.ts`, test output | "And a test walks every source id and fails if one doesn't resolve to a real record, so nothing can be invented. 54 tests pass. Thanks for watching." |

## If another event arrives before you record

Show it. A new event appears in the Live events panel with a red "new" tag, and the account's moves re-rank. Say: "That arrived while I was recording, and it changed the ranking."

## Do not show

The token or `.env.local`. The Vercel settings page.
