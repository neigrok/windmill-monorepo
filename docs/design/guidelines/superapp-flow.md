# The journey — entry, anonymous use, and per-app onboarding (S2)

Companion to `guidelines/superapp-shell.md`. That doc rules the chrome between the apps; this
one rules how a person gets in, what they can do before they have an account, and what each
app's first run must be. The web product's auth conduct (`roadmap/guidelines/auth.md`) is the
parent; iOS only adds where the first run differs on a phone.

---

## 1. The principle

You arrive, you make one real thing, and only then does the app admit it has three rooms. An
account is an *adoption* of what you already made, never a gate in front of making it.

First launch is five beats: open → one question → the app → the first artifact → the house,
once. Signing in is a sixth beat that may never happen, and the product is complete without it.

## 2. Where the journey starts

**Not the hub.** First launch shows one question — "What do you want to do first?" — in three
plain verbs (plan something big · write tonight · log a workout), plus a skip.

- **One tap goes straight into that app's first run.** The chosen room is remembered as the
  launch destination.
- **The skip ("just show me around") lands on the hub**, which is then allowed to be empty.
- **No splash, no value proposition, no carousel.**
- **No account, no permissions on this screen.**
- **Returning launches reopen the last room you stood in**, signed in or not. The hub is a
  place you go, never a toll gate.

## 3. Signed out is a first-class state

- **Everything done by hand works**: all three apps, unlimited editing, every read, and every
  device feature that doesn't require an identity. Nothing is disabled, dimmed, or
  countdown-limited. The one exception is tending — a server-side agent loop metered per
  account, so it needs an account (`superapp-shell.md` §9a).
- **Local is the truth** until a claim happens; the shell states this **once**, in You: *"your
  trees, entries and sets live on this device."*
- **The You screen is the only unprompted mention of signing in.** Account verbs the user
  initiates (share a tree, use a second device, tend, restore a purchase) open the same door
  and **resume the action afterwards**.
- **Never**: on launch · on a timer · after N edits · on exit intent · as a banner · as "save
  your work". **Nothing counts declines** — no cooldowns, no escalation, no third-ask copy.
- **Windmill One is not shown while signed out.**
- Sign-out keeps local copies editable, no confirmation dialog (`auth.md` §4).

**Every first run reaches a real artifact with zero agent calls.** Roadmap: starter quests +
blank tree. Gym: the three ready routine templates. Journal: the cursor. The template path is
the floor, not the escape hatch — if the agent is unavailable for any reason, the first run
still completes.

## 4. The claim

Mechanics are `auth.md`'s: one door, no passwords, adoption is additive and uncelebrated. The
door's order differs on iOS:

1. **Sign in with Apple leads on iOS**; "Email me a code" is the quiet secondary below it, and
   takes the primary treatment when Apple sign-in is not configured. **Google does not appear in
   the native app at all** — its flow is a browser redirect the app does not implement. The web
   door leads with the magic link, Google secondary: same account, keyed by email.
2. The door is a sheet, opened from You or from the action that needed it.
3. On success, the sheet dismisses **back into what the user was doing**.
4. Local work becomes the account's by union; nothing merges by content.

## 5. Onboarding, per app

Each app owns its own first run. All three follow the same three rules:

> **One prompt · one tap to something real · nothing to dismiss.**

- The first run **is the real surface** with its opening move filled in. No tours, no coach
  marks, no progress dots, no "you're all set" screen.
- **At most one screen** before real work.
- **No permission is requested before the feature that needs it** — notifications are asked for
  when a reminder is set, never during the first run.
- Every setting an app might want at setup is **inferred, deferred, or carried inline** with
  the first real action.
- Onboarding copy **retires after the first artifact** and never returns.

| App | The prompt | One tap to | Carried inline | Retires when |
|---|---|---|---|---|
| **Roadmap** | "What are you working toward?" — one sentence, three example chips, blank-tree escape | a planted tree | nothing | the tree exists |
| **Journal** | The cursor, already blinking, with "How was today?" as placeholder | writing; mood/energy stay optional chips | the privacy fact, one line | the first entry is saved |
| **Gym** | "How do you train?" — three ready routine templates, or one sentence the agent turns into a routine | a routine, with today's day chosen, one tap from the logger | kg/lb toggle, and a "just log freely" escape | the first set is logged |

Gym starts with a routine, not a movement: the logger's advantage is prefill — target sets,
target reps, last time's weight — and none of it exists until a routine does.

**Routines are agent-writable and MCP-writable.** "4 days, upper/lower, no deadlifts, 45
minutes" is a tending — same agent, same allowance, same visible receipt as planting a tree.
Because a routine is a plain artifact, the same call belongs on the hosted MCP server
(`roadmap/guidelines/mcp-connect.md`), so a coach's plan, a Claude conversation or a script can
write a routine that appears on this screen. Two requirements follow: a routine written by an
agent is **indistinguishable from a hand-built one** (same shape, same editability, no
read-only "AI plan" mode), and it **lands editable, never auto-started**.

## 6. The house — shown once

After the first real artifact, a sheet introduces the other two rooms: *"Your tree is planted.
Windmill has two other rooms."* One line each, same account, nothing to install.

- **Introduced, not sold.** No feature lists, no screenshots, no "try it free".
- **Once, ever.** Dismissing returns to work; the rooms remain in the switcher.
- If the user skipped to the hub at §2, this sheet never fires.

## 7. What this doc requires of the build

1. The launch destination is **persisted per device** (last room), and survives sign-in,
   sign-out and app updates.
2. Each app exposes a **first-run complete** signal, so the shell knows when to fire the house
   sheet and when to retire onboarding copy.
3. Anonymous identity is **stable across app updates** — a lost local identity is lost user
   work, the one unrecoverable failure in this flow.
4. The claim is **resumable**: whatever opened the door is re-entered after success, with its
   state intact.

## 8. Held open

- Does the skip land on the hub, or on Roadmap as a default room?
- Does the house sheet fire on the first capsule tap instead of on the first artifact?
- Notification permission: after the first entry, or never until the user sets a reminder
  themselves (currently the stricter second).
