# Roadmap Board design review

Status: ✅ **Ready for dev**, owner approved 2026-10-31. The [proposal](roadmap-board-proposal.md) describes the
current design; this file holds the verdict, the rulings and decisions behind it, how each review
finding is resolved, and what remains open.

Pages: [✅ Board · Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900)
and [✅ Board · Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901). Both
were revised on 2026-10-31: shared components, a pass on each page, two independent reviews, a fix
pass against one pinned contract (rulings, strings and fixtures), and an integration pass.

## Verdict

A derived-status board is the right second view. It answers the question the graph fails on a
phone, *what can I do right now*, and because columns follow prerequisites it cannot lie: nothing is
dragged, no status is self-reported. What it hides is what the graph was for, depth and distance;
the card now carries both (*Needs Read the wind · 1 to go*, *Unlocks Leave the dock*). The owner
approved the pages on 2026-10-31. The native control-band question stays open, and the data
prerequisites and ledger drift below are build work.

## Owner rulings

2026-10-28:

1. **Column names: Locked · Up next · Done.** One word per state in every toast, empty state, the
   Graph status line and MCP responses: *locked*, *up next*, *done*.
2. **Step, not node,** in every control and string.
3. **Kind colour is a 4px rail on the card's leading edge**, the element the step identity already
   uses (306:4743). Borders are neutral; the locked tier is dimmed.
4. **The Activity overlay leaves the first wave.** The step's History tab covers the owner case.
   Workspace stays; it is a shipped feature.
5. **Where the phone's control band lives on native** stays open (below).

2026-10-31:

1. **Counts** sit on the column headings and the segments; Done collapses above 12 cards.
2. **Desktop columns run in flow order,** Locked · Up next · Done, with Up next weighted.
3. **The Board replaces the List on phones.**
4. **Locked distance is steps left:** the unfinished steps in the transitive prerequisite closure,
   written *N to go*. The page and modal use the same number.
5. **Phone multi-select carries over:** long-press enters selection; the bottom bar recolours and
   deletes, as the shipped `ui/mobile/BulkBar.jsx` does.

## Orchestrator decisions

- Visitors land on Graph on every surface, the Board one tap away.
- **Next · N** lives on Graph only, with a compass glyph; the Up next column is the Board's answer.
- Complete and Reset stay in place on the page and the modal: the status row flips with inline
  Undo, a secondary line names the outcome, no toast. Reset is always secondary and quiet.
- Toasts come only from actions on the Board itself.
- **Delete step** is in both step menus and is held for nine seconds with Undo.
- `/` moves from Ask AI's second chord to *Find a step*; Ask AI keeps ⌘K.
- A shared step link lands everyone on the Board with the step open.
- Picker title collisions are told apart by *after …* context, never IDs.
- Phone roadmap verbs live in the title-tap roadmap sheet.
- Done shows the 12 most recently completed first, then *Show all N*.

## Findings and their resolution

| Finding | Resolution | Boards |
|---|---|---|
| The state had four names (*Closed*, *ready*, *blocked*, *locked*) | Locked · Up next · Done everywhere | Phone 01.01–01.03; desktop 01.01 |
| *Node* replaced the shipped *step* | *Step* in every control and string | Both pages |
| Desktop never drew the core loop | Complete, Undo, Reset preview and outcome in the modal; keyboard C with toast; save failure, discard, loading, load error, sync states, regroup motion | Desktop 02.01–02.16 |
| Desktop existed only signed in | Visitor on Graph, shared reader Board and step, Fork signed out and in, saved on this device, lapsed session | Desktop 04.01–04.07 |
| Nothing between 390 and 1440 | 1024 three columns; 900 and 744 two columns plus a rail; 744 modal and picker; chrome named per band | Desktop 05.01–05.07 |
| Density past eight cards undefined | Counts on headings and segments, per-column scroll, Done collapse, virtualization requirement, 5,000-step fixture | Desktop 06.01–06.02 and dev note 379:9604; phone 18.01–18.05 |
| The desktop picker was a phone sheet | Anchored panel: search on top, chips, results, Cancel and Apply at the bottom, draft visible | Desktop 09.04–09.07, 09.10; 744 05.07 |
| No distance or reason on the card | *Needs X · N to go* and *Unlocks X*; Roadmap order | Phone 01.01–01.02; desktop 01.01 |
| Creation hidden in a one-item More | Visible New step: plus in the phone band, button in the desktop row | Phone 01.01; desktop 01.01, 09.02 |
| Colour swatches had no names | Kind labels on chips, the filter and the editor | Desktop 07.01, 09.05; phone 05.01, 09.03; Kind choice 306:4848 |
| Kind hue on the border, locked not dimmed, no card states | 4px rail, neutral border, dimmed Locked; card state sheets light and dark | 353:5571, 353:5686 |
| Trailing glyph repeated the column | No trailing glyph on cards; status glyph leads on step rows | Phone 01.01, 01.04 |
| Picker over-built for small roadmaps | No keyboard for eight steps; chip strip replaces Review; *after …* context, no IDs | Phone 02.03, 10.02 |
| Save failure offered Cancel as the only exit | **Retry** · **Keep editing**; **Discard draft?** once | Phone 03.05, 03.07; desktop 02.07–02.08 |
| Complete left the page; checklist banner had no verb | Complete in place with inline Undo; *All subtasks done · Complete step* offer | Phone 01.05, 01.10, 07.06; desktop 02.01, 03.09 |
| Marking done cost three taps | Swipe reveals Complete; full swipe never commits; accessible action | Phone 17.01–17.07 |
| The anonymous Board did not say it was local | *Saved on this device — sign in to keep it* | Phone 04.02; desktop 04.06 |
| Loading was a spinner without chrome | Shell, identity and band kept; skeleton cards | Phone 03.03; desktop 02.09 |
| *View node* on a locked page was ambiguous | No primary; the unfinished prerequisite row is the way through | Phone 01.07; desktop 03.07 |
| Two detail surfaces on desktop | One URL-addressable modal; the dedicated page is gone; a shared link opens the modal on the Board | Desktop 03.01, 04.05 |
| Modal tabs sat under the content | Tabs under the title, actions pinned at the bottom | Desktop 03.01 |
| The Board dropped the roadmap's verbs | One verbs row for Board and Graph; phone roadmap sheet | Desktop 08.01–08.03; phone 09.04 |
| Ready had no primacy | Up next weighted in the middle column | Desktop 01.01 |
| Search had no clear or recovery | Clear in the field; **No steps match** with **Clear search** and owner **New step** | Desktop 07.04–07.05; phone 03.06 |
| Empty roadmap kept a full band; no roadmap-complete state | Band hidden, **New step** pinned in reach; *All 8 steps done* | Phone 03.01, 03.08; desktop 09.01, 09.11 |
| Back label always named the roadmap | Back names the previous screen | Phone 01.08 |
| Activity sheet closed three ways | Activity is out of the first wave | Later · Activity overlay sections |
| Delete and multi-select were undrawn | Step menu, cost line, held delete, regroup; long-press, bar, recolour, delete | Phone 01.09, 20.01–20.03, 21.01–21.04; desktop 03.02–03.06 |
| No sync or session states | *Saving…* → *Saved*, offline, refused sync, lapsed session | Phone 03.09–03.12, 04.11; desktop 02.11–02.13, 02.16, 04.07 |

## Native-foundation decisions

1. The step page is a push with back-swipe and a deep link. Filter, Sort and the roadmap sheet are
   sheets that commit nothing on dismiss. The picker and the note editor are full-screen modals
   with Cancel and a commit.
2. One Cancel/commit geometry on every modal: Cancel top-left, commit top-right or pinned bottom.
3. The segmented control is the platform's, with counts, and it is the only column path. No column
   swipe: the card swipe owns horizontal drags.
4. The card swipe reveals Complete and never commits on release or a full swipe; a tap commits. One
   haptic tick at the threshold.
5. Long-press enters multi-select; the bottom bar recolours and deletes.
6. Search lives in Windmill's band on all three surfaces, since the band also holds the segments
   and the filter.
7. State words are the nouns in toasts, empty states, the Graph status line and MCP.
8. Kind names travel with colour, so the legend and the filter are built once.
9. Back-stack honesty for step → step navigation: push, the back label names the previous screen,
   no *Back to Board* primaries.
10. *Up next · N* is the one roadmap number worth a glance; whether it becomes a widget or a Live
    Activity is decided before the native build.

## Open question: the phone control band on native

Canon puts controls in the bottom band; on native the bottom edge is the superapp tab bar. The iOS
gym already hides that tab bar inside a room
(`apps/ios/App/Sources/Gym/Components/GymChrome.swift`, `toolbar(.hidden, for: .tabBar)`). The
owner asked for the trade-off to be laid out before ruling.

## What must be kept

Derived columns with no drag. The *Needs X · N to go* line. Overall progress in the identity row.
The honest placement preview in the creation form. No Complete on a locked step. Retained picker
selection across queries, Apply inactive until the draft changes, steps that cannot be
prerequisites named. The branch chip across all three columns. Complete and Reset outcomes with Undo
and correct regrouping. The 320px stress boards. The note editor on native selection. The dark Board
on the roadmap's night.

## Limits

The pages are static drawings. They do not establish browser focus order or focus restoration,
screen-reader announcements, gesture arbitration between the card swipe, vertical scroll and the
system edges, or 5,000-step performance; those are implementation validation. Prototype route
destinations were scanned on both pages (none cross from dark to light, none reach the Later
sections); the journeys were not walked end to end.
