// The training log, read: the catalog, the page of sessions and the walk deeper into them, the
// settings, the movement mint, the one toast voice. The web never starts, drives or finishes a live
// session — an open session is MIRRORED by a poll and drawn read-only.

import { useCallback, useEffect, useRef, useState } from 'react';
import { failureReason, gymApi, UNCHANGED } from './gymApi.js';
import { mintId } from './mint.js';
import { CREATED_PATTERN } from './logger/movements.js';
import { DEFAULT_PREFERENCES, readPreferences } from './settings/preferences.js';
import { spellWeightsIn } from './units.js';

const POLL_MS = 5000;
// The watch for a workout starting, while none is mirrored; the visibilitychange asks at once.
const WATCH_MS = 30_000;
// Must equal `UNDO_MS` (fix.js): the Undo offer and the window it is true in are the same span.
const TOAST_MS = 9000;
// The handler clamps `limit` to 200, and `end` is a page coming back short of what was asked for —
// so asking for more would be answered 200 and misread as the bottom of the log.
const SERVER_PAGE_CAP = 200;
const LOG_PAGE = 50;

// Cleared on the way in. The queue key ('windmill.gym.queue') is never touched: entries under it are
// sets owed to the log.
const RETIRED_LIVE_KEY = 'windmill.gym.live';

// A page shorter than the one asked for is the bottom of the log; the read carries no total.
function olderAfter(page, asked) {
  if (page.length < asked) return 'end';
  return 'more';
}

// `onSignedOut` fires when the boot is answered 401; the frame settles the auth state.
export function useTrainingLog({ api = gymApi, onSignedOut = null } = {}) {
  const [phase, setPhase] = useState('loading');
  const [session, setSession] = useState(null);
  const [sets, setSets] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [summaries, setSummaries] = useState([]);
  // Read once on the way in; the defaults stand until it answers.
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  // 'more' until a read says otherwise, so the boot page settles it.
  const [olderStatus, setOlderStatus] = useState('more');
  const [toast, setToast] = useState(null);
  // Bumping this asks the boot read again.
  const [bootAttempt, setBootAttempt] = useState(0);
  // 'signal' is a request that never got an answer, 'server' a store that answered and failed,
  // 'signed-out' a 401.
  const [failure, setFailure] = useState(null);

  // Stamps the walk, so a page fetched against a discarded tail is dropped rather than appended.
  const walk = useRef(0);

  // How far down the log has been read. A ref and not state, because `reloadLog` must keep one
  // identity for the life of the room: a withheld delete hangs off a callback built on it.
  const reach = useRef(LOG_PAGE);

  // The mirror's freshness tag, sent back up as If-None-Match. A ref: it must never cause a render.
  const mirrorTag = useRef(null);
  // The id the mirror holds; `reloadLog` keeps one identity and so cannot read `session` off state.
  const mirrored = useRef(null);
  // A ref, so a caller handing a fresh closure each render cannot make the boot read run again.
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  // The one voice; it carries one optional move as well as a sentence.
  const say = useCallback((text, action = null) => setToast({ text, action }), []);

  // The only two places the held session, its sets, its tag and the id ref move together.
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

  // The open row on the log becomes the mirror's session. It fails like a poll and not like the
  // boot: the summaries stand, the surface opens, and the watch asks again.
  const adopt = useCallback(async (log) => {
    const open = log.find((summary) => summary.finishedAt == null);
    if (!open || open.id === mirrored.current) return;
    const detail = await api.session(open.id).catch(() => null);
    // A poll may have taken this session meanwhile, and its read is the newer one.
    if (!detail || detail.session.finishedAt != null || mirrored.current === open.id) return;
    hold(detail);
  }, [api, hold]);

  useEffect(() => {
    let alive = true;
    try {
      window.localStorage.removeItem(RETIRED_LIVE_KEY);
    } catch {
      // A store that cannot be read is holding nothing this needs.
    }
    (async () => {
      try {
        // The settings ride the boot read and cannot fail it; the spelling is set before the phase
        // moves, so the first frame is already in this account's unit.
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
        // Every wholesale replacement bumps the walk: an older page in flight continues a discarded tail.
        walk.current += 1;
        setSummaries(log);
        setOlderStatus(olderAfter(log, LOG_PAGE));
        await adopt(log);
        if (!alive) return;
        setFailure(null);
        setPhase('ready');
      } catch (error) {
        if (!alive) return;
        // A 401 is the account gone from under the tab rather than a failure of the log.
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

  // The 'online' event never fires for a store that answered 5xx, so Retry is the other recovery.
  const retryBoot = useCallback(() => setBootAttempt((count) => count + 1), []);
  useEffect(() => {
    if (phase !== 'failed') return undefined;
    window.addEventListener('online', retryBoot);
    return () => window.removeEventListener('online', retryBoot);
  }, [phase, retryBoot]);

  // The cursor is both halves of the last row in hand: `startedAt` alone is not unique, so two
  // sessions sharing an instant across a page edge would leave one of them in no page, ever.
  // A page that does not come back is a failure of this page alone; `phase` is untouched.
  const loadOlder = useCallback(async () => {
    const last = summaries[summaries.length - 1];
    if (!last || olderStatus === 'loading') return;
    const mine = walk.current;
    setOlderStatus('loading');
    try {
      const page = await api.sessions({ before: last.startedAt, beforeId: last.id, limit: LOG_PAGE });
      if (walk.current !== mine) return;
      // Appended, never merged: (startedAt, id) is stable, so no row crosses a page edge.
      setSummaries((current) => [...current, ...page]);
      setOlderStatus(olderAfter(page, LOG_PAGE));
    } catch {
      if (walk.current === mine) setOlderStatus('failed');
    }
  }, [api, summaries, olderStatus]);

  // The log, re-read to the depth it is already open to: a re-read of the top fifty would drop the
  // rows already walked and could miss the row it was fired to move. It is replaced, never patched,
  // and the walk is stamped so a page in the air cannot land on the new list. The catch must reset
  // the foot, which that bump has otherwise left loading forever. It adopts what it reads.
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

  // The mirror's beat: visible tab only, one immediate read on the way back to it, and the last
  // read's ETag as If-None-Match so the steady state is a 304. A failed poll keeps the last true
  // read on screen and says nothing. The mirror ends on a finished session or a 404.
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

  // The watch, while nothing is mirrored: one row is enough, and the summaries on screen are not
  // touched by it. Visible tab only, and at once on the way back to it.
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

  // Lands in the one catalog instance this product holds, so every picker has it a render later.
  const createMovement = useCallback(async ({ name, equipment }) => {
    // A refusal the store would not take must not be reported as a network problem.
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

  // The store answers under the id the movement already had, so the row is replaced, not appended.
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

  // A clock only ever clears the toast it was set for: cancelling is a render behind the change, so
  // two updates can land in one batch with the older clock last.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast((current) => (current === toast ? null : current)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return {
    phase,
    // 'signal' · 'server' · 'signed-out'. Null in every other phase.
    failure,
    // The boot read, asked again.
    retryBoot,
    // The mirrored open session, or null; nothing handed out here can write into it.
    session,
    sets,
    catalog,
    summaries,
    preferences,
    older: { status: olderStatus, load: loadOlder },
    reloadLog,
    createMovement,
    renameMovement,
    say,
    toast,
    dismissToast: () => setToast(null),
  };
}
