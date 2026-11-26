# Open problems of the local copy

Every surface keeps a local copy of a person's data, syncs it with the server and runs every action on that copy
([the sync engine](engine.md), [the web as a device](web-device-parity.md)). The problems below follow from that idea
and are the same on the web, the iPhone and Android. They are not settled: the owner rules on them together. When one
is ruled, its ruling moves into the spec it belongs to and the entry leaves this file. What a surface does today is
stated where it was read or run; "not surveyed" says where it was not.

## LP-1 A device keeps an account's data after its session ends

A session that expires, is revoked from Settings → Sessions or is signed out on another device leaves the device's
copy in place.

- **Web:** the bound replica pauses and its rooms keep drawing it, with sign-in at the account seat
  (web-device-parity §2). Whoever holds the browser sees that account's journal, training, weigh-ins and notes, and
  a change they make is kept in the browser and sent if that account signs in again there. Settings alone stays a
  sign-in door there: signed out it opens on the browser's own copy with its exports, and drawing those sections over a
  lapsed account's copy would hand its journal and roadmaps over as files.
- **iPhone, Android:** not surveyed.
- **Ruled 2026-11-25:** revoking a session does not clear the device's copy. Telling a revoked session from an expired
  one needs the server to remember revoked sessions, which it does not.
- **Open:** whether a device that learns its session is gone keeps showing the copy, and for how long.

## LP-2 Data no account can be shown to own

**Ruled 2026-11-25:** data in this situation is forgotten at sign-out. The first case built is the journal's
unattributed pages from before the engine (web-device-parity §5): every sign-out, Keep or Discard, deletes them.

- **Open:** nothing tells the person that signing out forgets such data; saying so is a visible change and needs a
  design.
- **Open:** which other data is in this situation, on each surface. Candidates:
  - signed-out work on a shared device that the next person signs in over. When the account holds nothing of a product,
    the engine joins the device's signed-out work to it without asking (engine §7.10), so on a shared browser one
    person's signed-out routines, workouts and weigh-ins join the next person's account and reach the server; when the
    account holds something, the question asks, naming that work;
  - signed-out gym workouts saved for adoption that no sign-in took;
  - Coach's leftovers beside a replica.
- **Web:** signed-out Settings shows the journal's unattributed pages by day and word count, and whoever holds the
  browser can discard them there; restoring them needs an account.

## LP-3 A store the device cannot keep

- **Web, ruled 2026-11-25:** a browser that refuses a store, blocks it or fills it is not supported. The shell shows
  its one line, "Couldn't open this device's saved work. Reload to try again." (web-device-parity §7).
- **iPhone, Android:** a full disk fails a write. What the person sees is not surveyed.
- **Open:** whether a write that fails for want of room keeps what was entered on the screen and says so, on every
  surface.

## LP-4 A store that was cleared

The device loses every change it had not sent.

- **Web:** a browser can clear a site's storage and keep its session cookie, as Safari does after seven days without
  a visit. The backend records each session's last pushed replica, and the browser counts a clear once with
  `sync_store_cleared` (web-device-parity §7). Nothing tells the person.
- **iPhone, Android:** a reinstall loses the store, and with it the token, so the app starts signed out (read in
  code: the engine deletes a token no bound replica or pending sign-in needs).
- **Open:** whether the person is told, and in what words.

## LP-5 Work refused because the account changed under it

- **Web:** every write is pinned to the account it was made under. A journal save typed in a tab that another tab
  moved to another account is refused, so it never reaches the wrong account. When the room remounts for the new
  account, the words leave the screen.
- **iPhone, Android:** the account changes only in the app itself. Not surveyed.
- **Open:** where such words are kept: a recovery draft in their own account's dormant replica, on the screen, or
  nowhere.

## LP-6 Two devices start a workout at once with no connection

Spec web-device-parity §4: the start that loses is refused `session-open`, and the sets logged under it are
recovered.

- **Every surface:** the refused start's notice holds the sets.
- **iPhone, Android:** show the refusal and adopt the winning workout; the sets are not offered back (read in code).
- **Web:** recovers them into The log, from the approved board WD4.3.
- **Open:** the phones' design for the same recovery.

## LP-7 An old version beside a new one

Two versions of the app can share one store and one account during a release: two tabs on different bundles, or an
older phone build.

- **Web:** a tab still on a bundle from before the store remembered its replica ids can re-identify without
  recording the old id. A tab on the new bundle may then count a clear that did not happen.
- **Every surface:** the update-required door stops a version the registry no longer admits.
- **Open:** what else a mixed release can get wrong, and whether a store should carry the version that last wrote it.

## LP-8 A Coach turn across a replica's re-identify

A re-identify gives the same replica a new id. The domain's writersOwn rule compares a Coach message's writer with
the replica's current id, so a turn whose ability call or next round comes after the re-identify ends `gone` on every
surface. It is tracked in the gym Coach tree as `m4-coach-turn-survives-a-re-identify`.

## LP-9 Signed-out work that names the same thing as the account's

A record keyed by what it is rather than by a fresh id — a weigh-in by its date, a seeded movement by its id, a setting
— can be changed both signed out on a device and on the account. When the device's work joins the account at sign-in
(Add, or the silent join into an account that holds none), the engine's merge takes the later write.

- **Web:** a signed-out weigh-in on a day the account already weighed in replaces the account's value at Add, though the
  question says "Add them"; a movement renamed signed out renames the account's; a default rest or rest sound set signed
  out replaces the account's field by field, the later write winning, with nothing shown.
- **iPhone, Android:** not surveyed; the merge is the engine's, the same on every surface.
- **Open:** whether such a join keeps both, keeps the account's, or asks about each one.

## LP-10 A rule only one surface's copy holds

A copy refuses what its own rule book refuses; a rule one surface holds and the others do not is enforced on that surface
alone, and the server's registry bounds are all that stop the rest.

- **Web:** the web writes the default rest and the rest sound (WD10) and holds `prefs.restSeconds` (15–900, whole
  seconds) in its rule book; the phones' books lack it because the shared book is the phones' too. The web announces at
  once a rest whose target a new default moved behind the time already rested; the iPhone gates its rest-reached haptic
  on `confirmHaptic`, the web its tone and buzz on `restSound`.
- **iPhone, Android:** read both settings and set neither; whether they announce a moved target at once is not surveyed.
- **Open:** whether a rule moves into the shared book before every surface writes what it guards.
