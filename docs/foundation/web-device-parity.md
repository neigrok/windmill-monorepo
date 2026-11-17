# The web as a device

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and roadmap nodes can cite
them.

## §0 Status and scope

**Status:** Specified; not approved, and nothing is built. On the web, journal already reads and
writes the browser's replica, signed in and signed out. Gym does so for everything but a workout:
it is a sign-in door when signed out, a live mirror of a phone's workout, and it waits for the
account before it draws. Gym's Coach runs on the server. The build order lives in the Web as a
device roadmap tree, which the dogfood tree (`t_9362d9bc883e0a1e`) opens from the node
`web-device-parity`.

**Scope:** What makes gym and journal on the web no different from their siblings on a phone: the
room opens from the browser's copy, gym works signed out, a workout is logged on the web, and the
last reads the browser asks the server for though it holds the data. Also what the browser does
when it cannot keep a copy.

**Out of scope:** Coach's move onto the device, which
[Gym Coach on the AI service](gym-coach-on-ai-service.md) §5 holds; this document adds only what
that one left closed. Roadmap ([Roadmap on the sync engine](roadmap-on-the-engine.md)). Talk
([Journal Talk](journal-talk.md)). The iOS release, which does not wait for this work (R-4).

**Depends on:** the sync engine and the domain kit as built; gym Coach's move for §4.

## §1 Principles

- **P-1 A product on the web is its device sibling.** It keeps a local copy of a person's data,
  syncs it with the server, and runs every action on that copy. (R-1)
- **P-2 A room opens from the copy.** It draws as soon as the engine has opened the replica, and
  waits for no answer from the network.
- **P-3 The backend is called only for what is the server's by nature** (§6).
- **P-4 One domain, the same vectors.** The web's domain claims every shared vector file its
  siblings claim. A file the web does not claim is a gap, not a choice.
- **P-5 Signed out is a seat.** A room that works signed out on a phone works signed out in a
  browser, on the browser's own copy, and joins the account at sign-in. (R-3)
- **P-6 Screens come from approved boards.**

## §2 Gym opens from the copy

- The gym room draws from the replica the engine holds, bound or signed out, as journal does. It
  does not wait for the account to be confirmed.
- A write on a replica the person may not write is refused by the domain, as it is today.

## §3 Gym signed out

- Signed out, the gym room is the room, on the browser's `anon` replica: routines, movements,
  workouts, notes and weigh-ins, with no account.
- Sign-in follows the engine's lineage rule: gym's work is added without asking to an account that
  holds no gym records, and otherwise by the person's Add or Discard, with the counts the engine
  pins. Sign-out asks Keep or Discard for what is unsent.
- A signed-out workout the account cannot take is recovered as on the phones: the web ports
  `WorkoutRecovery` and claims `recovery-actions.json`.
- Signed-out Coach in a browser, and the first-run conversation the phones have, come with Coach's
  move and need the browser's installation credential ([Roadmap Coach](roadmap-coach.md) §11).
  The web then claims `coach-onboarding-actions.json`.

## §4 A workout on the web

The web logs a workout (R-2). It is no longer only a mirror.

- Start from a routine or empty, log and correct a set, change the plan mid-workout, set the rest
  target, finish and discard are the domain's actions the phones run, which the web's domain
  already holds, run on the browser's copy.
- The rule for a workout open on another device is the one two phones follow. The web invents none.
- The workout's place, the rack and what is on offer live in the gym device rows the phones use.
  Two tabs of one browser share them, so a workout is one workout in every tab.
- A workout logged with no connection is kept in the replica and sent when there is one, as on a
  phone.
- Coach is open during a workout, proposes a change to it with `propose_workout_change`, and the
  person applies it, as on a phone. This lifts the two limits
  [Gym Coach on the AI service](gym-coach-on-ai-service.md) §5 kept for the web.
- The web writes the rest settings it reads today.
- What a phone has that a browser lacks, a Live Activity and a notification with the screen locked,
  the web does without. What the web shows instead is the design's.

- **INV-1.** No gym screen on the web reads or writes a person's training through a backend route.
  Shares and the connected log are the exceptions §6 names.

## §5 Journal

- **Export** is built from the replica's pages. The browser asks the backend for none of them.
- **Search by meaning** works with no connection after its first use: its worker joins the offline
  shell and its runtime is served from the site, within the shell's size budget, or loads on first
  use with a stated offline state where it does not fit.
- **Writes** all go through the kit's runner: the three that write records around it are brought
  under it.
- Echoes, nudges and Talk are the server's by nature on every surface (§6).

## §6 What stays a backend call

| What | Why |
|---|---|
| Account, sign-in and sessions | identity |
| Windmill One and the allowance | money |
| A link a stranger opens: a shared workout, a shared log, their recipient pages | the server mints and serves it |
| The connected log and MCP | an outside assistant writes as the server |
| A model call: Coach's rounds, Talk, the derivation of echoes | provider keys and metering, through the AI service or the backend |
| What the server sends on a schedule: nudges | the server sends mail |
| Product events and feedback | intake |
| Echo feedback: dismissed, useful, opened | account state the server derives from; the same on the iPhone |

A read or a write outside this table that calls the backend is a defect.

## §7 A browser that cannot keep a copy

A phone always has its store. A browser can refuse one, or clear it.

- **Storage refused.** The shell settles the account and opens the rooms on a replica held in
  memory. The person is told once that this browser is keeping nothing, and each room says a change
  is saved only once the server has it.
- **Storage cleared.** The engine keeps a marker outside its store. A replica that is gone while
  the marker says one existed is told to the person once, and the browser starts as a new device.
- **Persistence.** The browser asks to keep its storage. Where it is denied, nothing more is shown.

## §8 The domain on the web

- The web's kit gains the catalog and ability types and the collation rule its siblings have.
- The web's gym domain gains workout recovery and the first-run conversation, and claims the files
  it leaves out today: `recovery-actions.json`, `coach-onboarding-actions.json`, and with Coach's
  move `coach-conversation-actions.json`, the catalog, the abilities and the collation rules.
- The list of files a surface leaves out is empty for the web, or names a file its own surface
  cannot have, with the reason.

## §9 Testing

- **Vectors.** Every file of §8, run by the web's domain tests.
- **In a browser**, on a local stack: a workout logged signed out and joined at sign-in; a workout
  logged in two tabs; a set logged after a cold start with no connection, sent when it returns; a
  workout opened on a phone and continued on the web, by the phones' rule; storage refused, and
  storage cleared.
- **Boot.** The gym room draws before the account's answer arrives, measured with that answer held.

## §10 Observability

- The web emits for a workout the events the phones emit, by the same names, with no name of a
  workout, a routine or a movement.
- It emits one event when a room opened on a replica in memory and one when a cleared store was
  found, and reports to Sentry a store that failed to open for a reason other than refusal.
- The web's observability document lists them.

## §11 What the build makes false

The lines that say native apps own workout entry and the web is a live mirror, that the gym room is
account-only, and the web's lists of the vector files it claims: in the product log, the gym room's
README and mirror, the sync folder's README and the domain kit's document. Each is corrected in the
change that makes it false.

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
