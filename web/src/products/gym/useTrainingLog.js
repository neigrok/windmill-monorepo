// The training log, read: the one place web gym meets the network. Every room hangs off this hook —
// the catalog, the page of sessions and the walk deeper into them, the account's five settings, the
// movement mint, the one toast voice — and the live mirror (§11.2): when the boot read finds an
// open session, this hook POLLS it and Today draws it read-only.
// The web never starts, drives or finishes a live session; capture
// lives in the phone rooms (backend/products/gym/ARCHITECTURE.md §11). What is left here writes
// three things and none of them is a set logged as it happens: a movement minted from a picker, a
// movement's name (§H), and the past-workout backfill. Two more surfaces own their own writes and
// talk to gymApi directly — that backfill form, and the session detail's correction of a set
// already in the log (§G18) — and both speak through the one voice below.
//
// The mirror is a poll and not a socket, by decision (§11.3): GET /v1/gym/sessions/{id} every five
// seconds while the tab is visible, nothing while it is hidden, and a refetch the moment it comes
// back. A set lands once every minute or two; a live transport for that is unearned. The poll rides
// the read's weak ETag — If-None-Match up, 304 back while nothing changed — so the steady state
// costs a header exchange, not a body and a re-render.
//
// AND WHILE NOTHING IS MIRRORED, THE HOOK WATCHES FOR A WORKOUT TO START. The boot read is not the
// only moment a session can be open: the common desk sequence is a laptop opened at home and a
// workout started at the rack an hour later, and a mirror that only ever looked once said "Not
// training now" over that whole workout. So with no session held, `GET /sessions?limit=1` is asked
// again on every return to the tab and on a slow beat — thirty seconds, visible only — and an open
// row is adopted exactly as the boot adopts one. The same watch is how a boot whose detail read
// flapped, and a re-read that lists the phone's NEXT workout open, end up mirrored.

import { useCallback, useEffect, useRef, useState } from 'react';
import { failureReason, gymApi, UNCHANGED } from './gymApi.js';
import { mintId } from './mint.js';
import { CREATED_PATTERN } from './logger/movements.js';
import { DEFAULT_PREFERENCES, readPreferences } from './settings/preferences.js';
import { spellWeightsIn } from './units.js';

const POLL_MS = 5000;
// The watch for a workout starting, while none is mirrored. Slow on purpose: a set lands once a
// minute or two and a workout starts once a day, and the moment that matters — a lifter glancing at
// the laptop — is the visibilitychange, which asks at once.
const WATCH_MS = 30_000;
// A toast is up for five seconds, and that is also how long a withheld delete has to be taken back
// (`UNDO_MS`, fix.js) — the offer and the window it is true in are the same five seconds, and a
// test pins them equal.
const TOAST_MS = 5000;
// The handler clamps `limit` to 200 (TrainingApi.cpp), and the whole `end` signal is a page coming back
// short of what was asked for — so anything asking for more than this would be answered 200 and read
// as the bottom of the log, hiding half a lifter's history under a foot that names the wrong day as
// their first session. Both numbers below are bounded by it.
const SERVER_PAGE_CAP = 200;
const LOG_PAGE = 50;

// The key the retired web logger kept its resume note under. No build writes it any more, and the
// note held no sets — only where the lifter was standing — so whatever a pre-mirror build left
// behind is cleared on the way in rather than left claiming forever that a workout is open here.
// The old queue key ('windmill.gym.queue') is deliberately NOT touched: any entries still under it
// are sets a pre-mirror build owed the log, and destroying a lifter's sets is the one thing this
// product may never do.
const RETIRED_LIVE_KEY = 'windmill.gym.live';

// A page shorter than the one asked for is the bottom of the log. The read carries no total, so the
// count of what came back is the only signal there is — and a full page only ever means "maybe
// more". The size asked for is passed in rather than assumed to be one page, because the re-read
// below asks for as much of the log as is already on screen.
function olderAfter(page, asked) {
  if (page.length < asked) return 'end';
  return 'more';
}

// `onSignedOut` is the frame's: a boot answered 401 means the account is gone from under the tab,
// and the frame is what settles the auth state and opens the door (GymApp.jsx).
export function useTrainingLog({ api = gymApi, onSignedOut = null } = {}) {
  const [phase, setPhase] = useState('loading');
  const [session, setSession] = useState(null);
  const [sets, setSets] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [summaries, setSummaries] = useState([]);
  // §I's five settings, read once on the way in. Two of them reach these rooms: the unit every
  // weight on this surface is spelled in, and the rest target the mirror names. The defaults stand
  // until the read answers, which is what a lifter who has never opened the settings screen gets
  // anyway — so nothing here waits on it and nothing draws a blank while it is in the air.
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  // 'more' until a read says otherwise, so the boot page is what settles this and not the initial
  // value agreeing with it by luck. The foot is never drawn on an empty list, so it is unobservable.
  const [olderStatus, setOlderStatus] = useState('more');
  const [toast, setToast] = useState(null);
  // The boot read is the one read that may not be allowed to fail once and stay failed: 'failed' is
  // the only phase nothing else leaves. This counter is how the signal returning — and the lifter's
  // own Retry — asks it again.
  const [bootAttempt, setBootAttempt] = useState(0);
  // WHY THE BOOT FAILED, because the three reasons have three repairs and one sentence blamed the
  // signal for all of them: 'signal' is a request that never got an answer (retry when it is back),
  // 'server' is a store that answered and failed (retry now), 'signed-out' is a 401 — the cookie
  // lapsed, and the repair is the sign-in door, which no amount of signal opens.
  const [failure, setFailure] = useState(null);

  // The log can be re-read while an older page is still in the air — the backfill and the mirror
  // closing both do exactly that. The walk is stamped, so a page fetched against the old list's tail
  // is dropped rather than appended onto a list it no longer continues.
  const walk = useRef(0);

  // HOW FAR DOWN THE LOG HAS BEEN READ, for the re-read below to ask for again. A ref fed by an
  // effect rather than the state itself, because `reloadLog` must keep ONE identity for the life of
  // the room: the session detail hangs a withheld delete off a callback built on it, and a new
  // identity there fires that callback's cleanup — which sends the delete, seconds early, on
  // whatever keystroke happened to lengthen the log (Log.jsx).
  const reach = useRef(LOG_PAGE);

  // The mirror's freshness tag: the ETag of the last detail read the mirror took, sent back up as
  // If-None-Match so the steady state is a 304 the poll can ignore. A ref, not state — the tag
  // changes exactly when the detail does, and it must never be a render of its own.
  const mirrorTag = useRef(null);
  // The id the mirror holds, readable from inside any closure: `reloadLog` keeps one identity for
  // the life of the room (below) and so cannot read `session` off state, and `adopt` has to know
  // whether the open row it found is the one already on screen.
  const mirrored = useRef(null);
  // The frame's callback, held in a ref so a caller handing a fresh closure each render cannot make
  // the boot read run again — the boot's dependencies are the api and the attempt, and nothing else.
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  // The one voice, and it can carry ONE move as well as a sentence: the withheld delete's Undo
  // lives on it (§G18), and it lives there because the toast's own five seconds are the window the
  // take-back is offered in — the offer and the truth behind it disappear together.
  const say = useCallback((text, action = null) => setToast({ text, action }), []);

  // The mirror taking a detail read, and letting it go — the only two places the held session, its
  // sets, its tag and the id ref move, so the four can never disagree.
  const hold = useCallback((detail) => {
    mirrorTag.current = detail.etag ?? null;
    mirrored.current = detail.session.id;
    setSession(detail.session);
    setSets(detail.sets);
  }, []);
  const release = useCallback(() => {
    mirrorTag.current = null;
    mirrored.current = null;
    setSession(null);
    setSets([]);
  }, []);

  // THE OPEN ROW ON THE LOG IS THE MIRROR'S SESSION — one step, taken by the boot read, by every
  // re-read of the log and by the watch below, so no reader of the log can list a workout open and
  // leave Today saying nothing is running. An open session is a workout running somewhere else —
  // the phone's, to mirror, never to adopt as this surface's own. The detail read brings its sets;
  // the poll keeps them fresh. It fails like a poll, not like the boot: the log LOADED, so the
  // summaries stand and the surface opens, and the watch asks again — where failing the whole boot
  // stranded a lifter on the failure screen over a flap of this one read.
  const adopt = useCallback(async (log) => {
    const open = log.find((summary) => summary.finishedAt == null);
    if (!open || open.id === mirrored.current) return;
    const detail = await api.session(open.id).catch(() => null);
    // A poll may have taken this session in the meantime, and its read is the newer one.
    if (!detail || detail.session.finishedAt != null || mirrored.current === open.id) return;
    hold(detail);
  }, [api, hold]);

  useEffect(() => {
    let alive = true;
    try {
      window.localStorage.removeItem(RETIRED_LIVE_KEY);
    } catch {
      // A store that cannot be read is holding nothing a mirror needs.
    }
    (async () => {
      try {
        // The settings ride the boot read rather than a read of their own, and they cannot fail it:
        // a log that opens in kilograms because one request flapped is a log that opens. The
        // spelling is set BEFORE the phase moves, so the first frame every room paints is already in
        // the unit this account reads in and no number is drawn twice.
        const [exercises, log, settings] = await Promise.all([
          api.exercises(),
          api.sessions({ limit: LOG_PAGE }),
          api.preferences().catch(() => null),
        ]);
        if (!alive) return;
        const held = readPreferences(settings);
        spellWeightsIn(held.units);
        setPreferences(held);
        setCatalog(exercises);
        // Every wholesale replacement of the list bumps the walk, without exception — an older page
        // in flight continues a tail that this read has just thrown away.
        walk.current += 1;
        setSummaries(log);
        // The first page settles this too: a log of three sessions must not offer to load older ones.
        setOlderStatus(olderAfter(log, LOG_PAGE));
        await adopt(log);
        if (!alive) return;
        setFailure(null);
        setPhase('ready');
      } catch (error) {
        if (!alive) return;
        // A 401 is not a failure of the log; it is the account gone from under the tab. The frame is
        // told, so the auth state can settle to ghost and the sign-in door open in its place.
        if (error?.status === 401) {
          setFailure('signed-out');
          signedOut.current?.();
        } else {
          setFailure(error?.status ? 'server' : 'signal');
        }
        setPhase('failed');
      }
    })();
    return () => { alive = false; };
  }, [api, adopt, bootAttempt]);

  useEffect(() => { reach.current = summaries.length; }, [summaries.length]);

  // The signal returning is one recovery for a boot that never came back — without this, a lifter
  // who opened the log in a basement stayed on the failure screen while the signal returned around
  // them. The other is the lifter's own Retry (below): the 'online' event never fires for a store
  // that answered 5xx, and a screen whose only repair is an event that will not come is a dead end.
  const retryBoot = useCallback(() => setBootAttempt((count) => count + 1), []);
  useEffect(() => {
    if (phase !== 'failed') return undefined;
    window.addEventListener('online', retryBoot);
    return () => window.removeEventListener('online', retryBoot);
  }, [phase, retryBoot]);

  // Deeper into the log, one page at a time. The cursor is the last row IN HAND and it is BOTH
  // halves of it, always: `startedAt` alone is not unique, so two sessions that share an instant
  // across a page edge leave one of them in no page, ever — silently, and differently at every page
  // size. Ties are near-certain now that lift-import has bulk-loaded coarse timestamps, and this is
  // that log. The server refuses `beforeId` without `before` for the same reason: an id with no
  // instant names no row (backend/products/gym/ARCHITECTURE.md §5).
  //
  // A page that does not come back is a failure of THIS page and nothing else: the sessions already
  // read stay on screen, `phase` is untouched, and the lifter is offered the same step again.
  const loadOlder = useCallback(async () => {
    const last = summaries[summaries.length - 1];
    if (!last || olderStatus === 'loading') return;
    const mine = walk.current;
    setOlderStatus('loading');
    try {
      const page = await api.sessions({ before: last.startedAt, beforeId: last.id, limit: LOG_PAGE });
      if (walk.current !== mine) return;
      // Appended, never merged: (startedAt, id) is stable — a session's start instant never moves —
      // so no row can cross a page edge between two reads. An id-filter here would buy nothing and
      // hide a broken cursor instead of fixing one.
      setSummaries((current) => [...current, ...page]);
      setOlderStatus(olderAfter(page, LOG_PAGE));
    } catch {
      if (walk.current === mine) setOlderStatus('failed');
    }
  }, [api, summaries, olderStatus]);

  // The log, re-read — after a backfill lands, after a discard, when the mirror sees the phone's
  // session close, and when a set is corrected or deleted on the desk (§G18). Every one of them
  // changes a row's own four facts, so the list is replaced by the store's answer rather than
  // patched here, and the walk down it is stamped so a page in the air cannot land on the new list.
  //
  // IT IS AS DEEP AS THE LOG IS READ, and it has to be. Every other caller moves page ONE, but a
  // correction moves whichever row its session sits on — and the desk is exactly where somebody
  // goes back three months, so a re-read of the top fifty would drop the eighty rows they had walked
  // AND never contain the row it was fired to move. Read to the same depth, the list comes back
  // whole and the corrected row is in it. Past the server's ceiling the tail is still truncated:
  // asking for a page the handler will clamp is the one thing that would make the foot lie.
  //
  // The catch has to speak. The walk bump above orphans any older page already in the air, and that
  // page's own arms fall silent once they see they are stale — so if this read is the one that
  // fails, nothing is left to release the foot and it stays at "Loading older sessions…" until a
  // reload. 'more' is the honest guess: the list on screen is whatever survived, and asking again is
  // exactly the recovery.
  //
  // AND IT ADOPTS WHAT IT READS. The mirror closing on the phone's workout A is what fires this read
  // most often — and by then the phone may already be into workout B, which this read lists open. A
  // list saying "in progress" over a Today saying "Not training now" is the surface disagreeing with
  // itself, so the same step the boot takes runs here.
  const reloadLog = useCallback(async () => {
    const depth = Math.min(SERVER_PAGE_CAP, Math.max(LOG_PAGE, reach.current));
    walk.current += 1;
    let log;
    try {
      log = await api.sessions({ limit: depth });
    } catch {
      setOlderStatus('more');
      return;
    }
    setSummaries(log);
    setOlderStatus(olderAfter(log, depth));
    await adopt(log);
  }, [api, adopt]);

  // THE MIRROR'S BEAT (§11.3 flow 2). Five seconds while the tab is visible, nothing while it is
  // hidden — a hidden tab asks no questions — and one immediate read when it comes back, because a
  // lifter glancing at a laptop mid-set should not wait out a poll interval to see the set land.
  // Each beat sends the last read's ETag as If-None-Match, so the steady state — nobody lifted in
  // the last five seconds — is a 304 the mirror ignores: the state in hand stands untouched and no
  // re-render runs. A poll that fails keeps the last true read on screen and says nothing: "last
  // set 3:40 ago" is still a fact, and the next beat is the retry. The mirror ends when the read
  // says the session finished — or 404s, which is a discard — and the log is re-read so the closed
  // session appears where it now belongs.
  useEffect(() => {
    const id = session?.id;
    if (!id) return undefined;
    let alive = true;
    const read = async () => {
      let detail;
      try {
        detail = await api.session(id, { etag: mirrorTag.current });
      } catch {
        return;
      }
      if (!alive) return;
      if (detail === UNCHANGED) return;
      if (detail == null || detail.session.finishedAt != null) {
        release();
        reloadLog();
        return;
      }
      hold(detail);
    };
    const visible = () => document.visibilityState === 'visible';
    const beat = setInterval(() => { if (visible()) read(); }, POLL_MS);
    const woke = () => { if (visible()) read(); };
    document.addEventListener('visibilitychange', woke);
    return () => {
      alive = false;
      clearInterval(beat);
      document.removeEventListener('visibilitychange', woke);
    };
  }, [api, session?.id, reloadLog, hold, release]);

  // THE WATCH, while nothing is mirrored (head of file). One row is enough to ask for: the question
  // is whether the newest session is open, and the summaries on screen are not touched by it — the
  // list is re-read when the mirror closes, as it always was. Visible tab only, and at once on the
  // way back to it, for the same reason the poll above is.
  const watching = phase === 'ready' && session == null;
  useEffect(() => {
    if (!watching) return undefined;
    let alive = true;
    const look = async () => {
      let log;
      try {
        log = await api.sessions({ limit: 1 });
      } catch {
        return;
      }
      if (alive) await adopt(log);
    };
    const visible = () => document.visibilityState === 'visible';
    const beat = setInterval(() => { if (visible()) look(); }, WATCH_MS);
    const woke = () => { if (visible()) look(); };
    document.addEventListener('visibilitychange', woke);
    return () => {
      alive = false;
      clearInterval(beat);
      document.removeEventListener('visibilitychange', woke);
    };
  }, [api, adopt, watching]);

  // A movement the catalog does not hold, minted from the picker's two questions (§N screen 31): a
  // name and how it is loaded. It lands in the catalog here, in the one instance of it this product
  // has, so the movement the lifter just created is on every picker in the app a render later — the
  // routine editor's and the backfill form's.
  const createMovement = useCallback(async ({ name, equipment }) => {
    // The toast speaks through failureReason: a 400 is the store refusing the document — it read it
    // and would not take it — and telling that lifter to try again when they have signal blames the
    // network for the store's own answer, on a retry that fails identically forever.
    let refused = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const made = await api.createExercise({
          id: mintId('ex_'), name: name.trim(), equipment, pattern: CREATED_PATTERN,
        });
        setCatalog((current) => [...current, made]);
        return made;
      } catch (error) {
        refused = error;
        if (!error.exerciseIdTaken) break;
      }
    }
    say(`That movement wasn’t created — ${failureReason(refused)}.`);
    return null;
  }, [api, say]);

  // A MOVEMENT RENAMED, AND NOTHING ELSE ABOUT IT MOVED (§H). The store answers with the stored
  // movement under the id it already had, so the row is replaced rather than appended — and it is
  // replaced HERE, in the one catalog this product holds, so the routine editor, the session detail
  // and every picker are reading the new name a render later without a read of their own.
  const renameMovement = useCallback(async (exerciseId, name) => {
    try {
      const renamed = await api.renameExercise(exerciseId, name.trim());
      setCatalog((current) => current.map((each) => (each.id === renamed.id ? renamed : each)));
      return renamed;
    } catch (error) {
      say(`That name wasn’t saved — ${failureReason(error)}.`);
      return null;
    }
  }, [api, say]);

  // The toast is the one thing here that is counted rather than derived, because it has no instant
  // worth surviving a reload: five seconds after it was said, it has been read or it has not.
  //
  // AND A CLOCK ONLY EVER CLEARS THE TOAST IT WAS SET FOR. The cleanup above cancels it whenever the
  // toast changes, but cancelling is a render behind the change, and one caller says its next
  // sentence at exactly the instant this one runs out: a withheld delete is sent when its five
  // seconds close, and those are the same five seconds (`UNDO_MS`, fix.js), so a delete the log
  // refuses speaks inside the millisecond this timer fires. Both updates then land in one batch,
  // the older clock last, and the lifter watches the row come back with nothing said about why.
  // Naming the toast is what makes the stale clock harmless in every order the two can arrive in.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast((current) => (current === toast ? null : current)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return {
    phase,
    // Why 'failed', when it is: 'signal' · 'server' · 'signed-out'. Null in every other phase.
    failure,
    // The boot read, asked again — the lifter's own recovery for a store that answered 5xx, where the
    // 'online' event never comes.
    retryBoot,
    // The open session this account holds, or null. It is the phone's workout, mirrored — nothing
    // handed out here can write into it.
    session,
    sets,
    catalog,
    summaries,
    // The account's settings (§I). Handed out whole because the rooms read different halves of them
    // and none of them should read the wire twice for it — Today names the rest target on the
    // mirror, and every weight on every screen is already spelled in `units` by the transform this
    // hook set on boot.
    preferences,
    // One page of the log is on screen; this is everything the surface needs to walk further down it.
    older: { status: olderStatus, load: loadOlder },
    // The log, re-read to the depth it is open to: the backfill form, the retrospective discard and
    // a set corrected on the desk each move a row's own four facts, and none of them owns the list.
    reloadLog,
    createMovement,
    renameMovement,
    // The one voice in the product. Handed out so a surface that is not this hook — a discard, a
    // backfill that half-landed, a set corrected on the desk — says what happened in the same place
    // everything else does, and offers its one move there too.
    say,
    toast,
    dismissToast: () => setToast(null),
  };
}
