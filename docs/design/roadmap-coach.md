# Roadmap Coach

Status: ✅ Ready for dev, ruled by the owner on 2026-11-08. The boards for three changed rulings are 🧪
until the owner sees them: Q4, mandatory review; Q6, signed out; Q7, one History. Those boards are 02.5,
02.6, 03.1, 03.7, 04.4, 05.1, 06.1, 06.2, 07.1, 07.2 and 08.1. The boards are on the Roadmap file's
[🧪 Roadmap Coach](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=668-5126) page. The
[wave NOTE](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=688-4928) records the eleven rulings.
The [engineering NOTE](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=688-4965) covers tools,
context and allowance plumbing. Every caption and section NOTE names the SwiftUI or web element of each part.

Roadmap Coach replaces tending, the roadmap's AI that edits the tree at once from one sentence. Coach is a
chat that knows your roadmaps and your progress. It answers questions ("what should I do next", "is my
plan realistic"), and it changes a roadmap only through proposals that you review and apply. A plain
command about one step is the exception: it is written at once, with a receipt and Undo. Coach follows
the Gym Coach: the same turn wire, card, access states, allowance and words, tuned for roadmaps and
self-development, with roadmap tools as its local executors.

## Sections

| Section | Figma | Holds |
|---|---|---|
| 00 · Read me and map | [`689:4928`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=689-4928) | What the page holds, how to read it, the flow map |
| 01 · Entry points | [`679:2393`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=679-2393) | The Coach tab, a step's context menu, the Graph's accessory, the step page, Coach about one step |
| 02 · Conversation | [`677:1879`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=677-1879) | Fresh chat, an answer, a turn in progress, What Coach read, the shared History, a photo |
| 03 · Proposals | [`673:5717`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=673-5717) | The card (Reject and Review), the review sheet (Graph and Changes views, where Apply lives), applied, rejected, out of date, a long proposal, every change kind, applied offline, synced after the roadmap changed elsewhere |
| 04 · Direct writes and receipts | [`681:2964`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=681-2964) | Marked done, a step added, undone, a removal shown as a card |
| 05 · Access, allowance and offline | [`681:3522`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=681-3522) | Signed out (everything works), allowance used (signed out and signed in, with Windmill One), shared capacity, offline, the Windmill One store sheet |
| 06 · Largest text and iOS 18 | [`683:3632`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=683-3632) | AX5, the iOS 18 tab bar and buttons, the iOS 18 review sheet |
| 07 · Web desktop | [`685:43559`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=685-43559) | The docked panel; Review turns on Preview on the Board or Graph, with Apply in its review bar; panel states |
| 08 · Web phone | [`686:4715`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=686-4715) | The Coach page, the review bottom sheet, the roadmap sheet entry, Coach about one step |
| 🧩 Components | [`668:5160`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=668-5160) | Tab bar with Coach, composer, change symbols, read receipt, graph diff |

Boards are drawn at iPhone 17 size (402 × 874 pt), web at 1440 × 960 and 390 × 844. Dark boards are on each
section's top row, with Light twins below for the key screens. Fixture: *Learn to sail* (eight steps) and
one proposal of three changes. The room's chrome comes from the [Roadmap · iOS](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=648-2)
page ([written half](ios/roadmap.md)). Those boards are copied into a local templates section; the page
itself is never edited. The card and its states follow the Gym file's approved proposal pass
([iOS 08 · Coach](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1117-1703): 08.2P, 08.12P, 08.13P,
08.14P, 08.27P and 08.56P).

## The owner's rulings (2026-11-08)

1. **Name.** "Coach" inside the Roadmap room: the same name, symbol and allowance as Gym's. The word "tending" is removed from every surface.
2. **Where it lives on iOS.** Coach is the room's third tab (Board · Graph · Coach, plus Search). Ask Coach also opens it from a step: the step's context menu, the Graph's accessory and the step page.
3. **Which writes land at once.** Your own simple one-step commands apply at once, with a receipt and Undo. Everything else is a proposal card.
4. **How a proposal is reviewed.** Graph first, and human review is mandatory:
   - A card never applies. It offers Reject and Review.
   - Review opens the review sheet on Graph, with Changes one tab away. Apply lives only there.
   - On desktop web, Review turns on Preview, and Apply lives only in Preview's review bar.
5. **Apply offline.** Applying works offline, as a local write through graph sync, and always lands. Asking needs a connection.
6. **Signed out.** Everything works signed out:
   - asking;
   - direct writes;
   - reviewing and applying proposals.

   All of it happens on the roadmap kept on this phone and reaches the account at sign-in.
7. **History.** One shared History:
   - Every conversation is tagged with its roadmap, or "All roadmaps".
   - The current roadmap's conversations sit on top.
   - The title menu filters by roadmap.
8. **Windmill One teaser.** The Windmill One button appears only in the "allowance used" notice. It is drawn live and opens the store sheet (05.6): the `SubscriptionStoreView` of the Journal file's 04.4P, with mock prices and Coach's benefit first.
9. **Web.** On desktop, Coach is a docked panel. On the phone, Coach is a page and the review is a bottom sheet. Ask AI retires; ⌘K opens Coach.
10. **Pending proposals.** One pending proposal per roadmap; a newer one replaces it.
11. **Tending's API and meter.** Retire `/v1/trees/{id}/tend`, `/v1/tending` and the AI settings meter when web Coach ships.

Ruling 6 is not how Gym Coach behaves today. Signed out, Gym Coach can mint a proposal on the phone, but it
refuses the decision: `coachDecideProposal` and `coachDecideWorkoutProposal` in
`apps/ios/App/Sources/Gym/Coach/CoachProposals.swift` require an account and show "Sign in to review this
proposal."

## Rules

**What Coach knows.** A conversation is about one roadmap or about all of them. Its subtitle names which; the room's current roadmap is the default.

For one roadmap, every turn Coach reads:

- the roadmap's title and kinds
- every step: state, prerequisites, unlock count and a short description
- the progress overlay, with completion dates
- diagnostics and the health score
- the last ten completions

Above about 300 steps, Coach reads counts, milestones, the frontier and its two-hop neighbourhood instead, and pages the rest with read tools. A conversation started from a step adds that step in full.

For "All roadmaps", Coach reads one line per roadmap you own: its title, counts by state, the frontier's titles and the last completion date. It opens a roadmap in full only when the question needs it. A proposal always names the one roadmap it changes.

Step text is your data, never instructions.

**Writing at once or proposing.** Coach writes at once only when all three hold:

- you asked for exactly this, in this message;
- it touches one step: its progress, title, description or links, one new step with the prerequisites you named, or one new link;
- it removes nothing.

Everything else is a proposal card. That covers whatever Coach suggests on its own, anything that touches two or more steps, and every removal, merge, split, unlink, tidy, and kind rename or recolour. A removal's rows state its cost: the step's progress and what it unlocks.

**Proposals.**

- Human review is mandatory. A card offers Reject and Review. Apply exists only in the review sheet (iOS and web phone) and in Preview's review bar (web desktop), after the diff has been shown.
- No tool and no turn can apply a proposal.
- A proposal applies whole or not at all, against the roadmap version it was written for.
- If any step or link it touches has changed since, it is out of date and nothing is written. This check runs once, when Apply is pressed.
- Once applied, the change is your own work and always lands, like every roadmap edit:
  - A change made elsewhere before it syncs is merged.
  - A prerequisite deleted elsewhere is replaced by that step's own prerequisites.
  - One quiet band says how: "Sail with an instructor synced · it now follows Leave the dock", with Show (03.10; Roadmap · iOS 01.7a–c).
  - An applied proposal is never refused or discarded.
- There is one pending proposal per roadmap.
- Applied, rejected and out-of-date cards stay in the conversation as the record.
- Undo after Apply writes the stored inverse as one batch. It is offered for 6 s in the room's band.

**Commits stay in reach.**

- On a card, Reject and Review sit at the foot as an HStack, with Review trailing.
- In the review sheet, Reject and Apply sit in `.safeAreaInset(edge: .bottom)`.
- None of these buttons is ever in a toolbar.
- At accessibility sizes they stack, with the primary button first.

**History.**

- History is one list for every roadmap, with each row tagged.
- The current roadmap's conversations sit on top; every other conversation follows, newest first.
- A step-started conversation reads "About <step>".
- Deleting a roadmap deletes its conversations. "All roadmaps" conversations stay.

**Receipts.**

- A direct write leaves a receipt with no buttons. Its line is at most eight words and states facts: "Marked done", "Step added · Learn · needs Tie a bowline".
- Undo lives in the room's band.
- After an Undo, the receipt reads "Undone".

**Access.** The allowance is one Windmill allowance across Gym and Roadmap Coach. Windmill One raises it through `Entitlements::hasWindmillOne`.

- The access states and their words are Gym Coach's, with "log" read as "roadmap".
- Signed out, every feature works on the anonymous allowance.
- The phone never shows amounts. When the allowance is used up, it says when it renews.

**Honesty.**

- The Windmill One teaser appears in one place and says only true things: when the allowance renews, and what Windmill One adds. It is drawn live and opens the store sheet. There is no countdown, and it doesn't repeat within the same allowance period.
- Coach's copy never claims an action it did not take.
- The turn's step line uses fixed catalog phrases, never model text.

**Offline.**

- History, answers, receipts and cards all read from the phone.
- Review and Apply still work. Apply is silent and lands when the phone syncs.
- Asking fails honestly when you press Send, and the question stays in the field.

**Platform.**

- Only stock SwiftUI parts are used. The one custom part is the diff canvas, which sits in stock slots: the card's icon and the sheet's content.
- Every iOS 26 API has an iOS 18 fallback, listed in section 06.
- The web uses the same words in web parts.
