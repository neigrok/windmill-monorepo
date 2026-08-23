# The journey — entry, anonymous use, and per-app onboarding (S2)

Companion to `guidelines/superapp-shell.md`. That doc rules the chrome between
the apps; this one rules **how a person gets in, what they can do before they
have an account, and what each app's first run must be**. Live board:
`templates/superapp-flow/SuperappFlow.dc.html`.

**Status:** designed Aug 2026 alongside the shell. Not yet built. The web
product's auth conduct (`roadmap/guidelines/auth.md`) is the parent — nothing
here contradicts it; iOS only adds where the first run differs on a phone.

---

## 1. The principle

> **You arrive, you make one real thing, and only then does the app admit it has
> three rooms.** An account is an *adoption* of what you already made, never a
> gate in front of making it.

The full first launch is five beats: open → one question → the app → the first
artifact → the house, once. Signing in is a sixth beat that may never happen,
and the product must be complete without it.

## 2. Where the journey starts — decided

**Not the hub.** A hub of three empty rooms is a chore list, and three empty
states are the worst first impression a superapp can make. First launch shows
**one question — "What do you want to do first?" — in three plain verbs**
(plan something big · write tonight · log a workout), plus a skip.

- **One tap goes straight into that app's first run.** The chosen room is
  remembered as the launch destination.
- **The skip ("just show me around") lands on the hub**, which is then allowed
  to be empty — the user asked to look around.
- **No splash, no value proposition, no carousel.** The App Store listing sold
  the product; repeating the pitch inside is a tax on the people who already
  bought in.
- **No account, no permissions on this screen.** Nothing is asked for before
  anything is given.
- **Returning launches reopen the last room you stood in**, signed in or not.
  The hub is a place you go, never a toll gate.

## 3. Signed out is a first-class state

- **Everything works**: all three apps, unlimited hand editing, and every device
  feature that doesn't require an identity. Nothing is disabled, dimmed, or
  countdown-limited. **One bounded exception — agent runs — is specified in §3a**;
  it is a cost boundary, not a paywall, and no *product* capability sits behind it.
- **Local is the truth** until a claim happens; the shell states this **once**,
  in You: *"your trees, entries and sets live on this device."* A fact, next to
  the door — not a nag.
- **The You screen is the only unprompted mention of signing in.** Account verbs
  the user initiates (share a tree, use a second device, restore a purchase)
  open the same door and **resume the action afterwards**.
- **Never**: on launch · on a timer · after N edits · on exit intent · as a
  banner · as "save your work". **Nothing counts declines** — no cooldowns, no
  escalation, no third-ask copy.
- **Windmill One is not shown while signed out.** There is nothing to bill and nothing to
  restore; the upsell would land before the product has earned it.
- Sign-out keeps local copies editable, no confirmation dialog (auth.md §4).

## 3a. Agent runs while signed out — the one bounded exception

A tending is a **server-side agent loop that bills per run**, and the free
allowance in `marketing/guidelines/pricing.md` §1 is **per account**. Roadmap's
"Plant it" and Gym's "Build my routine" both fire *before* anyone has signed in,
which would make a brand-new user's first action an unauthenticated billable
call — and would let a script mint device ids indefinitely. Journal is
unaffected: its first run spends nothing.

**These must be true:**

1. **Every first run reaches a real artifact with zero agent calls.** Roadmap:
   starter quests + blank tree. Gym: the three ready routine templates. Journal:
   the cursor. The template path is the *floor*, not the escape hatch — if the
   agent is unavailable for any reason, the first run still completes.
2. **An unclaimed device gets one agent run, ever** — not one per month — gated
   by platform attestation (App Attest), issued server-side, bucketed by IP, and
   **not restored by reinstall**. Anonymous runs are metered on their own ledger,
   never against an account's 30.
3. **Spent, unavailable, or unattested ⇒ the agent button falls back to the
   template path** with one plain line ("Windmill can write this once you're
   signed in — or pick a starting shape"). It is **never** a sign-in wall, and it
   never counts declines.
4. **On claim, the anonymous ledger is closed, not carried.** The account's
   monthly allowance starts whole; the device's spent run is not re-charged and
   not refunded.
5. A failed or refused run **costs nothing** — the ledger decrements on a
   completed result only.

**Open, and not this doc's to settle alone:** `pricing.md` §1 grants 30/month to
accounts and says nothing about anonymous devices. Adding "one attested run per
device" is a pricing change with a backend cost model attached; pricing +
backend own it. Ledgered in `consistency.md`.

## 4. The claim

Mechanics are auth.md's, unchanged in substance: one door, no passwords, adoption
is additive and uncelebrated. **The door's order differs on iOS**, and that
difference is settled, not proposed:

1. **Sign in with Apple leads on iOS**; "Email me a link" is the ghost secondary
   below it. **Google does not appear in the native app at all** — its flow is a
   browser redirect the app does not implement, and a button that cannot work is
   worse than an absent one. The web door is unchanged (magic link leads,
   Google secondary): same account, keyed by email.
2. The door is a sheet, opened from You or from the action that needed it.
3. On success, the sheet dismisses **back into what the user was doing** — the
   claim never costs the user their place.
4. Local work becomes the account's by union; nothing merges by content.

## 5. Onboarding, per app — the shared shape

Each app owns its own first run. All three must follow the same three rules:

> **One prompt · one tap to something real · nothing to dismiss.**

- The first run **is the real surface** with its opening move filled in — not a
  screen about the surface. No tours, no coach marks, no progress dots, no
  "you're all set" screen.
- **At most one screen** before real work. A second onboarding screen is a
  redesign, not an addition.
- **No permission is requested before the feature that needs it** — notifications
  are asked for when a reminder is set, never during the first run.
- Every setting an app might want at setup is either **inferred, deferred, or
  carried inline** with the first real action.
- Onboarding copy **retires after the first artifact** and never returns.

| App | The prompt | One tap to | Carried inline | Retires when |
|---|---|---|---|---|
| **Roadmap** | "What are you working toward?" — one sentence, three example chips, blank-tree escape | a planted tree (the first tending is pre-spent here) | nothing | the tree exists |
| **Journal** | The cursor, already blinking, with "How was today?" as placeholder — not a prompt to answer | writing; mood/energy stay optional chips | the privacy fact, one line | the first entry is saved |
| **Gym** | "How do you train?" — three ready routine templates, or one sentence the agent turns into a routine | a routine, with today's day chosen, one tap from the logger | kg/lb toggle, and a "just log freely" escape | the first set is logged |

**Why Gym starts with a routine, not a movement:** the logger's whole advantage is
prefill — target sets, target reps, last time's weight — and none of it exists
until a routine does. A first run that jumps straight to a bare set logger ships
the product's weakest version first. The routine is Gym's equivalent of the tree:
the structure everything else hangs on.

**Routines are agent-writable, and MCP-writable.** "4 days, upper/lower, no
deadlifts, 45 minutes" is a **tending** — same agent, same allowance, same visible
receipt as planting a tree (`marketing/guidelines/pricing.md`). Because the
routine is a plain artifact and not first-run-only state, the same call belongs on
the hosted MCP server (`roadmap/guidelines/mcp-connect.md`), which means a coach's
plan, a Claude conversation, or a script can write a routine that simply appears
on this screen. Requirements that follow: **a routine written by an agent must be
indistinguishable from a hand-built one** (same shape, same editability, no
read-only "AI plan" mode), and **it must land editable, never auto-started**.

**Why Roadmap spends its run on the first screen:** the paste-to-tree moment is
the product's best trick, and a first run that describes it instead of doing it
wastes the one moment a new user is paying full attention. It is the device's
single attested run (§3a), and the blank-tree/quest path beside it costs nothing.

## 6. The house — shown once

After the first real artifact, a sheet introduces the other two rooms: *"Your
tree is planted. Windmill has two other rooms."* One line each, same account,
nothing to install.

- **Introduced, not sold.** No feature lists, no screenshots, no "try it free".
- **Once, ever.** Dismissing returns to work; the rooms remain in the switcher.
- If the user skipped to the hub at §2, this sheet never fires — they've seen
  the house.

## 7. What this doc requires of the build

1. The launch destination must be **persisted per device** (last room), and must
   survive sign-in, sign-out and app updates.
2. Each app must expose a **first-run complete** signal, so the shell knows when
   to fire the house sheet and when to retire onboarding copy.
3. Anonymous identity must be **stable across app updates** — a lost local
   identity is lost user work, which is the one unrecoverable failure in this
   flow.
4. The claim must be **resumable**: whatever opened the door is re-entered after
   success, with its state intact.

## 8. Held open

- Does the skip land on the hub, or on Roadmap as a default room?
- Does the house sheet fire on the **first capsule tap** instead of on the first
  artifact — a discovery beat rather than a reward beat?
- Notification permission: after the first entry, or never until the user sets a
  reminder themselves (currently the stricter second).
