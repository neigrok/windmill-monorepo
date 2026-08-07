// The live session, wired: the one place in gym where the pure rules meet the network, the clock,
// the screen lock and the browser's storage. Everything it decides it decides by asking a module —
// the ladder moves the weight, prefill picks the number, the queue owns durability — so this file
// is the plumbing and none of the meaning.
//
// Four rules it exists to keep:
//   · the clock is DERIVED. A 500ms beat forces a re-render and increments nothing, so a locked
//     phone, a backgrounded tab and a full reload all come back to the true elapsed time.
//   · the store is a FOREIGN INPUT. What comes back from `windmill.gym.live` was written by some
//     build, possibly not this one and possibly not all of it, and it becomes React state one line
//     later — so it typechecks at the door or it does not get in.
//   · the queue flushes FIRST — before the boot read, and the moment the signal returns — because
//     reading the log SETTLES a stale open session, and a set that arrives after that close is
//     refused forever. An auto-close over an unflushed queue is the one loss the device cannot
//     see coming, and the app's own first request is what fires it.
//   · finishing waits for this session's sets to land. A session that closed before a set reached
//     it refuses that set forever, so Finish only completes when there is nothing left to lose.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LIVE_KEY, QUEUE_KEY } from '../device.js';
import { gymApi } from '../gymApi.js';
import { finishHref, nameOfMovement, planOf, workingSetsOf } from '../log.js';
import { deviationAsk, withEntryWeight } from '../routines.js';
import { FlushQueue, localStore, mintId, UNDO_WINDOW_MS } from './flushQueue.js';
import { bump, bumpReps } from './ladder.js';
import { CREATED_MOVEMENT } from './movements.js';
import { EMPTY_BAR_KG, EMPTY_BAR_REPS, planEntryFor, prefillFor } from './prefill.js';
import { restReadout, restTargetFor } from './rest.js';
import { playRestLanded, playSetLogged } from './sound.js';

// Both keys live in device.js — the /app home cell reads the live one to ask whether a workout was
// left open here, and it may not import this file to do it.
const BEAT_MS = 500;
const FLUSH_MS = 4000;
const TOAST_MS = 5000;
// Must stay at or under the server's own ceiling: the handler clamps limit to 200, so a larger page
// size here would come back short of what was asked for and read as the bottom of the log — half a
// lifter's history hidden under "that's the start of your log".
const LOG_PAGE = 50;

// THE ONE DOOR. Whatever is behind this key is a foreign input — an older build's shape, a write a
// killed tab truncated, a hand edit — and one line past this function it is state, and then it is a
// render. So it typechecks here, and what comes back out is either trustworthy or nothing.
//
// Nothing in this blob is a set. Every set the lifter has logged is on the log or in the QUEUE,
// under its own key that this function never touches, and `adopt` re-joins that queue by session id
// — so no discard below can cost a set. What is here is where the lifter was standing: the movement
// list, the number under the thumb, the rest clock.
//
// Which is why exactly one field takes the whole blob down with it, and every other repairs:
//   · IDENTITY has no fallback. A blob that cannot name its session cannot be matched to one, and
//     matching it to the wrong session would put another workout's number under the thumb.
//   · THE DIAL is one gesture. Half restored and half prefilled is a number nobody chose, which is
//     the one thing this screen may never draw — so both come back, or neither does and the prefill
//     takes over, exactly as it does on a movement just walked into.
//   · THE PLACE rebuilds itself from the sets that were actually performed, so losing it costs at
//     most a movement chosen and not yet lifted. The index is a pointer INTO that list and cannot
//     outlive it; the list is perfectly meaningful without the index, and defaults to the movement
//     last performed just as a first read of the session does.
function readLive() {
  let stored = null;
  try {
    stored = JSON.parse(window.localStorage.getItem(LIVE_KEY));
  } catch {
    return { live: null, lost: true };
  }
  if (stored == null) return { live: null, lost: false };
  if (typeof stored.sessionId !== 'string' || stored.sessionId === '') return { live: null, lost: true };

  const listed = Array.isArray(stored.order) && stored.order.every((id) => typeof id === 'string' && id !== '')
    ? stored.order
    : null;
  // Duplicates are the one flaw the door has to catch rather than pass on, because adopt dedupes the
  // list downstream and the index does not move with it: an order naming a movement twice quietly
  // shortens under a pointer still counting the long version, and the lifter resumes on the wrong
  // lift with nothing said. The list survives deduped; the pointer into it does not.
  const order = listed === null ? null : [...new Set(listed)];
  const shortened = order !== null && order.length !== listed.length;
  const exIdx = order !== null && !shortened && Number.isInteger(stored.exIdx) && stored.exIdx >= 0
    ? stored.exIdx
    : null;
  // Finite is the whole rule for a weight: the load is signed, because band-assisted work sits below
  // zero, and the ladder's step buttons deliberately do not clamp — so a magnitude ceiling here
  // would refuse a bar the product's own buttons can reach.
  // Reps floor at 1 here for the same reason the ladder does: a set of zero is not a set, the server
  // refuses it, and a 0 written by a build from before that floor moved would otherwise come back and
  // open the pad in alarm ink on a gesture the lifter never made. Dropping the pair rather than
  // clamping the 0 is the same rule as everywhere else here — a half-restored dial is a set nobody
  // dialled, and the prefill is a better answer than a repaired one.
  const dial = Number.isFinite(stored.weight) && Number.isInteger(stored.reps) && stored.reps >= 1
    ? { weight: stored.weight, reps: stored.reps }
    : null;
  // null is a legal rest clock — it is how "not resting" is written — so this is the one field that
  // has to tell a written absence from a broken value.
  const restStartedAt = Number.isFinite(stored.restStartedAt) ? stored.restStartedAt : null;
  const clockBroken = stored.restStartedAt != null && restStartedAt === null;

  return {
    live: { sessionId: stored.sessionId, order: order ?? [], exIdx, dial, restStartedAt },
    lost: order === null || exIdx === null || dial === null || clockBroken,
  };
}

function writeLive(state) {
  try {
    if (!state) window.localStorage.removeItem(LIVE_KEY);
    else window.localStorage.setItem(LIVE_KEY, JSON.stringify(state));
  } catch {
    // A blocked store costs the resume, never the set — durability rides on the queue.
  }
}

// A page shorter than the one asked for is the bottom of the log. The read carries no total, so the
// count of what came back is the only signal there is — and a full page only ever means "maybe more".
function olderAfter(page) {
  if (page.length < LOG_PAGE) return 'end';
  return 'more';
}

export function useLiveSession({ api = gymApi } = {}) {
  const [phase, setPhase] = useState('loading');
  const [session, setSession] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [summaries, setSummaries] = useState([]);
  // 'more' until a read says otherwise, so the boot page is what settles this and not the initial
  // value agreeing with it by luck. The foot is never drawn on an empty list, so it is unobservable.
  const [olderStatus, setOlderStatus] = useState('more');
  const [sets, setSets] = useState([]);
  const [order, setOrder] = useState([]);
  const [exIdx, setExIdx] = useState(0);
  const [weight, setWeight] = useState(EMPTY_BAR_KG);
  const [reps, setReps] = useState(EMPTY_BAR_REPS);
  const [restStartedAt, setRestStartedAt] = useState(null);
  const [undo, setUndo] = useState(null);
  const [toast, setToast] = useState(null);
  const [refusals, setRefusals] = useState([]);
  const [pending, setPending] = useState([]);
  const [lastTime, setLastTime] = useState(null);
  const [lastTimeFailed, setLastTimeFailed] = useState(false);
  const [deviation, setDeviation] = useState(null);
  const [finishing, setFinishing] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [, setBeat] = useState(0);

  const lastTimes = useRef(new Map());
  // The log can be re-read from the top while an older page is still in the air — finishing does
  // exactly that. The walk is stamped, so a page fetched against the old list's tail is dropped
  // rather than appended onto a list it no longer continues.
  const walk = useRef(0);
  const alerted = useRef(false);
  const restored = useRef(null);
  const touched = useRef(false);
  // The mid-session question's memory, and it belongs to the session rather than to the rule that
  // asks it: which movement the lifter is standing on, and which ones have already been asked about.
  // Neither survives a reload, and neither needs to — nothing here is a set.
  const standingOn = useRef(null);
  const asked = useRef([]);
  const setsNow = useRef(sets);
  setsNow.current = sets;
  const orderNow = useRef(order);
  orderNow.current = order;

  const say = useCallback((text) => setToast({ text }), []);

  const applyReport = useCallback((report) => {
    if (report.reminted.length > 0) {
      setSets((current) => current.map((set) => {
        const swap = report.reminted.find((each) => each.from === set.id);
        return swap ? { ...set, id: swap.to } : set;
      }));
    }
    if (report.delivered.length > 0) {
      setSets((current) => current.map((set) => {
        const durable = report.delivered.find((each) => each.entry.setId === set.id);
        return durable ? { ...set, queued: false, setNumber: durable.stored.setNumber } : set;
      }));
    }
    // Taken back by Undo, but the log had already accepted it — and the log has no delete. The row
    // comes back to the screen rather than the history holding a set the device denies.
    if (report.restored.length > 0) {
      setSets((current) => [...current, ...report.restored
        .filter(({ entry }) => !current.some((set) => set.id === entry.setId))
        .map(({ entry, stored }) => ({
          id: entry.setId,
          exerciseId: entry.exerciseId,
          weightKg: entry.weightKg,
          reps: entry.reps,
          kind: entry.kind,
          completedAt: entry.completedAt,
          setNumber: stored.setNumber,
          queued: false,
        }))]);
      say('That set already reached the log — it stays in your history.');
    }
    if (report.refused.length > 0) {
      setSets((current) => current.filter((set) => !report.refused.some((each) => each.entry.setId === set.id)));
      // The movement travels with the refusal: this banner is the last copy of a set that never
      // landed, and "82.5 × 8 never reached the log" is unloggable again without knowing of what.
      setRefusals((current) => [...current, ...report.refused.map(({ entry, reason }) => ({
        id: entry.setId, exerciseId: entry.exerciseId, weightKg: entry.weightKg, reps: entry.reps, reason,
      }))]);
    }
    setPending(report.pending);
  }, [say]);

  const queue = useRef(null);
  if (!queue.current) {
    queue.current = new FlushQueue({
      api,
      store: localStore(QUEUE_KEY, window.localStorage),
      onReport: applyReport,
    });
  }

  const exerciseId = order[exIdx] ?? null;
  const byId = useMemo(() => new Map(catalog.map((each) => [each.id, each])), [catalog]);
  const exercise = exerciseId ? byId.get(exerciseId) ?? { id: exerciseId, name: exerciseId } : null;
  const todaySets = useMemo(
    () => sets.filter((set) => set.exerciseId === exerciseId)
      .sort((left, right) => left.completedAt - right.completedAt),
    [sets, exerciseId],
  );
  const planEntry = useMemo(() => planEntryFor(session, exerciseId), [session, exerciseId]);
  const routine = planOf(session)?.routine ?? null;

  const dial = useCallback((movement, found) => {
    const today = setsNow.current.filter((set) => set.exerciseId === movement)
      .sort((left, right) => left.completedAt - right.completedAt);
    const next = prefillFor({ todaySets: today, planEntry: planEntryFor(session, movement), lastTime: found });
    setWeight(next.weight);
    setReps(next.reps);
  }, [session]);

  const adopt = useCallback((row, storedSets) => {
    const { live: kept, lost } = readLive();
    const mine = kept && kept.sessionId === row.id ? kept : null;
    const held = queue.current.pending.filter((entry) => entry.sessionId === row.id);
    const merged = [
      ...storedSets.map((set) => ({ ...set, queued: false })),
      ...held.filter((entry) => !storedSets.some((set) => set.id === entry.setId)).map((entry) => ({
        id: entry.setId,
        exerciseId: entry.exerciseId,
        weightKg: entry.weightKg,
        reps: entry.reps,
        kind: entry.kind,
        completedAt: entry.completedAt,
        setNumber: null,
        queued: true,
      })),
    ];
    const performed = merged.slice().sort((left, right) => left.completedAt - right.completedAt)
      .map((set) => set.exerciseId);
    const nextOrder = [...new Set([...(mine?.order ?? []), ...performed])];
    const landing = Math.max(0, Math.min(mine?.exIdx ?? nextOrder.length - 1, nextOrder.length - 1));
    setSession(row);
    setSets(merged);
    setOrder(nextOrder);
    setExIdx(landing);
    // A session walked into is a session nothing has been asked about yet, and the movement it lands
    // on is not one the lifter has left.
    standingOn.current = null;
    asked.current = [];
    setDeviation(null);
    setRestStartedAt(mine?.restStartedAt ?? null);
    // A reload is not a movement change: the number the lifter had dialled comes back as it was,
    // and the prefill stays out of the way for exactly that one resume. When the dial did not
    // survive the door the prefill IS the recovery, so the suppression goes with it.
    if (mine?.dial) {
      setWeight(mine.dial.weight);
      setReps(mine.dial.reps);
      restored.current = nextOrder[landing] ?? null;
    }
    setPending(queue.current.pending);
    setPhase('live');
    // Said out loud rather than starting quietly blank — and said even when the wreck named some
    // other session, because a note this device wrote and cannot read back is still a note about
    // where the lifter left off. The sentence can promise what it promises because the blob holds
    // no sets: the log has them, or the queue does.
    if (lost) say('Couldn’t read where you left off — that’s the weight and the movement, never a set.');
  }, [say]);

  // The queue goes out BEFORE the first read, and it is not an optimisation: GET /sessions settles
  // a stale open session, and a set that arrives after that close is refused forever. Logged in a
  // basement last night, opened in the morning — the app's own boot read is what destroys them.
  // Forced, because nothing survives a reload to undo: the strip is gone and the hold protects a
  // gesture that no longer exists.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await queue.current.flush({ force: true });
        if (!live) return;
        const [exercises, log] = await Promise.all([api.exercises(), api.sessions({ limit: LOG_PAGE })]);
        if (!live) return;
        setCatalog(exercises);
        // Every wholesale replacement of the list bumps the walk, without exception — an older page
        // in flight continues a tail that this read has just thrown away. Today the deps are stable
        // enough that this effect runs once, which makes the bump free; the rule is total so that it
        // stays correct if they ever stop being.
        walk.current += 1;
        setSummaries(log);
        // The first page settles this too: a log of three sessions must not offer to load older ones.
        setOlderStatus(olderAfter(log));
        const open = log.find((summary) => summary.finishedAt == null);
        const detail = open ? await api.session(open.id) : null;
        if (!live) return;
        if (detail) adopt(detail.session, detail.sets);
        else setPhase('idle');
      } catch {
        if (live) setPhase('failed');
      }
    })();
    return () => { live = false; };
  }, [api, adopt]);

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

  // The log, re-read from the top — after a session closes, and after one is discarded. Both change
  // what the first page IS, so the list goes back to page one and the walk down it goes back with
  // it: a log the lifter had read to the bottom is truncated by this read, and leaving the foot
  // saying "there is nothing older" would be a lie about the middle of their history.
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

  // Last time is ONE read, and the store answers it: the newest finished session holding this
  // movement, warmups already dropped. Walking it here instead cost a request per candidate
  // session and could still only see as far back as the page of summaries in hand — a movement
  // last trained in April was "first time logging this" to a client holding May.
  //
  // The answer is kept for the session it belongs to. Within one workout the lifter walks the same
  // three or four movements repeatedly and none of their answers can change (a last time is a
  // FINISHED session, and today's is not one yet), so a movement comes back to instantly and reads
  // nothing twice. Finishing drops the lot — the workout just logged is the next last time.
  //
  // What lands re-dials the number, exactly as the deep-history read always did: the card correcting
  // itself when the log answers is the honest move, and the alternative is a screen that waits.
  // But only the CARD is the log's to correct. Once the lifter has moved the number by hand, that
  // number is theirs: a reply landing seconds later must never relabel the button under the thumb
  // that is already on it, because the write is unrecoverable — the log has no update and no delete.
  //
  // A read that never came back is SAID, because the card has a sentence for it and the alternative
  // is "reading your log…" standing there for the rest of the session — the same lie told quietly
  // (prefill.js). The flag is this movement's alone: it is lowered on the way in, and a failure that
  // lands after the lifter has walked to the next movement is dropped with the effect that asked.
  useEffect(() => {
    if (phase !== 'live' || !exerciseId) return undefined;
    let live = true;
    const resuming = restored.current === exerciseId;
    restored.current = null;
    touched.current = false;
    const known = lastTimes.current.get(exerciseId) ?? null;
    setLastTime(known);
    setLastTimeFailed(false);
    if (!resuming) dial(exerciseId, known);
    if (known) return undefined;
    (async () => {
      const answer = await api.lastTime(exerciseId).catch(() => null);
      if (!live) return;
      if (answer == null) {
        setLastTimeFailed(true);
        return;
      }
      // The movement is echoed back for this: a reply for the movement the lifter has already left
      // is dropped, and it is not a failure of the one they are standing on.
      if (answer.exerciseId !== exerciseId) return;
      lastTimes.current.set(exerciseId, answer);
      setLastTime(answer);
      if (!resuming && !touched.current) dial(exerciseId, answer);
    })();
    return () => { live = false; };
    // The prefill re-runs when the movement changes or the session does, and on nothing else: a
    // re-render that rebuilt `dial` would re-dial a number the lifter has since moved by hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, exerciseId, session?.id]);

  // THE ONE QUESTION THE LOGGER ASKS (screen 8), and the boundary it is asked at: the movement under
  // the thumb changing IS leaving the last one, whether that was a jump, a pick, or a movement added
  // between sets. Deciding it here rather than inside the two actions that move the lifter means one
  // place asks and neither of them can forget to.
  //
  // Only ever on the way to another movement. The end of a session is not a boundary this question
  // belongs at: the finish screen is a whole surface, and a sheet over it would be a sheet over the
  // wrong thing. Everything else — that a lighter day is not a question, that it is asked once — is
  // the rule's (routines.js).
  useEffect(() => {
    if (phase !== 'live' || !exerciseId) return;
    const left = standingOn.current;
    standingOn.current = exerciseId;
    if (left === null || left === exerciseId) return;
    const ask = deviationAsk({
      routine,
      planEntry: planEntryFor(session, left),
      movement: nameOfMovement(catalog, left),
      sets: setsNow.current,
      asked: asked.current,
    });
    if (!ask) return;
    asked.current = [...asked.current, ask.exerciseId];
    setDeviation(ask);
    // The boundary is the movement changing and nothing else. Widening these deps would re-ask on a
    // re-render, and "asked once" is the whole of what makes the question bearable mid-workout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, exerciseId]);

  // The queue outlives the session: a set stranded by a four-hour auto-close has to flush (or be
  // refused out loud) the next time the app opens, whether or not anything is running now.
  useEffect(() => {
    if (phase === 'loading' || phase === 'failed') return undefined;
    queue.current.flush();
    const back = () => { setOnline(true); queue.current.flush(); };
    const gone = () => setOnline(false);
    // Pocketing the phone is not a reason to break the undo window: the device is already holding
    // the held sets, and a tab discarded mid-workout picks them back up off the store. What the
    // hide DOES ask for is one more sweep of everything already out of hold.
    const leaving = () => { if (document.visibilityState === 'hidden') queue.current.flush(); };
    window.addEventListener('online', back);
    window.addEventListener('offline', gone);
    document.addEventListener('visibilitychange', leaving);
    const flushing = setInterval(() => queue.current.flush(), FLUSH_MS);
    return () => {
      window.removeEventListener('online', back);
      window.removeEventListener('offline', gone);
      document.removeEventListener('visibilitychange', leaving);
      clearInterval(flushing);
    };
  }, [phase]);

  // The beat forces a re-render and increments nothing — every clock on the screen is recomputed
  // from an instant, so the numbers survive a locked phone and a reload.
  useEffect(() => {
    if (phase !== 'live') return undefined;
    const beat = setInterval(() => setBeat((count) => count + 1), BEAT_MS);
    return () => clearInterval(beat);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'live') return undefined;
    let lock = null;
    const hold = () => {
      navigator.wakeLock?.request('screen').then((granted) => { lock = granted; }).catch(() => {});
    };
    const rehold = () => { if (document.visibilityState === 'visible') hold(); };
    hold();
    document.addEventListener('visibilitychange', rehold);
    return () => {
      document.removeEventListener('visibilitychange', rehold);
      lock?.release().catch(() => {});
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'live' || !session) return;
    writeLive({ sessionId: session.id, order, exIdx, weight, reps, restStartedAt });
  }, [phase, session, order, exIdx, weight, reps, restStartedAt]);

  const rest = restStartedAt == null
    ? null
    : restReadout({ targetSeconds: restTargetFor({ planEntry, exercise }), startedAt: restStartedAt, now: Date.now() });

  // The alert fires on the beat the target is first reached — and never on a reload that lands
  // long after it, which would be a phone shouting about a rest the lifter already took.
  const justLanded = rest != null && rest.landed && rest.left >= -2;
  useEffect(() => {
    if (!justLanded) return;
    if (alerted.current) return;
    alerted.current = true;
    playRestLanded();
  }, [justLanded]);

  // Start is pressed from three places — Today's routine card, Today's ad-hoc button and a routine's
  // own editor — so it ends by walking into the logger rather than assuming the lifter was already
  // standing in it. `routineId` asks the SERVER to freeze that routine onto the session; the client
  // never composes a snapshot (gymApi.js).
  const start = useCallback(async ({ routineId } = {}) => {
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = mintId('ses_');
      try {
        const opened = await api.startSession({ id, startedAt, routineId });
        // A start JOINS whatever session is already open, so the id that comes back is the truth
        // and may not be the one we sent. Adopting the stranger's sets silently would log this
        // workout into a session the lifter thinks is closed.
        const joined = opened.id !== id;
        const detail = joined ? await api.session(opened.id) : null;
        adopt(detail?.session ?? opened, detail?.sets ?? []);
        window.location.hash = '#/gym';
        // A join comes back with the running session's own snapshot whatever was asked for, so this
        // says which workout the lifter is now in rather than the one they pressed for.
        if (joined) say('A session was already open — you’re back in it.');
        return;
      } catch (error) {
        if (!error.sessionIdTaken) {
          say('The session didn’t start. Try again when you have signal.');
          return;
        }
      }
    }
    say('The session didn’t start. Try again when you have signal.');
  }, [api, adopt, say]);

  // A movement the catalog does not hold, minted from the picker's own search box (screen 7). It
  // lands in the catalog here, in the one instance of it this product has, so the movement the
  // lifter just created is on every picker in the app a render later — the logger's, the routine
  // editor's and the backfill form's.
  const createMovement = useCallback(async (name) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const made = await api.createExercise({ id: mintId('ex_'), name: name.trim(), ...CREATED_MOVEMENT });
        setCatalog((current) => [...current, made]);
        return made;
      } catch (error) {
        if (!error.exerciseIdTaken) {
          say('That movement wasn’t created — the log didn’t answer. Try again when you have signal.');
          return null;
        }
      }
    }
    say('That movement wasn’t created — the log didn’t answer. Try again when you have signal.');
    return null;
  }, [api, say]);

  // "Save 87.5 to Push A" — a read-modify-write of the WHOLE routine (gymApi.js), because a PUT that
  // sent only the changed entry would delete the rest of the program. The routine is re-read here
  // and never taken from the session's plan: the snapshot was frozen at the start and the program
  // has kept moving since.
  //
  // Both failures say what is still true rather than what went wrong, because what went wrong
  // changes nothing about today: the session already has the weight, whatever the routine does.
  const saveDeviation = useCallback(async () => {
    const ask = deviation;
    setDeviation(null);
    if (!ask || !session?.routineId) return;
    try {
      const stored = await api.routine(session.routineId);
      if (!stored) {
        say(`${routine} isn’t in your routines any more. Today’s session keeps the weight.`);
        return;
      }
      await api.replaceRoutine(stored.id, withEntryWeight(stored, ask, ask.weightKg));
    } catch {
      say(`${routine} didn’t change. Today’s session keeps the weight either way.`);
    }
  }, [api, deviation, routine, session, say]);

  const chooseMovement = useCallback((movement) => {
    const next = orderNow.current.includes(movement) ? orderNow.current : [...orderNow.current, movement];
    setOrder(next);
    setExIdx(next.indexOf(movement));
    setRestStartedAt(null);
    setUndo(null);
  }, []);

  const jumpTo = useCallback((index) => {
    setExIdx(index);
    setRestStartedAt(null);
    setUndo(null);
  }, []);

  // Every door the lifter's hand comes through, and the only place `touched` is raised: after this,
  // the number belongs to them until they change movement.
  const stepWeight = useCallback((direction, big) => {
    touched.current = true;
    setWeight((current) => bump(current, direction, big));
  }, []);
  const stepReps = useCallback((direction) => {
    touched.current = true;
    setReps((current) => bumpReps(current, direction));
  }, []);
  const enterWeight = useCallback((value) => { touched.current = true; setWeight(value); }, []);
  const enterReps = useCallback((value) => { touched.current = true; setReps(value); }, []);

  // Local-first: the tone plays, the row lands and the rest starts before the network is consulted
  // at all. Nothing about the flow changes offline.
  //
  // It answers whether a set actually happened, because the warmup chip disarms on the set it armed
  // and must not disarm on one that was refused — a lifter who armed it and was told the session is
  // closing has not spent the gesture.
  const logSet = useCallback((kind = 'working') => {
    if (!session || !exerciseId) return false;
    // Finish is a round trip, and a set logged into a session that closes under it is refused
    // forever. The lifter is told, in the same breath, where that set can still go.
    if (finishing) {
      say('The session is closing — log that set in the next one.');
      return false;
    }
    playSetLogged();
    const completedAt = Date.now();
    const entry = queue.current.enqueue({
      setId: mintId('set_'),
      sessionId: session.id,
      exerciseId,
      weightKg: weight,
      reps,
      kind,
      completedAt,
    });
    setSets((current) => [...current, {
      id: entry.setId, exerciseId, weightKg: weight, reps, kind, completedAt, setNumber: null, queued: true,
    }]);
    setPending(queue.current.pending);
    setRestStartedAt(completedAt);
    alerted.current = false;
    setUndo({ setId: entry.setId, weightKg: weight, reps, at: completedAt });
    // The row says `on this device` on the lifter's authority that the device took it. When the
    // store refuses — a full disk, a locked-down browser — that sentence is a lie and the only copy
    // of the set is this tab's memory: ask the network now, and say what happened.
    if (!queue.current.durable) {
      queue.current.flush();
      say('This device wouldn’t store that set — keep the app open until it reaches the log.');
    }
    return true;
  }, [session, exerciseId, weight, reps, finishing, say]);

  // The mistake seconds ago. The window IS the queue's hold, so a set the lifter takes back never
  // reached the log at all — nothing already written is ever destroyed by one gesture.
  const undoLast = useCallback(() => {
    if (!undo) return;
    if (!queue.current.withdraw(undo.setId)) {
      setUndo(null);
      say('That set already reached the log — it stays in your history.');
      return;
    }
    setSets((current) => current.filter((set) => set.id !== undo.setId));
    setPending(queue.current.pending);
    setRestStartedAt(null);
    setUndo(null);
    say('Set removed');
  }, [undo, say]);

  const finish = useCallback(async () => {
    if (!session || finishing) return;
    setFinishing(true);
    const { drained, stranded } = await queue.current.flushBeforeFinish(session.id);
    if (!drained) {
      setFinishing(false);
      const stuck = stranded.length;
      const count = `${stuck} ${stuck === 1 ? 'set is' : 'sets are'}`;
      // The one thing this sentence may never do is claim the device is holding a set it refused.
      if (!queue.current.durable) {
        say(`${count} not on the log, and this device wouldn’t store ${stuck === 1 ? 'it' : 'them'}. Stay here until the log answers.`);
        return;
      }
      say(`${count} still saved on this device. Finish once they land — a closed session can’t take them.`);
      return;
    }
    const finishedAt = Date.now();
    try {
      await api.finishSession(session.id, { finishedAt });
    } catch {
      setFinishing(false);
      say('The session is still open — the log didn’t answer. Try again when you have signal.');
      return;
    }
    setFinishing(false);
    writeLive(null);
    // The session that just closed is the next last time for every movement in it, so nothing that
    // was true a minute ago is true now.
    lastTimes.current.clear();
    setPhase('idle');
    setSession(null);
    setSets([]);
    setOrder([]);
    setExIdx(0);
    setRestStartedAt(null);
    setUndo(null);
    setLastTime(null);
    setLastTimeFailed(false);
    setDeviation(null);
    standingOn.current = null;
    asked.current = [];
    // Finishing hands the lifter to the end of the session they just trained — three facts, at most
    // one line of meaning, and the way back into the log under it. Nothing is said in a toast on the
    // way: the screen it lands on IS what happened, and a toast would be that said twice, quieter.
    window.location.hash = finishHref(session.id);
    reloadLog();
  }, [api, session, finishing, reloadLog, say]);

  // The toast is the one thing here that is counted rather than derived, because it has no instant
  // worth surviving a reload: five seconds after it was said, it has been read or it has not.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const now = Date.now();
  return {
    phase,
    session,
    routine,
    catalog,
    summaries,
    // One page of the log is on screen; this is everything the surface needs to walk further down it.
    older: { status: olderStatus, load: loadOlder },
    order,
    exIdx,
    exercise,
    sets,
    todaySets,
    workingToday: workingSetsOf(todaySets, exerciseId).length,
    planEntry,
    lastTime,
    // The card has four states and only two of them are a training fact: this is the one that says
    // the log did not answer, which nothing else on the screen can tell from a read still in flight.
    lastTimeFailed,
    // The mid-session question, standing or absent. Absent is the normal state of a workout.
    deviation,
    weight,
    reps,
    rest,
    undo: undo && now - undo.at < UNDO_WINDOW_MS ? undo : null,
    toast,
    refusals,
    // Every set still in the queue is saved on this device and nowhere else, whether or not the
    // log has been asked yet. A retry counter cannot decide this: an entry inside its undo window
    // and an entry behind a jam have both been attempted zero times, and both would have drawn as
    // durable — the one false note this product cannot afford.
    stalled: new Set(pending.map((entry) => entry.setId)),
    offline: !online,
    finishing,
    elapsed: session ? now - session.startedAt : 0,
    start,
    createMovement,
    chooseMovement,
    jumpTo,
    stepWeight,
    stepReps,
    setWeight: enterWeight,
    setReps: enterReps,
    logSet,
    undoLast,
    resetRest: () => setRestStartedAt(null),
    finish,
    saveDeviation,
    // "Today only" — the session already has the weight, so declining changes nothing and costs
    // nothing. It is not asked again about this movement either way.
    dismissDeviation: () => setDeviation(null),
    // The log, re-read: the finish screen's discard and the backfill form both change what the
    // first page is, and neither of them owns the list.
    reloadLog,
    // The one voice in the product. Handed out so a surface that is not this hook — a discard, a
    // backfill that half-landed — says what happened in the same place everything else does.
    say,
    dismissToast: () => setToast(null),
    clearRefusals: () => setRefusals([]),
  };
}
