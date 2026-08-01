// The live session, wired: the one place in gym where the pure rules meet the network, the clock,
// the screen lock and the browser's storage. Everything it decides it decides by asking a module —
// the ladder moves the weight, prefill picks the number, the queue owns durability — so this file
// is the plumbing and none of the meaning.
//
// Three rules it exists to keep:
//   · the clock is DERIVED. A 500ms beat forces a re-render and increments nothing, so a locked
//     phone, a backgrounded tab and a full reload all come back to the true elapsed time.
//   · the queue flushes FIRST — before the boot read, and the moment the signal returns — because
//     reading the log SETTLES a stale open session, and a set that arrives after that close is
//     refused forever. An auto-close over an unflushed queue is the one loss the device cannot
//     see coming, and the app's own first request is what fires it.
//   · finishing waits for this session's sets to land. A session that closed before a set reached
//     it refuses that set forever, so Finish only completes when there is nothing left to lose.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gymApi } from '../gymApi.js';
import { durLabel, planOf } from '../log.js';
import { FlushQueue, localStore, mintId, UNDO_WINDOW_MS } from './flushQueue.js';
import { bump, bumpReps } from './ladder.js';
import { EMPTY_BAR_KG, EMPTY_BAR_REPS, planEntryFor, prefillFor, workingSetsOf } from './prefill.js';
import { restReadout, restTargetFor } from './rest.js';
import { playRestLanded, playSetLogged } from './sound.js';

const LIVE_KEY = 'windmill.gym.live';
const QUEUE_KEY = 'windmill.gym.queue';
const BEAT_MS = 500;
const FLUSH_MS = 4000;
const TOAST_MS = 5000;
// Must stay at or under the server's own ceiling: the handler clamps limit to 200, so a larger page
// size here would come back short of what was asked for and read as the bottom of the log — half a
// lifter's history hidden under "that's the start of your log".
const LOG_PAGE = 50;

function readLive() {
  try {
    return JSON.parse(window.localStorage.getItem(LIVE_KEY));
  } catch {
    return null;
  }
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
    const kept = readLive();
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
    setSession(row);
    setSets(merged);
    setOrder(nextOrder);
    setExIdx(Math.max(0, Math.min(mine?.exIdx ?? nextOrder.length - 1, nextOrder.length - 1)));
    setRestStartedAt(mine?.restStartedAt ?? null);
    // A reload is not a movement change: the number the lifter had dialled comes back as it was,
    // and the prefill stays out of the way for exactly that one resume.
    if (mine) {
      setWeight(mine.weight);
      setReps(mine.reps);
      restored.current = nextOrder[Math.max(0, Math.min(mine.exIdx ?? nextOrder.length - 1, nextOrder.length - 1))] ?? null;
    }
    setPending(queue.current.pending);
    setPhase('live');
  }, []);

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
  useEffect(() => {
    if (phase !== 'live' || !exerciseId) return undefined;
    let live = true;
    const resuming = restored.current === exerciseId;
    restored.current = null;
    touched.current = false;
    const known = lastTimes.current.get(exerciseId) ?? null;
    setLastTime(known);
    if (!resuming) dial(exerciseId, known);
    if (known) return undefined;
    (async () => {
      const answer = await api.lastTime(exerciseId).catch(() => null);
      // The movement is echoed back for this: a reply for the movement the lifter has already left
      // is dropped, and so is a read that never came back — which leaves the card saying it is
      // still reading rather than claiming a history the log never denied.
      if (!live || answer?.exerciseId !== exerciseId) return;
      lastTimes.current.set(exerciseId, answer);
      setLastTime(answer);
      if (!resuming && !touched.current) dial(exerciseId, answer);
    })();
    return () => { live = false; };
    // The prefill re-runs when the movement changes or the session does, and on nothing else: a
    // re-render that rebuilt `dial` would re-dial a number the lifter has since moved by hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, exerciseId, session?.id]);

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
    : restReadout({ targetSeconds: restTargetFor(exercise), startedAt: restStartedAt, now: Date.now() });

  // The alert fires on the beat the target is first reached — and never on a reload that lands
  // long after it, which would be a phone shouting about a rest the lifter already took.
  const justLanded = rest != null && rest.landed && rest.left >= -2;
  useEffect(() => {
    if (!justLanded) return;
    if (alerted.current) return;
    alerted.current = true;
    playRestLanded();
  }, [justLanded]);

  const start = useCallback(async () => {
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = mintId('ses_');
      try {
        const opened = await api.startSession({ id, startedAt });
        // A start JOINS whatever session is already open, so the id that comes back is the truth
        // and may not be the one we sent. Adopting the stranger's sets silently would log this
        // workout into a session the lifter thinks is closed.
        const joined = opened.id !== id;
        const detail = joined ? await api.session(opened.id) : null;
        adopt(detail?.session ?? opened, detail?.sets ?? []);
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
  const logSet = useCallback((kind = 'working') => {
    if (!session || !exerciseId) return;
    // Finish is a round trip, and a set logged into a session that closes under it is refused
    // forever. The lifter is told, in the same breath, where that set can still go.
    if (finishing) {
      say('The session is closing — log that set in the next one.');
      return;
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
    const total = setsNow.current.length;
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
    say(`Session saved · ${durLabel(finishedAt - session.startedAt)} · ${total} sets`);
    // Finishing hands the lifter to the log, where the session they just trained is now the top row.
    // The list goes back to page one, so the walk down it goes back with it — a log the lifter had
    // read to the bottom is truncated by this read, and "there is nothing older" would be a lie.
    window.location.hash = '#/gym/log';
    walk.current += 1;
    // The catch has to speak. Bumping the walk above orphans any older page already in the air, and
    // that page's own arms both fall silent once they see they are stale — so if this read is the
    // one that fails, nothing is left to release the status and the foot stays disabled at
    // "Loading older sessions…" until a reload. 'more' is the honest guess: the list on screen is
    // whatever survived, and asking again is exactly the recovery.
    api.sessions({ limit: LOG_PAGE }).then((log) => {
      setSummaries(log);
      setOlderStatus(olderAfter(log));
    }).catch(() => setOlderStatus('more'));
  }, [api, session, finishing, say]);

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
    dismissToast: () => setToast(null),
    clearRefusals: () => setRefusals([]),
  };
}
