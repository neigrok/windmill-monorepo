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
  a change they make is kept in the browser and sent if that account signs in again there.
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
  - signed-out work on a shared device that the next person signs in over;
  - signed-out gym workouts saved for adoption that no sign-in took;
  - Coach's leftovers beside a replica.

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
