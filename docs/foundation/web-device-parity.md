# The web as a device

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and roadmap nodes can cite
them.

## §0 Status and scope

**Status:** Specified, and approved by the owner on 2026-11-17; being built. On the web, journal reads and writes the
browser's replica, signed in and signed out, and exports from it. Gym does so for everything, a workout included (§4), and
draws from the browser's copy without waiting for the account (§2): signed out it is the room on the browser's own copy
(§3). The domain's part is built: the refusals of §4's one open workout on every
surface, and the recovery of a start that loses a race, whose sets the web saves from its notice for the recovery to
offer while the phones show the refusal alone ([open problems](local-first-open-problems.md) LP-6); and §8's adoption,
recovery and Coach onboarding import in the web's domain, which claims every file §8 names. §3's sign-in is built on the
web: the shell's hook before the seat changes saves each signed-out workout for adoption, an open one with its sets, the
rack having been written as it changed; gym's device work and its merge, the question's count, the recovery of
a workout the account cannot take in The log, a proposal issued again and the copies the account took let go. Gym's
Coach takes its turn in the browser. The browser
counts a store it cleared (§7) once, with its event. A browser that cannot keep a copy is not supported (§7, R-7), and
every sign-out forgets the journal's pages no account claims (R-9). The
boards for a workout on the web and the signed-out gym are approved (R-10). The build order lives in the Web as a device roadmap tree, which the dogfood tree
(`t_9362d9bc883e0a1e`) opens from the node `web-device-parity`.

**Scope:** What makes gym and journal on the web no different from their siblings on a phone: the
room opens from the browser's copy, gym works signed out, a workout is logged on the web, and the
last reads the browser asks the server for though it holds the data. Also what the browser does
when it cannot keep a copy.

**Out of scope:** Coach's move onto the device, which
[Gym Coach on the AI service](gym-coach-on-ai-service.md) §5 holds; this document adds only what
that one left closed. Roadmap ([Roadmap on the sync engine](roadmap-on-the-engine.md)). Talk
([Journal Talk](journal-talk.md)). The iOS release, which does not wait for this work (R-4).

**Depends on:** the sync engine and the domain kit as built; gym Coach's move for Coach in §4; the
browser's installation credential ([Roadmap Coach](roadmap-coach.md) §11) for signed-out Coach.

## §1 Principles

- **P-1 A product on the web is its device sibling.** It keeps a local copy of a person's data,
  syncs it with the server, and runs every action on that copy. (R-1)
- **P-2 A room opens from the copy.** It draws as soon as the engine has opened the replica, and
  waits for no answer from the network.
- **P-3 The backend is called only for what is the server's by nature** (§6).
- **P-4 One domain, the same vectors.** The web's domain claims every shared vector file its
  siblings claim, and a rule the phones share lives in the domain, not in an app.
- **P-5 Signed out is a seat.** What works signed out on a phone works signed out in a browser, on
  the browser's own copy, and joins the account at sign-in. (R-3)
- **P-6 Screens come from approved boards.**

## §2 Gym opens from the copy

- The gym room draws from whichever replica the engine holds: bound, bound with its session
  paused, or signed out. It does not wait for the account to be confirmed. A paused session is
  offered sign-in beside the room, not in place of it.
- **Before the first pull.** A bound replica that has not finished its first pull of gym's scope
  draws what it has and offers no Start, no last-time values and no records until it has. What
  shows meanwhile is the design's.
- Shares, log shares, the connected log, and Coach until its move, stay behind an account the shell has
  settled: online, or offline from its last answer. A replica bound to another account than the one the
  shell has settled, as when another tab signed someone else in, is not drawn until the shell catches up.
- A write whose replica changed under the room is refused `not-writable`, and its words do not ask
  a person to sign in.

## §3 Gym signed out

Signed out, the gym room is the room, on the browser's `anon` replica.

- **What it holds:** routines, movements, workouts and weigh-ins, as on the phones.
- **What it leaves out, as the phones do:** Notes, shares, log shares and the connected log, which
  need the account, and Coach until the browser holds an installation credential. The web's forms
  for a past workout and for correcting one are left out too: each is a server command, which a
  signed-out replica never sends. (R-5)
- **What it says.** Nothing of where the work is kept, as on the iPhone. A browser can clear a
  site's data where a phone cannot, and the room does not say so. (R-6)

**Sign-in.** Gym supplies what the engine's lineage rule asks of a product, as journal does, and
what the phones do before the replica changes:

- a hook the shell runs before it signs in or finishes a sign-out: the rack is written, then each
  signed-out workout is saved for adoption, and a workout still open has its sets recorded with it;
- the pending device work the engine counts: the workouts saved for adoption and the drafts of
  forms, merged key by key into the account's own rows, so neither side's draft is lost;
- the question's count, which names workouts, routines and weigh-ins;
- after sign-in, a workout the account cannot take is recovered, and a proposal held for it is
  issued again;
- at sign-out, what the browser forgets: Coach's leftovers beside the replica.

The web ports workout adoption and recovery whole and claims `recovery-actions.json`. Its domain
holds the import of the first-run conversation's routines and claims `coach-onboarding-actions.json`;
signed-out Coach and the conversation itself come with Coach's move.

## §4 A workout on the web

The web logs a workout (R-2). It is no longer only a mirror.

- Start from a routine or empty, log and correct a set, change the plan mid-workout, set the rest
  target, finish, hide, and discard a finished workout are the domain's actions the phones run,
  which the web's domain already holds, run on the browser's copy.
- **One open workout.** An account has one open workout, and every device draws it and continues
  it. A start while one is drawn open is refused on the device. A start that loses a race with
  another device is refused `session-open`, and the sets logged under it are recovered. The
  refusals are the phones' rule, which lives in the shared domain's `StartSession` with its
  vectors, as the sync engine's gym binding states.
- **Two tabs are one workout.** The rack and what is on offer are gym's device rows. Every change
  to the rack reads its row and commits it in one local write, so a tab never writes over another's.
  Log set uses the set id the offer row already holds, so one tap in each of two tabs logs one set.
  A plan edit a second tab made stale is refused `stale`, and the design draws that state.
- **Clocks** are computed from the time a set was completed and the server's offset, never from a
  counter, since a hidden tab's timers slow and stop. A sound when rest ends is best effort.
- A workout logged with no connection is kept in the replica and sent when there is one.
- Coach is open during a workout, proposes a change to it with `propose_workout_change`, and the
  person applies it, as on a phone. This lifts the limits
  [Gym Coach on the AI service](gym-coach-on-ai-service.md) §3 and §5 kept for the web.
- The web writes the rest settings it reads today.
- What a phone has that a browser lacks, a Live Activity and a notification with the screen locked,
  the web does without. What it shows instead is the design's.

- **INV-1.** From Coach's move, no gym screen on the web reads or writes a person's training
  through a backend route. Shares and the connected log are the exceptions §6 names.

## §5 Journal

- **Export** is built from the replica's pages. On a bound replica it waits for the first pull of
  journal's scope; signed out it exports the browser's pages.
- **Search by meaning** works with no connection after its first use. Its runtime is served from
  the site and kept by the service worker's cache of assets after first use, and its weights are
  kept in a cache the worker names. Neither joins the offline shell, whose budget they exceed many
  times. Before first use, search by meaning says it needs a connection.
- **Writes** all go through the kit's runner. What the journal's bundle before the engine kept in a
  browser's storage is carried into the replica each seat's pages belong to, while that replica is
  active, as the domain's actions pinned to the engine's active binding, with a ledger in the
  replica's device row `carry:<seat>`; a page leaves the browser's storage only once the ledger records
  it, so it is carried once, whichever replica comes next. The pages that bundle could not attribute
  stay in the browser's storage until a signed-in person restores them, through the runner, or
  discards those listed, which writes nothing to the engine; every sign-out forgets them (R-9).
- Echoes, nudges and Talk are the server's by nature on every surface (§6).

## §6 What stays a backend call

| What | Why |
|---|---|
| Account, sign-in, sessions and the installation credential | identity |
| Windmill One and the allowance | money |
| A link a stranger opens: a shared workout, a shared log, their recipient pages | the server mints and serves it |
| The connected log and MCP | an outside assistant writes as the server |
| A model call: Coach's rounds, Talk, the derivation of echoes | provider keys and metering, through the AI service or the backend |
| What the server sends on a schedule: nudges | the server sends mail |
| Product events and feedback | intake |
| Echo feedback: dismissed, useful, opened | account state the server derives from; the same on the iPhone |

A read or a write outside this table that calls the backend is a defect.

## §7 A browser that cannot keep a copy

A browser that refuses a store, blocks it or fills it is not supported (R-7). The shell shows its one line,
"Couldn't open this device's saved work. Reload to try again.", and nothing more. The browser asks to keep its
storage; where that is denied, nothing is shown.

**Cleared.** A browser can clear a site's storage and keep its session cookie, so the page starts as a new device and
every change it had not sent is gone. The backend remembers each session's replica, the browser counts a clear once,
and nothing tells the person (R-7; [open problems](local-first-open-problems.md) LP-4).

- **What the backend keeps.** Every push answered `200` records its replica as the replica of the session it was
  served through, the cookie's when the request sends one, else the bearer's. `GET /v1/me` reads its caller from the
  same header lines by the same rule (engine §9.1), so it answers that session's replica as `syncReplica`, `null`
  until the session's first accepted push ([backend/AUTH.md](../../backend/AUTH.md)). A new sign-in is a new session,
  so it starts at `null`.
- **What is not a clear.** A re-identify gives the active replica a new id within one session (a push answered
  `replica-forked`, `replica-foreign` or `gap`, and an epoch change; engine §7.11), and `syncReplica` names the old id
  until the new one's first accepted push. So the browser counts a clear only when `syncReplica` is none of the
  replica ids its own store has held that a session can still name (its replicas' and the latest it let go), and
  says nothing on `null`.

## §8 The domain on the web

- The web's kit has the catalog and ability types and the collation rule its siblings have.
- The web's gym domain has workout adoption and recovery and the first-run conversation's import,
  and claims `recovery-actions.json`, `coach-onboarding-actions.json`,
  `coach-conversation-actions.json`, catalog/3 and its abilities, and the collation rules.
- The list of files a surface leaves out is empty for the web, or names a file its own surface
  cannot have, with the reason. The web's names catalog/2 and the server's turn wire, which its
  Coach never speaks, as Android's does, and the words Coach's model reads, which are no vectors.

## §9 Testing

- **Vectors.** Every file of §8, and the one-open-workout rule of §4, run by each surface's domain
  tests.
- **In a browser**, on a local stack:
  - a workout logged signed out and joined at sign-in; one the account refuses, because it has an
    open workout of its own, and its recovery; sign-in into an account whose replica holds drafts;
  - two devices that start with no connection at once; Log set tapped in two tabs on one offer; a
    plan edited in two tabs;
  - a set logged after a cold start with no connection, sent when it returns;
  - Start and export before the first pull on a new browser;
  - sign-out with Keep and with Discard while a workout is open and Coach holds a picture;
  - a session that has expired with the gym room open;
  - search by meaning with no connection after a first use.
- **Boot.** The gym room draws before the account's answer arrives, measured with that answer held.

## §10 Observability

- The web emits for a workout what the phones emit, with no name or id of a workout, a routine or
  a movement: a workout started, a set logged, a workout finished, a plan changed, a rest target
  reached, a workout hidden. The two phones name some of these differently today; the web takes the
  iPhone's names.
- It also emits: gym's sign-in decision, with its count as a bucket; how a signed-out workout's
  recovery ended; a plan edit refused as stale; and a cleared store the backend reported.
- It reports to Sentry, under static names, a write that failed during a workout.
- The web's observability document lists them.

## §11 What the build makes false

Each is corrected in the change that makes it false:

- the product log's line that native apps own workout entry and the web is a live mirror;
- the gym room's README and mirror, and the web's rules file where it says gym keeps its account
  gate;
- [Gym Coach on the AI service](gym-coach-on-ai-service.md) where it withholds the workout proposal
  from the web and keeps Coach closed during a workout;
- the design ledger's entry that the web's mirror has no rack, and the Android task for the
  mirror's planned rows.

## §12 Gaps found beside this work

Three places a phone is behind the web, for the phones' own trees: the iPhone reads a workout's
review and whether a routine exists from the backend, where the web computes both on its copy; and
the iPhone offers no Undo for a delete, where Android and the web hold one.

## §13 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | What the web is to its device siblings | No different: it keeps a local copy, syncs it with the server and runs actions on that copy. (2026-11-17) |
| R-2 | Logging a workout on the web | The web has full workout entry, with Coach open during a workout. (2026-11-17) |
| R-3 | Gym signed out on the web | It opens on the browser's own copy and joins the account at sign-in. (2026-11-17) |
| R-4 | Whether this gates the iOS release | It does not; it runs alongside. (2026-11-17) |
| R-5 | The web's past-workout and correction forms, signed out | Left out signed out; they appear after sign-in. (2026-11-17) |
| R-6 | Whether a signed-out room says its work lives in this browser only | It says nothing. (2026-11-17) |
| R-7 | A browser that cannot keep a copy (refused, blocked, full, cleared) | Not supported: no replica in memory and no screen for those states. The problems it leaves are gathered, for every surface, in [open problems](local-first-open-problems.md). (2026-11-25) |
| R-8 | Whether revoking a session clears that device's copy | Not built: the server would have to remember revoked sessions ([open problems](local-first-open-problems.md) LP-1). (2026-11-25) |
| R-9 | Data no account can be shown to own | Forgotten at sign-out, as the journal's pages from before the engine that no account claims are. (2026-11-25) |
| R-10 | The boards for a workout on the web and the gym signed out | Approved as drawn (Gym file, Web page, WD1–WD9), the drawing answering the questions on their READ ME. (2026-11-25) |
