import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSyncRecords } from '../../platform/sync/react.js';
import { syncSession } from '../../platform/sync/session.js';
import { captureError } from '../../telemetry/sentry.js';
import { localDay, watchLocalDay } from './localDay.js';
import { isWritten, pagesOf, savePage, SCOPE } from './pages.js';

export function useToday() {
  const [today, setToday] = useState(localDay);
  useEffect(() => watchLocalDay(setToday), []);
  return today;
}

export function usePages() {
  const session = useSyncExternalStore(syncSession.subscribe, syncSession.getSnapshot, syncSession.getSnapshot);
  const records = useSyncRecords(SCOPE);
  const today = useToday();
  const [editor, setEditor] = useState(null);
  const [failure, setFailure] = useState(false);
  const [saveTick, setSaveTick] = useState(0);
  const draft = useRef(null);
  const writes = useRef(0);
  const key = `${records.replica}:${today}`;
  const engine = session.engine;
  const pages = engine && session.ready ? pagesOf(engine, records) : [];
  const held = pages.find((page) => page.day === today) ?? { day: today, body: '', mood: null, energy: null, source: 'typed' };
  const shown = editor?.key === key ? editor.doc : held;
  const change = useCallback((field, value) => {
    if (!engine || !session.ready) return;
    const current = draft.current?.key === key ? draft.current.doc
      : pagesOf(engine).find((page) => page.day === today) ?? held;
    const doc = { day: today, body: current.body, mood: current.mood, energy: current.energy,
      source: current.source, [field]: value };
    const writing = { key, doc, saved: false };
    draft.current = writing;
    setEditor(draft.current); setFailure(false);
    writes.current++;
    savePage(engine, doc, records.replica).then(() => {
      writing.saved = true;
      setSaveTick((tick) => tick + 1);
    }).catch(() => {
      if (draft.current === writing) setFailure(true);
      captureError('journal', 'journal-save', '', '/journal');
    }).finally(() => {
      writes.current--;
      if (!writes.current && draft.current?.saved) {
        draft.current = null;
        setEditor(null);
      }
    });
  }, [engine, session.ready, key, today, held.body, held.mood, held.energy, held.source, records.replica]);
  useEffect(() => { draft.current = null; setEditor(null); setFailure(false); }, [key]);
  const hasPending = engine?.device.activeReplica.entries(SCOPE).length > 0
    || Object.keys(engine?.device.activeReplica.deviceRows('journal') ?? {}).some((key) => key.startsWith('pendingClaim:'));
  const state = records.drawn.find((row) => row.t === 'journalState');
  const retained = Object.assign({}, ...Object.values(engine?.device.activeReplica.deviceRows('journal') ?? {})
    .filter((row) => row?.claimId).map((row) => row.retirements));
  const retireScales = () => {
    if (engine && session.ready) savePage(engine, { day: today, body: shown.body, mood: shown.mood, energy: shown.energy, source: shown.source }, records.replica, { scales: 'retired' })
      .catch(() => captureError('journal', 'journal-invitation', '', '/journal'));
  };
  const readState = !session.ready ? 'loading' : engine.device.activeReplica.meta.state === 'anon' ? 'device'
    : records.firstPullComplete ? 'ready' : 'failed';
  const saveState = records.notices.some((notice) => !notice.dismissed) ? 'refused' : failure ? 'unsaved' : !session.online ? 'offline'
    : engine?.device.activeReplica.meta.state === 'anon' || hasPending ? 'device' : 'saved';
  return { today, history: pages.filter((page) => page.day < today && isWritten(page)).map((page) => ({ ...page, date: page.day })),
    loading: !session.ready, readState,
    firstRun: session.ready && records.firstPullComplete && !pages.some(isWritten) && state?.f.placeholder?.[0] !== 'retired',
    scalesInvitation: state?.f.firstPage?.[0] === 'retired' && (retained.scales ?? state?.f.scales?.[0]) !== 'retired', retireScales,
    body: shown.body, mood: shown.mood, energy: shown.energy, saveState, saveTick,
    setBody: (value) => change('body', value), setMood: (value) => change('mood', value), setEnergy: (value) => change('energy', value),
  };
}
