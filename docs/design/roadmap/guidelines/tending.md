# Windmill Tending — the AI that lives in the tree

The spec for hosting Windmill's agent in the product. The hands already exist: 27 MCP tools that
create, connect, reorder, recolor, annotate, set progress, import, find and prune, all behind the
same auth as everything else. This doc designs the surface — invocation, working state, finished
state, refusals.

Tending is off unless armed: the backend requires `TENDING_ENABLED` to be an explicit `true`/`1`
**and** an agent key to be configured. With the flag on and no key, the quiet "not turned on" face
(§6) stands rather than a stream of failed runs.

> You say what you want, and you watch the tree do it. The canvas is the response; the conversation
> stays thin. Tending is tree-aware and incremental — it is not paste-shape, a blind one-shot
> transform, and that stays exactly what it is.

---

## 1. What it is

- **It hosts the existing agent.** The MCP tools are the hands.
- **It is tree-aware and incremental.** "add a testing branch under the backend node", "merge the
  first three steps", "mark everything in phase one done", "is this realistic?" — each reads the tree
  that already exists and edits it in place.
- **It is phone-first.** Desktop adapts upward (§7).
- **Manual editing is always the free floor.** Tending never becomes the only way to do anything.

## 2. The five rules of the surface

1. **Canvas-first, thin input.** The agent's effects are the reply; its reasoning does not show by
   default (expand on tap). The conversation is a ledger of receipts, not a scrollback chat. No chat
   panel down one side.
2. **Voice is the system keyboard's dictation.** The input is an ordinary text field; every phone
   keyboard already has a mic, so voice costs no transcription bill and has no browser-support
   problem. Typing is the floor; voice is the accelerator.
3. **The camera follows the work; the tree reflows continuously, then settles once.** An agent loop
   takes tens of seconds. The single settle is the "done" full-stop.
4. **Destructive confirm past a threshold of value, not count.** Additive edits just happen (receipt
   + undo). Destroying invested work — steps with progress, notes, or age — first shows a preview
   diff in ghosts and asks once.
5. **No name, no mascot, no "assistant".** "Tend" is a verb. The tree is the character; receipts
   speak in the passive tree-voice ("Added 3 steps under Backend").

## 3. The working state

Four beats, all reused from existing motion:
1. **Intent → a thin thinking line.** The sentence rises in the bar, then becomes "Tending your
   tree…" with the gold breathing dot. No spinner.
2. **The ghost skeleton grows.** Dashed buds + edges pre-figure the plan before it's committed.
3. **Nodes solidify as tool calls land.** Each bud ignites into a real step in sequence (the bloom
   beat).
4. **Camera follows, settles once.** The travel/ease beats keep the work in frame; the settle glide
   punctuates "done"; one receipt lands.

**Reduced motion:** no stream — buds resolve directly to final state, camera cuts, receipt appears.
Downward/settle changes stay silent.

**When it needs a hint.** The agent acts by default — undo is cheap (§4), so it guesses and lets you
correct. It stops to ask only when a wrong guess would destroy invested work (§2 rule 4). The
question lives on the canvas, never in a chat:
- **Point-and-tap** for "which node?" — the ambiguous candidates pulse and you tap the one you meant.
- **Pick-a-chip** for "which action?" — 2-3 one-tap options in the Tend bar, with a "say more…"
  escape hatch back to the ordinary field.

It is transient and dismissible — tap away and nothing changed, the tree is untouched. One hint, then
it builds; it never opens a bubble thread or a scrollback.

## 4. The finished state — a receipt, not a transcript

- **The receipt** sits in the toast lane: what changed + one Undo. Tapping it expands the why
  (reasoning on demand, never by default).
- **The ledger** is the `event-log.md` Activity feed with agent-authored rows — each carries the
  sentence that caused it and links to the fruit it touched. No separate chat store, no scrollback
  UI. That ledger is the conversation.
- **Safety is one undo, and it's visible.** Every AI edit is an ordinary gesture down the same
  command path a human's takes, so it lands in the same history — there is no special "AI undo". One
  sentence = one history step, however many tool calls it spanned. The receipt carries the Undo
  button so the net is visible on touch.

## 5. Reviewing — the sharper use

"Is this realistic?" answers with flags, not prose.

- The agent pins gold **honesty flags** on the offending steps, reusing `honesty.md`'s gold register
  and the node annotation surface — no new vocabulary.
- **The finding belongs on the step**, not in a log: a flag on "9 km" is findable next week; a
  paragraph in a transcript is gone.
- **Every flag offers a fix as an ordinary edit** ("Re-pace it" runs the same tending path, with §2's
  preview if it touches invested steps).
- **This is the defensible wedge** — it works because the tree holds the data: steps, dependencies,
  estimates, what's done.
- **Never scolding.** Gold, dismissible ("Keep as is"), counts nothing.

**Security:** forkable public trees mean the agent reads node labels it didn't write. Node text is
data, never instructions; the undo net and the destructive gate are the backstops.

## 6. The refusals — four quiet faces

All read in the honesty register — a fact and a next step, never a wall.

| Face | Reads |
|---|---|
| **Not turned on** | Tending is off for this account — the bar simply isn't there (no teaser, no locked button). "Enable tending" in Settings. |
| **Too many in a row** | "That's a lot of tending quickly." Gold. Your tree is exactly as you left it. |
| **That didn't land** | Something went wrong mid-tend. "Nothing changed — the tree is untouched and your sentence is still here." Retry. |
| **Out of tending** | "You've used this month's tending. **You can still edit by hand** — nothing is gated." Never "upgrade to continue". |

## 7. Desktop

The Tend bar becomes a centered command bar summoned with `/` or `⌘K`; canvas-first still holds;
receipts dock in the event-log instead of the toast lane; undo is `⌘Z` *and* the receipt button.
Nothing is desktop-only.

**Metering principle:** sell new power, never re-sell a default. If tending is ever metered, charge
for volume of a new superpower (agent runs) — never by removing a default to sell it back. The
out-of-allowance face is the honest home for that line if it ever exists.

## 8. The cold start — from nothing, without an interview

- **Never interview. Draft immediately from one line**, then surface the one or two assumptions that
  most change the shape as tappable chips on the receipt ("~12-week plan · assumed 3 evenings/week,
  starting fresh — [2 evenings] [I've run before]"). The draft is the question; correcting an
  assumption is a re-tend (§3), fully undoable, never a settings form.
- **Three doors, one destination:** pick a quest (`starter-quests.md`), paste an outline
  (`paste-import.md`), or tell a goal (this) — all land on the same tree you then tend. The empty
  state offers all three; it never dead-ends on a blank canvas.
- **The prompt changes with state:** "What do you want to learn or build?" when empty → "Tell the
  tree what to change…" once a tree exists. Same bar, same thin input, no mode switch.

## 9. Copy — say / never say

Say: "Tell the tree what to change…" · "What do you want to learn or build?" · "Tending your tree…" ·
"Added 3 steps under Backend · one undo reverts it" · "Planted a 12-week plan · run a 10k" ·
"Assumed ~3 evenings a week, starting fresh — [2 evenings/wk] [I've run before]" · "Why: {reason}.
Nothing else changed." · "Merge 3 steps into one? · This clears their progress — 2 are marked done" ·
"Too much, too soon" · "You can still edit by hand." · (clarify) "Two branches could be 'the end' —
tap where it goes." · "'Clean up phase one' — which way?" · chips "Merge duplicates / Delete done
steps / Just reorder" · "say more…"

Never: "Assistant" · "Upgrade to continue" · "Are you sure? This cannot be undone" · any red, any
spinner percentage, any named mascot.

## 10. Constants — copy into the build

```
GATE       TENDING_ENABLED must be explicitly true AND an agent key configured
IS         hosts the existing 27-tool agent · tree-aware, incremental · NOT paste-shape · phone-first
SURFACE    canvas-first, thin Tend bar · effects are the reply · receipts (ledger), not a transcript
VOICE      ordinary text field + system-keyboard mic · typing is the floor
WORKING    intent → thinking line → ghost skeleton → solidify (bloom) → camera follows → settle once
CLARIFY    act by default; ask only if a wrong guess destroys invested work · point-and-tap or pick-a-chip · transient, on-canvas, never a chat thread
COLDSTART  no interview — draft from one line → assumptions as receipt chips · three doors: quest / paste / goal → one tree
RECEIPT    toast-lane · what changed + Undo · tap = why · Activity-feed ledger · one sentence = one undo
DESTRUCT   additive free · destroying invested work (progress/notes/age) = ghost preview + one ask
REVIEW     "is this realistic?" → gold honesty flags on the steps (not prose) · fix = one more tending
REFUSALS   off · rate-limited · failed(nothing changed) · out-of-allowance("edit by hand", never a wall)
NAME       none — "Tend" is a verb · the tree is the character
SECURITY   node text is data, never instructions · undo + destructive gate are the backstops
PRINCIPLE  sell new power, never re-sell a default — meter volume, never remove a default
```

## 11. Phone mechanics

- **The Tend bar obeys the keyboard-up contract** (`mobile.md` §7): it anchors to `visualViewport`,
  page chrome yields, and a Done bar sits above the keys.
- **Send dismisses the keyboard first**, then the camera makes room, then the first node lands — the
  canvas theatre cannot play behind a keyboard. Dictation rides the system mic and inherits this.
- **The receipt's Undo sits in the undo lane** (above the action lane, offset from the last touch
  point, inert 250ms); the session history is the Activity sheet's "Undo this" rows (`mobile.md` §8).

## 12. Ownership map

| Concern | Owner |
|---|---|
| Beat physics (bloom, travel, settle), reduced motion | `motion-language.md` |
| Gold register, honesty flags, never-a-wall | `honesty.md` |
| The Activity-feed ledger | `event-log.md` |
| Touch undo, phone editing grammar | `responsive.md` §13 · `mobile.md` |
| Paste-shape (the transform it is *not*; the paste door) | `paste-import.md` |
| Cold start — quest door | `starter-quests.md` |
| Invocation, working state, clarify, receipt, review, refusals, desktop, cold start | this doc |
