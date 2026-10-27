# Roadmap Board design review

Review date: 2026-10-27. Status: 💡 proposal, **not Ready for dev**. Nothing in Figma or the
product changed; the [proposal](roadmap-board-proposal.md) stays the implementation reference once
the findings below are applied.

Three independent reviews were run and arbitrated: a canon-aware designer on the
[mobile page](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900) (all 16
sections, 20 frames zoomed, metadata measured), a canon-aware designer on the
[desktop page](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901) (all 9
sections), and a UX skeptic with no access to the repo or the canon who judged the board idea from
the drawings alone. The seven findings resolved on 2026-10-25 were re-checked and hold.

## Verdict on the idea

A derived-status board is the right second view. It answers the question the graph fails on a
phone, *what can I do right now*, and because columns follow prerequisites it cannot lie: nothing is
dragged, no status is self-reported. All three reviews agree the pattern stays. What it hides is
what the graph was for: depth and distance. A locked card one step away and one five steps away
look identical, and a ready column of twelve cards gives no reason to pick one first. The fixes are
on the card, not in the layout.

Mobile keeps the canon almost to the letter (identity top, reading band middle, 116px control band
bottom, every target 44px, ~18 chrome words on the board, ~20 on a node page) and its skeleton can
carry the native apps. Desktop is an eight-card specimen missing the shipped product's vocabulary,
verbs, auth states, interaction states and scale.

## Findings that block approval (P1)

- **Closed is the wrong word, and the state has four names.** Column *Closed* carries a lock
  glyph; the empty state says *No ready nodes*; the completion toast says *1 node ready*; the reset
  toast says *2 nodes blocked*; canon names the tiers locked · available · complete. On every board
  the owner is borrowing from, Closed means finished. Rename to **Locked · Ready · Done** (Ready
  matches the toasts and the tier; Up next promises an order the sort does not deliver) and use one
  word per state in every toast, empty state, the Graph's status line and MCP responses.
  Mobile 183:1503, 183:1795, 185:1885, 185:2196; desktop 184:1543, 193:1494, 294:9153.
- **Node replaces the shipped step.** *Search nodes*, *New node*, *Needs 2 nodes*, *Open node page*.
  The shipped roadmap says *Name this step*, *Find a step*, *Add step to …*; canon calls vocabulary
  divergence a defect. Use **step** everywhere. Every frame on both pages.
- **Desktop never draws the core loop.** No completion result, reset result, Undo toast, save retry,
  loading or load error exist at 1440; mobile has all five. Draw Complete → outcome (the newly ready
  card arriving in Ready, toast with Undo), Reset → outcome, and the three recovery states.
- **Desktop exists only signed in.** Every desktop frame shows the avatar; the proposal's own line
  *saved on this device* and the shared-reader variant (no edit controls, no workspace, Fork offer)
  are drawn only on mobile (04.02, 07.04). Draw both at 1440.
- **Nothing between 390 and 1440, and a cliff at 1024.** 193:1552 is text, not a drawing: 744–1023
  is one column, 1024 is three 314px columns, and which chrome set the middle band uses is unsaid.
  Draw 1024 and ~900; add a two-column stage; name the chrome per band.
- **Density beyond eight cards is undefined.** Columns are fixed 764px, headings hide counts by
  decision, and the proposal's own fixture has 3,200 Done cards. Per-column scroll with sticky
  heading, counts on headings and segments (*Locked 3 · Ready 2 · Done 3*), Done collapsed above a
  threshold, a virtualization requirement for dev, and one 30-card and one 300-card column drawn.
- **The desktop prerequisite picker is a phone sheet.** 232:2615 anchors a 600px panel over the
  creation modal it came from, search at the bottom, Review/Results modes, Cancel top-right.
  Desktop: search on top, selected chips pinned under it, results below, Cancel + Apply at the
  bottom, draft still visible, no modes. Keep the retained-selection behaviour.

## Fix before dev (P2)

Shared

- **Put distance and reason on the card.** Locked: *Needs Read the wind · 2 steps away*, sorted
  nearest first; *Needs 2 nodes* becomes *Needs Sail a triangle +1*. Ready: *Unlocks 1 · Leave the
  dock*. Default sort becomes roadmap order (depth from the roots, then unlocks count); Created and
  Unlocked stay as secondary keys, and Unlocked is hidden until `unlockedAt` is persisted.
- **Creation is hidden in a one-item More sheet** on both surfaces (258:4895, 260:5154). A visible
  *New step* control: a 44px plus in the mobile band, a button in the desktop identity row. More
  exists only with two or more rows, and as a popover, not a titled dialog.
- **Colour tags lose their names.** Cards, the filter sheet and the editor show unnamed dots; the
  product has named kinds and a legend. Label every swatch with its kind name in the filter sheet
  and the editor; a colour-blind user cannot filter today.
- **Card borders carry kind hue; locked cards are not dimmed.** The 2px perimeter border was the
  2026-10-25 answer to a dot that reserved a card row, so this is a ruling, not a slip: canon says
  borders are neutral, tier is carried by treatment and locked is dimmed, and on the board a locked
  olive card and a done olive card are equally bright while the loudest signal (hue) carries the
  least important fact (kind). Recommended: neutral border, kind as a small marker inside the title
  row, locked at the dimmed tier. No hover, focus, pressed or selected card state is drawn on either
  surface, and the brand focus ring will collide with a coloured border; add a card state sheet.
- **The right-side glyph duplicates the column** (chevron / lock / check) and makes locked and done
  cards look untappable. One glyph rule: state only, or chevron on all.
- **Picker chrome is over-built for the common roadmap.** Keyboard raised over an eight-node list,
  Review ↔ Results mode switch, ID line on every row. Keep search-first for large roadmaps; do not
  raise the keyboard when the roadmap fits; a selected-chips strip replaces Review; IDs only on
  title collision.
- **Save failure offers Cancel as the only non-retry exit** (185:2292, 226:788) after a banner that
  promised the draft is kept. Secondary becomes *Keep editing*; Cancel asks *Discard draft?* once.

Mobile

- **Complete leaves the page, and the checklist banner has no verb.** Complete from the node page
  returns to the Board with a toast (01.04 → 01.05), losing the unlocks, note and links the person
  was reading. The last checked subtask stays on the page (ruled 2026-10-25: subtasks never complete
  the step) but shows *Up next · Undo* with no verb, so *undo what?* has no answer (07.06). One
  rule: Complete stays on the page, the status row flips to Done with inline Undo, Complete becomes
  Reset, *1 step ready* as a secondary line; the checklist banner names what it undoes or goes.
- **Marking done costs three taps.** Add a leading swipe-to-complete on Ready cards, accessible
  action declared, firing the toast already drawn in 01.05, never a full-swipe commit.
- **The anonymous board does not say it is local-only** (188:1585). One line, the List's words:
  *Saved on this device — sign in to keep it*.
- **Loading is a spinner that drops all chrome** (185:2250, 185:2266) against the no-spinner law.
  Keep shell, identity and band; two 76px card skeletons.
- **View node on a locked page is ambiguous** (183:1795): the row above is the same destination.
  *Open Read the wind*, or no primary and the row is the way through.

Desktop

- **Two detail surfaces for one thing** (184:1693, 208:359), paid for with a third stacked
  full-width button. One URL-addressable modal with Copy link in its menu; the page only as what a
  shared link lands on.
- **Modal tabs sit under the content they switch** (y≈706 of 800). Tabs under the title, actions
  pinned at the bottom.
- **The Board drops the roadmap's verbs.** Share, the ⌘K door, What's next, Fork, Export and
  Settings have no place when Board is active, and the Graph handoff (260:5978) wears the Board's
  identity row instead of its ControlBar. One row listing every roadmap-level verb for both views.
- **Ready has no primacy.** Three identical headings; nothing says *this is yours to do*. Keep the
  timeline order if intended, but weight the Ready heading or put it first, and say which.
- **Search has no clear and no recovery** (261:7058): no ×, and the empty columns offer no way out.

## Polish (P3)

Empty roadmap keeps a full band and puts *New node* mid-frame (185:2149, pin it in the reach band
and hide the band until the first step); no roadmap-complete state at 8/8; Activity sheet closes
three ways including a full-width primary *Close activity* (228:1179); the keyboard specimen cuts
the colour row in half (188:1636); Cancel sits top-right, top-left or × only across sheets; the
node page's back label always names the roadmap even when pushed from another node; the Activity
icon is a waveform; captions that explain a heading (*Recent activity for this node.*) or repeat an
adjacent glyph (*Finish Read the wind to unlock.*); 294:9949 calls a four-step drawing *Full
roadmap* on an eight-step roadmap.

## Owner decisions

1. **Column names.** Locked · Ready · Done (recommended: matches the tiers and the toasts) or
   Locked · Up next · Done.
2. **Where the phone's control band lives on native.** Canon puts controls in the bottom band; the
   skeptic notes that on native the bottom edge is the superapp tab bar. Recommended: inside a
   roadmap the shell tab bar yields, as Gym's open session does, and the segments + search band owns
   the bottom. The alternative (segments under the title, platform search) means two mobile designs.
3. **Activity overlay in the board's first wave.** The skeptic and the desktop review both read it
   as chrome creep that invites checking rather than doing; the node's History tab covers the owner
   case. Recommended: defer it from the board's first wave. Workspace stays, it is a shipped feature.
4. **Completion gesture on phones.** Leading swipe on Ready cards, or page-only.

## Native-foundation decisions to pin now

1. Node page is a push with back-swipe and deep link; Filter, Sort, More are sheets that commit
   nothing on dismiss; picker and note editor are full-screen modals with Cancel and a commit.
2. One Cancel/commit geometry on every modal: Cancel top-left, commit top-right or pinned bottom.
3. The segmented control is the platform's, with swipe between columns as a paged container and
   the visible segments as the accessible path.
4. Search placement is Windmill's band on all three surfaces, since the band also holds the
   segments and the filter.
5. State words (decision 1) are the nouns in toasts, empty states, the Graph status line and MCP.
6. Kind names travel with colour, so the legend and the filter sheet are built once.
7. Back-stack honesty for step → step navigation: push, back label names the previous screen, no
   *Back to Board* primaries.
8. *N steps ready* is the one roadmap number worth a glance; decide whether it is a widget or Live
   Activity candidate before the segments lose their counts.

## What must be kept

Derived columns with no drag. The *Needs X* line. Overall progress in the identity row. The honest
placement preview in the creation form. No Complete on a locked step. Retained picker selection
across queries, Apply inactive until the draft changes, cycle-blocked steps named. The branch chip
(*Branch · Read the wind ×*) across all three columns. Completion and Reset outcomes with Undo and
correct regrouping. The 320px stress frames. The note editor on native selection. The dark board on
the roadmap's night.

## Verification and limits

Every section on both pages rendered; no screenshot failed. Measurements come from Figma metadata
(mobile: shell 52 + identity 60, body 616, band 116, card 358×76, node page band 128; desktop:
identity 64, filter 44, columns 453.33, Closed card 102, modal 760). Screenshots are in the session
scratchpad, not the repo. Nothing here establishes browser accessibility, focus order or
5,000-step performance; those remain implementation validation.

## Resolved on 2026-10-25 and still holding

The inventory is 94 mobile and 39 desktop compositions plus 19 overlay assets. Selected Overview
tab contrast (17.06:1 light, 15.72:1 dark); completion, reset and creation outcomes keep coherent
Undo routes and counts; the 320px large-roadmap specimen opens its own context; dark routes stay
dark; clearing a picker query never changes the selection; creation and edit can remove a
prerequisite and return the matching draft; desktop review removes one selection and retains the
other. Node sections (286:3838), the shared Shell (290:7085), the authored description field
(291:4098) and the detail identity rail (306:4743) are linked component instances; checked subtasks
leave the step and progress unchanged (the web's 600ms auto-completion is recorded as an
implementation gap); storage badges are gone; colour is chosen inline in the form; long content
holds at 390 and 320; View branch exposes anchor, ancestors and descendants; the note editor has a
selection → Link → URL → linked draft → Done journey with a 320px specimen. Codex evidence folders
for these are named in the git history of this file.
