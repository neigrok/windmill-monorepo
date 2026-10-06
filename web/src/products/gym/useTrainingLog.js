import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncRecords } from '../../platform/sync/react.js';
import { UNDO_MS } from './fix.js';
import { failureReason } from './errors.js';
import { useGymApi, gymStep } from './gymSync.js';
import { projectGym } from './syncProjections.js';
import { mintId } from './mint.js';
import { CREATED_PATTERN } from './logger/movements.js';
import { readPreferences } from './settings/preferences.js';
import { spellWeightsIn } from './units.js';
import {
  deleteLineOf, goneIds, HELD_KINDS, HELD_TYPES, hiddenIds, openHeld, transientOf, UNDO_LABEL, WINDOW_CLOSED, withheldKey,
} from './withheld.js';

const LOG_PAGE = 50;
const TOAST_MS = 9000;

export function useTrainingLog() {
  const api = useGymApi();
  const records = useSyncRecords('self/gym');
  const [depth, setDepth] = useState(LOG_PAGE);
  const [expiry, expire] = useState(0);
  const [toast, setToast] = useState(null);
  const [, redrawWindow] = useState(0);
  const spoke = useRef(0);
  const projection = useMemo(() => projectGym(records.stored, {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }), [records, expiry]);
  const ready = Boolean(api?.ready);
  const phase = ready ? 'ready' : 'loading';
  const summaries = [];
  while (summaries.length < depth) {
    const last = summaries.at(-1);
    const page = projection.sessions({ limit: Math.min(200, depth - summaries.length),
      ...(last ? { before: last.startedAt, beforeId: last.id } : {}) });
    summaries.push(...page);
    if (page.length === 0) break;
  }
  const open = records.stored.find((row) => row.t === 'session' && row.life?.[0] !== 'dead' && row.f?.finishedAt === undefined);
  const detail = open ? projection.session(open.id) : null;
  const session = detail?.session.finishedAt == null ? detail?.session ?? null : null;
  const sets = session ? detail.sets : [];
  const catalog = projection.exercises();
  const preferences = readPreferences(projection.preferences());
  const progress = ready ? { phase: 'ready', data: projection.progress() } : { phase: 'loading', data: null };
  useEffect(() => { spellWeightsIn(preferences.units); }, [preferences.units]);
  useEffect(() => {
    const open = records.stored.find((row) => row.t === 'session' && row.life?.[0] !== 'dead' && row.f?.finishedAt === undefined);
    if (!open) return undefined;
    const activity = Math.max(open.f.startedAt[0], ...records.stored.filter((row) => row.t === 'set' && row.life?.[0] !== 'dead' && row.f?.sessionId?.[0] === open.id).map((row) => row.f.completedAt[0]));
    const remaining = activity + 4 * 3600_000 - Date.now();
    if (remaining <= 0) return undefined;
    const timer = setTimeout(() => expire((count) => count + 1), remaining);
    return () => clearTimeout(timer);
  }, [records]);

  const say = useCallback((text, { action = null } = {}) => {
    spoke.current += 1;
    setToast({ text, at: spoke.current, action });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  // The room's own windows, each on this room's clock: a Coach conversation's REST delete and a dropped draft line.
  const withheld = useRef([]);
  // Engine deletes asked for and not yet stored; once stored, the engine's own offer stands in for each.
  const asking = useRef([]);
  // When each engine hold first spoke in this room, so the transient knows which spoke last.
  const spokeAt = useRef(new Map());
  const offers = useRef(records.undoOffers);
  offers.current = records.undoOffers;
  const roomLive = useRef(true);
  const clocks = useRef(new Map());
  const settled = useRef([]);
  const redraw = useCallback(() => redrawWindow((count) => count + 1), []);
  const publish = useCallback((next) => {
    withheld.current = next;
    redraw();
  }, [redraw]);

  // Every delete the window holds, oldest first: asked of the engine, held by it inside its own deadline, the room's own.
  const heldNow = useCallback(() => {
    const now = Date.now();
    const holding = [];
    for (const offer of offers.current) {
      if (offer.releaseAt <= now) continue;
      for (const { t, id } of offer.records) {
        const kind = HELD_KINDS[t];
        const key = withheldKey(kind, id);
        if (!kind || asking.current.some((each) => each.key === key)) continue;
        if (!spokeAt.current.has(offer.id)) spokeAt.current.set(offer.id, (spoke.current += 1));
        holding.push({ key, kind, id, gestureId: offer.id, releaseAt: offer.releaseAt, at: spokeAt.current.get(offer.id), settling: false });
      }
    }
    return [...asking.current, ...holding, ...withheld.current].sort((a, b) => a.at - b.at);
  }, []);
  const holds = useCallback((key) => heldNow().some((each) => each.key === key), [heldNow]);

  const close = useCallback(async (key) => {
    clocks.current.delete(key);
    const closing = withheld.current.find((each) => each.key === key);
    if (!closing) return;
    publish(withheld.current.map((each) => (each.key === key ? { ...each, settling: true } : each)));
    try {
      await closing.send?.();
      const stillHeld = withheld.current.some((each) => each.key === key);
      if (closing.send && stillHeld) settled.current = [...settled.current, { kind: closing.kind, id: closing.id }];
    } catch (error) {
      closing.refused?.(error);
    } finally {
      publish(withheld.current.filter((each) => each.key !== key));
    }
  }, [publish]);

  const withhold = useCallback(({ kind, id, line, detail = null, send = null, refused = null, undo = null }) => {
    const key = withheldKey(kind, id);
    if (holds(key)) return;
    spoke.current += 1;
    publish([...withheld.current, { key, kind, id, line, detail, send, refused, undo, at: spoke.current, settling: false }]);
    clocks.current.set(key, setTimeout(() => close(key), UNDO_MS));
  }, [close, holds, publish]);

  const holdDelete = useCallback(({ kind, id, refused = null }) => {
    const key = withheldKey(kind, id);
    if (!api?.ready || holds(key)) return;
    spoke.current += 1;
    const at = spoke.current;
    const pending = api.holdDeath(HELD_TYPES[kind], id);
    asking.current = [...asking.current, { key, kind, id, pending, at, settling: false }];
    redraw();
    const answered = () => {
      asking.current = asking.current.filter((each) => each.key !== key);
      if (roomLive.current) redraw();
    };
    pending.then((gestureId) => {
      spokeAt.current.set(gestureId, at);
      answered();
    }, (error) => {
      answered();
      if (roomLive.current) refused?.(error);
    });
  }, [api, holds, redraw]);

  const undoWithheld = useCallback(async () => {
    const open = openHeld(heldNow());
    if (open.length === 0) {
      say(WINDOW_CLOSED);
      return;
    }
    const newest = open[open.length - 1];
    if (newest.gestureId || newest.pending) {
      const gestureId = newest.gestureId ?? await newest.pending.catch(() => null);
      if (!gestureId) return;
      try {
        if (!await api.undoDeath(gestureId)) say(WINDOW_CLOSED);
      } catch (error) { say(`That delete could not be taken back — ${failureReason(error)}.`); }
      return;
    }
    clearTimeout(clocks.current.get(newest.key));
    clocks.current.delete(newest.key);
    publish(withheld.current.filter((each) => each.key !== newest.key));
    newest.undo?.();
  }, [api, heldNow, publish, say]);

  const dropWithheld = useCallback((kind) => {
    withheld.current.filter((each) => each.kind === kind).forEach((each) => {
      clearTimeout(clocks.current.get(each.key));
      clocks.current.delete(each.key);
    });
    publish(withheld.current.filter((each) => each.kind !== kind));
  }, [publish]);

  const abandon = useCallback(() => {
    const open = openHeld(withheld.current);
    if (open.length === 0) return;
    open.forEach((each) => {
      clearTimeout(clocks.current.get(each.key));
      clocks.current.delete(each.key);
      each.undo?.();
    });
    publish(withheld.current.filter((each) => each.settling));
  }, [publish]);

  useEffect(() => {
    const flipped = () => {
      if (document.visibilityState !== 'visible') abandon();
    };
    document.addEventListener('visibilitychange', flipped);
    return () => document.removeEventListener('visibilitychange', flipped);
  }, [abandon]);

  useEffect(() => {
    roomLive.current = true;
    return () => {
      roomLive.current = false;
      clocks.current.forEach((timer) => clearTimeout(timer));
      clocks.current.clear();
      withheld.current = [];
    };
  }, []);
  useEffect(() => {
    const offered = new Set(records.undoOffers.map((offer) => offer.id));
    for (const gestureId of spokeAt.current.keys()) if (!offered.has(gestureId)) spokeAt.current.delete(gestureId);
  }, [records.undoOffers]);

  const createMovement = useCallback(async ({ name, equipment }) => {
    try { return await api.createExercise({ id: mintId('ex_'), name, equipment, pattern: CREATED_PATTERN }); }
    catch (error) { say(error.sentence || `That movement wasn’t created — ${failureReason(error)}.`); return null; }
  }, [api, say]);
  const renameMovement = useCallback(async (id, name) => {
    try { return await api.renameExercise(id, name); }
    catch (error) { say(error.sentence || `That name wasn’t saved — ${failureReason(error)}.`); return null; }
  }, [api, say]);
  const seen = useRef(new Map());
  useEffect(() => {
    for (const notice of records.notices) {
      if (notice.dismissed) continue;
      const fingerprint = JSON.stringify(notice.content);
      if (seen.current.get(notice.id) === fingerprint) continue;
      seen.current.set(notice.id, fingerprint);
      say('A change could not be saved to the log. Your other changes are still here.');
      gymStep('refusal', 'refused');
    }
  }, [records.notices, say]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast((current) => current === toast ? null : current), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  const dead = (kind, rows = records.drawn) => rows.filter((row) => row.t === HELD_TYPES[kind] && row.life?.[0] === 'dead')
    .map((row) => ({ kind, id: row.id }));
  // An engine delete is named from the store, which keeps its record until the delete is released.
  const held = heldNow().map((each) => (each.line === undefined
    ? { ...each, line: deleteLineOf(each.kind, each.id, projection), detail: null } : each));
  const hidden = (kind) => hiddenIds(held, [...settled.current, ...dead(kind)], kind);
  const gone = (kind) => goneIds([...settled.current, ...dead(kind, records.stored)], kind);
  const spoken = transientOf(toast, held);
  const transient = spoken == null ? null : {
    text: spoken.text, detail: spoken.detail ?? null,
    action: spoken.undoable ? { label: UNDO_LABEL, run: undoWithheld } : spoken.action ?? null,
    dismiss: spoken.undoable ? null : dismissToast,
  };
  return {
    phase, progress,
    session, sets: sets.filter((set) => !hidden('set').has(set.id)), catalog, summaries, preferences,
    older: { status: summaries.length < depth ? 'end' : 'more', load: () => setDepth((count) => count + LOG_PAGE) },
    createMovement, renameMovement, say, transient, held, hidden, gone,
    withhold, holdDelete, undoWithheld, dropWithheld,
  };
}
