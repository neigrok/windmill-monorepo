import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncRecords } from '../../platform/sync/react.js';
import { UNDO_MS } from './fix.js';
import { failureReason } from './gymApi.js';
import { useGymApi, gymStep } from './gymSync.js';
import { projectGym } from './syncProjections.js';
import { mintId } from './mint.js';
import { CREATED_PATTERN } from './logger/movements.js';
import { readPreferences } from './settings/preferences.js';
import { spellWeightsIn } from './units.js';
import { goneIds, hiddenIds, openHeld, transientOf, UNDO_LABEL, WINDOW_CLOSED, withheldKey } from './withheld.js';

const LOG_PAGE = 50;
const TOAST_MS = 9000;

export function useTrainingLog({ api: injected } = {}) {
  const boundApi = useGymApi();
  const api = injected ?? boundApi;
  const records = useSyncRecords('self/gym');
  const [depth, setDepth] = useState(LOG_PAGE);
  const [expiry, expire] = useState(0);
  const [toast, setToast] = useState(null);
  const [, redrawWindow] = useState(0);
  const spoke = useRef(0);
  const [injectedData, setInjectedData] = useState(null);
  const projection = useMemo(() => projectGym(records.stored, {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }), [records, expiry]);
  const ready = api.ready !== false && (Boolean(injected) || records.firstPullComplete || records.drawn.length > 0);
  const phase = ready ? 'ready' : 'loading';
  const summaries = [];
  while (summaries.length < depth) {
    const last = summaries.at(-1);
    const page = projection.sessions({ limit: Math.min(200, depth - summaries.length),
      ...(last ? { before: last.startedAt, beforeId: last.id } : {}) });
    summaries.push(...page);
    if (page.length === 0) break;
  }
  if (injectedData) summaries.splice(0, summaries.length, ...injectedData.summaries);
  const open = records.stored.find((row) => row.t === 'session' && row.life?.[0] !== 'dead' && row.f?.finishedAt === undefined);
  const detail = open ? projection.session(open.id) : null;
  const session = detail?.session.finishedAt == null ? detail?.session ?? null : null;
  const sets = session ? detail.sets : [];
  const catalog = injectedData?.catalog ?? projection.exercises();
  const preferences = readPreferences(injectedData?.preferences ?? projection.preferences());
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
  useEffect(() => {
    if (!injected) return;
    let alive = true;
    Promise.all([injected.exercises(), injected.sessions({ limit: depth }), injected.preferences()]).then(([catalog, summaries, preferences]) => {
      if (alive) setInjectedData({ catalog, summaries, preferences });
    }).catch(() => {});
    return () => { alive = false; };
  }, [injected, depth]);

  const say = useCallback((text, { action = null } = {}) => {
    spoke.current += 1;
    setToast({ text, at: spoke.current, action });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const withheld = useRef([]);
  const roomLive = useRef(true);
  const clocks = useRef(new Map());
  const settled = useRef([]);
  const publish = useCallback((next) => {
    withheld.current = next;
    redrawWindow((count) => count + 1);
  }, []);

  const close = useCallback(async (key) => {
    clocks.current.delete(key);
    const closing = withheld.current.find((each) => each.key === key);
    if (!closing) return;
    publish(withheld.current.map((each) => (each.key === key ? { ...each, settling: true } : each)));
    try {
      if (!closing.engineDeath) await closing.send?.();
      const stillHeld = withheld.current.some((each) => each.key === key);
      if (!closing.engineDeath && closing.send && stillHeld) settled.current = [...settled.current, { kind: closing.kind, id: closing.id }];
    } catch (error) {
      closing.refused?.(error);
    } finally {
      publish(withheld.current.filter((each) => each.key !== key));
    }
  }, [publish]);

  const withhold = useCallback(({ kind, id, line, detail = null, send = null, refused = null, undo = null, engineDeath = null }) => {
    if (engineDeath && api.ready === false) return;
    const key = withheldKey(kind, id);
    if (withheld.current.some((each) => each.key === key)) return;
    const durable = engineDeath && api.holdDeath;
    const pending = durable ? api.holdDeath(engineDeath.type, engineDeath.id) : null;
    spoke.current += 1;
    publish([...withheld.current, { key, kind, id, line, detail, send, refused, undo,
      engineDeath: durable ? engineDeath : null, pending, at: spoke.current, settling: false }]);
    if (pending) pending.then(() => {
      if (roomLive.current && withheld.current.some((each) => each.key === key)) clocks.current.set(key, setTimeout(() => close(key), UNDO_MS));
    }).catch((error) => {
      if (!roomLive.current) return;
      clearTimeout(clocks.current.get(key));
      clocks.current.delete(key);
      publish(withheld.current.filter((each) => each.key !== key));
      refused?.(error);
    });
    else clocks.current.set(key, setTimeout(() => close(key), UNDO_MS));
  }, [api, close, publish]);

  const undoWithheld = useCallback(async () => {
    const open = openHeld(withheld.current);
    if (open.length === 0) {
      say(WINDOW_CLOSED);
      return;
    }
    const newest = open[open.length - 1];
    if (newest.pending) {
      try {
        const gesture = await newest.pending;
        if (!await api.undoDeath(gesture)) { say(WINDOW_CLOSED); return; }
      } catch { say('That delete could not be taken back.'); return; }
    }
    clearTimeout(clocks.current.get(newest.key));
    clocks.current.delete(newest.key);
    publish(withheld.current.filter((each) => each.key !== newest.key));
    newest.undo?.();
  }, [api, publish, say]);

  const dropWithheld = useCallback((kind) => {
    withheld.current.filter((each) => each.kind === kind).forEach((each) => {
      clearTimeout(clocks.current.get(each.key));
      clocks.current.delete(each.key);
    });
    publish(withheld.current.filter((each) => each.kind !== kind));
  }, [publish]);

  const writtenAgain = useCallback((kind, id) => {
    const key = withheldKey(kind, id);
    const clock = clocks.current.get(key);
    if (clock !== undefined) {
      clearTimeout(clock);
      clocks.current.delete(key);
    }
    settled.current = settled.current.filter((each) => !(each.kind === kind && each.id === id));
    publish(withheld.current.filter((each) => each.key !== key));
  }, [publish]);

  const abandon = useCallback(() => {
    const open = openHeld(withheld.current).filter((each) => !each.engineDeath);
    if (open.length === 0) return;
    open.forEach((each) => {
      clearTimeout(clocks.current.get(each.key));
      clocks.current.delete(each.key);
      each.undo?.();
    });
    publish(withheld.current.filter((each) => each.settling || each.engineDeath));
  }, [publish]);

  useEffect(() => {
    const flipped = () => {
      if (document.visibilityState !== 'visible') {
        abandon();
        withheld.current.filter((each) => each.engineDeath).forEach((each) => {
          clearTimeout(clocks.current.get(each.key));
          clocks.current.delete(each.key);
        });
        publish(withheld.current.filter((each) => !each.engineDeath));
        return;
      }
    };
    document.addEventListener('visibilitychange', flipped);
    return () => document.removeEventListener('visibilitychange', flipped);
  }, [abandon, publish]);

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
    const released = withheld.current.filter((each) => each.engineDeath && records.stored.some((row) =>
      row.t === each.engineDeath.type && row.id === each.id && row.life?.[0] === 'dead'));
    if (!released.length) return;
    for (const each of released) { clearTimeout(clocks.current.get(each.key)); clocks.current.delete(each.key); }
    publish(withheld.current.filter((each) => !released.includes(each)));
  }, [records, publish]);

  const reloadLog = useCallback(async () => {}, []);
  const retryBoot = reloadLog;
  const createMovement = useCallback(async ({ name, equipment }) => {
    try { return await api.createExercise({ id: mintId('ex_'), name: name.trim(), equipment, pattern: CREATED_PATTERN }); }
    catch (error) { say(`That movement wasn’t created — ${failureReason(error)}.`); return null; }
  }, [api, say]);
  const renameMovement = useCallback(async (id, name) => {
    try { return await api.renameExercise(id, name.trim()); }
    catch (error) { say(`That name wasn’t saved — ${failureReason(error)}.`); return null; }
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
  const dead = (kind, rows = records.drawn) => {
    const type = kind === 'bodyweight' ? 'weighin' : kind;
    return rows.filter((row) => row.t === type && row.life?.[0] === 'dead').map((row) => ({ kind, id: row.id }));
  };
  const hidden = (kind) => hiddenIds(withheld.current, [...settled.current, ...dead(kind)], kind);
  const gone = (kind) => goneIds([...settled.current, ...dead(kind, records.stored)], kind);
  const spoken = transientOf(toast, withheld.current);
  const transient = spoken == null ? null : {
    text: spoken.text, detail: spoken.detail ?? null,
    action: spoken.undoable ? { label: UNDO_LABEL, run: undoWithheld } : spoken.action ?? null,
    dismiss: spoken.undoable ? null : dismissToast,
  };
  return {
    phase, revision: records, progress, reloadProgress: reloadLog, failure: null, retryBoot,
    session, sets, catalog, summaries, preferences,
    older: { status: summaries.length < depth ? 'end' : 'more', load: () => setDepth((count) => count + LOG_PAGE) },
    reloadLog, createMovement, renameMovement, say, transient, held: withheld.current, hidden, gone,
    withhold, undoWithheld, dropWithheld, writtenAgain,
  };
}
