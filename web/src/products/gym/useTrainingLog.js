// The training log, read: the one place web gym meets the network. Every room hangs off this hook —
// the catalog, the page of sessions and the walk deeper into them, the movement mint, the one toast
// voice — and the live mirror (§11.2): when the boot read finds an open session, this hook POLLS it
// and Today draws it read-only. The web never starts, drives or finishes a live session; capture
// lives in the phone rooms (backend/products/gym/ARCHITECTURE.md §11). What is left here writes
// three things and none of them is a set: a movement minted from a picker, a movement's name (§H),
// and the past-workout backfill — which owns its own writes and talks to gymApi directly.
//
// The mirror is a poll and not a socket, by decision (§11.3): GET /v1/gym/sessions/{id} every five
// seconds while the tab is visible, nothing while it is hidden, and a refetch the moment it comes
// back. A set lands once every minute or two; a live transport for that is unearned. The poll rides
// the read's weak ETag — If-None-Match up, 304 back while nothing changed — so the steady state
// costs a header exchange, not a body and a re-render.

import { useCallback, useEffect, useRef, useState } from 'react';
import { failureReason, gymApi, UNCHANGED } from './gymApi.js';
import { mintId } from './mint.js';
import { CREATED_MOVEMENT } from './logger/movements.js';

const POLL_MS = 5000;
const TOAST_MS = 5000;
// Must stay at or under the server's own ceiling: the handler clamps limit to 200, so a larger page
// size here would come back short of what was asked for and read as the bottom of the log — half a
// lifter's history hidden under a foot that names the wrong day as their first session.
const LOG_PAGE = 50;

// The key the retired web logger kept its resume note under. No build writes it any more, and the
// note held no sets — only where the lifter was standing — so whatever a pre-mirror build left
// behind is cleared on the way in rather than left claiming forever that a workout is open here.
// The old queue key ('windmill.gym.queue') is deliberately NOT touched: any entries still under it
// are sets a pre-mirror build owed the log, and destroying a lifter's sets is the one thing this
// product may never do.
const RETIRED_LIVE_KEY = 'windmill.gym.live';

// A page shorter than the one asked for is the bottom of the log. The read carries no total, so the
// count of what came back is the only signal there is — and a full page only ever means "maybe more".
function olderAfter(page) {
  if (page.length < LOG_PAGE) return 'end';
  return 'more';
}

export function useTrainingLog({ api = gymApi } = {}) {
  const [phase, setPhase] = useState('loading');
  const [session, setSession] = useState(null);
  const [sets, setSets] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [summaries, setSummaries] = useState([]);
  // 'more' until a read says otherwise, so the boot page is what settles this and not the initial
  // value agreeing with it by luck. The foot is never drawn on an empty list, so it is unobservable.
  const [olderStatus, setOlderStatus] = useState('more');
  const [toast, setToast] = useState(null);
  // The boot read is the one read that may not be allowed to fail once and stay failed: 'failed' is
  // the only phase nothing else leaves. This counter is how the signal returning asks it again.
  const [bootAttempt, setBootAttempt] = useState(0);

  // The log can be re-read from the top while an older page is still in the air — the backfill and
  // the mirror closing both do exactly that. The walk is stamped, so a page fetched against the old
  // list's tail is dropped rather than appended onto a list it no longer continues.
  const walk = useRef(0);

  // The mirror's freshness tag: the ETag of the last detail read the mirror took, sent back up as
  // If-None-Match so the steady state is a 304 the poll can ignore. A ref, not state — the tag
  // changes exactly when the detail does, and it must never be a render of its own.
  const mirrorTag = useRef(null);

  const say = useCallback((text) => setToast({ text }), []);

  useEffect(() => {
    let alive = true;
    try {
      window.localStorage.removeItem(RETIRED_LIVE_KEY);
    } catch {
      // A store that cannot be read is holding nothing a mirror needs.
    }
    (async () => {
      try {
        const [exercises, log] = await Promise.all([api.exercises(), api.sessions({ limit: LOG_PAGE })]);
        if (!alive) return;
        setCatalog(exercises);
        // Every wholesale replacement of the list bumps the walk, without exception — an older page
        // in flight continues a tail that this read has just thrown away.
        walk.current += 1;
        setSummaries(log);
        // The first page settles this too: a log of three sessions must not offer to load older ones.
        setOlderStatus(olderAfter(log));
        // An open session on the log is a workout running somewhere else — the phone's, to mirror,
        // never to adopt. The detail read brings its sets; the poll below keeps them fresh. And it
        // fails like a poll, not like the boot: the log LOADED, so the summaries stand and the
        // surface opens, just without the mirror. Failing the whole boot here stranded a lifter on
        // the failure screen over a flap of this one read — where the 'online' event, the only
        // recovery 'failed' has, never fires for a server-side 5xx.
        const open = log.find((summary) => summary.finishedAt == null);
        const detail = open ? await api.session(open.id).catch(() => null) : null;
        if (!alive) return;
        if (detail && detail.session.finishedAt == null) {
          mirrorTag.current = detail.etag ?? null;
          setSession(detail.session);
          setSets(detail.sets);
        }
        setPhase('ready');
      } catch {
        if (alive) setPhase('failed');
      }
    })();
    return () => { alive = false; };
  }, [api, bootAttempt]);

  // The signal returning is the recovery for a boot that never came back — without this, a lifter
  // who opened the log in a basement stayed on the failure screen while the signal returned around
  // them.
  useEffect(() => {
    if (phase !== 'failed') return undefined;
    const back = () => setBootAttempt((count) => count + 1);
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, [phase]);

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
      setOlderStatus(olderAfter(page));
    } catch {
      if (walk.current === mine) setOlderStatus('failed');
    }
  }, [api, summaries, olderStatus]);

  // The log, re-read from the top — after a backfill lands, after a discard, and when the mirror
  // sees the phone's session close. All of them change what the first page IS, so the list goes
  // back to page one and the walk down it goes back with it: a log the lifter had read to the
  // bottom is truncated by this read, and leaving the foot saying "there is nothing older" would be
  // a lie about the middle of their history.
  //
  // The catch has to speak. The walk bump above orphans any older page already in the air, and that
  // page's own arms fall silent once they see they are stale — so if this read is the one that
  // fails, nothing is left to release the foot and it stays at "Loading older sessions…" until a
  // reload. 'more' is the honest guess: the list on screen is whatever survived, and asking again is
  // exactly the recovery.
  const reloadLog = useCallback(async () => {
    walk.current += 1;
    try {
      const log = await api.sessions({ limit: LOG_PAGE });
      setSummaries(log);
      setOlderStatus(olderAfter(log));
    } catch {
      setOlderStatus('more');
    }
  }, [api]);

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
        mirrorTag.current = null;
        setSession(null);
        setSets([]);
        reloadLog();
        return;
      }
      mirrorTag.current = detail.etag ?? null;
      setSession(detail.session);
      setSets(detail.sets);
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
  }, [api, session?.id, reloadLog]);

  // A movement the catalog does not hold, minted from the picker's own search box (screen 7). It
  // lands in the catalog here, in the one instance of it this product has, so the movement the
  // lifter just created is on every picker in the app a render later — the routine editor's and the
  // backfill form's.
  const createMovement = useCallback(async (name) => {
    // The toast speaks through failureReason: a 400 is the store refusing the document — it read it
    // and would not take it — and telling that lifter to try again when they have signal blames the
    // network for the store's own answer, on a retry that fails identically forever.
    let refused = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const made = await api.createExercise({ id: mintId('ex_'), name: name.trim(), ...CREATED_MOVEMENT });
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
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return {
    phase,
    // The open session this account holds, or null. It is the phone's workout, mirrored — nothing
    // handed out here can write into it.
    session,
    sets,
    catalog,
    summaries,
    // One page of the log is on screen; this is everything the surface needs to walk further down it.
    older: { status: olderStatus, load: loadOlder },
    // The log, re-read: the backfill form and the retrospective discard both change what the first
    // page is, and neither of them owns the list.
    reloadLog,
    createMovement,
    renameMovement,
    // The one voice in the product. Handed out so a surface that is not this hook — a discard, a
    // backfill that half-landed — says what happened in the same place everything else does.
    say,
    toast,
    dismissToast: () => setToast(null),
  };
}
