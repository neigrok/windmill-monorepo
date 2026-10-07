import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSyncRecords } from '../../platform/sync/react.js';
import { syncSession } from '../../platform/sync/session.js';
import { captureError } from '../../telemetry/sentry.js';
import { localDay, watchLocalDay } from './localDay.js';
import { isWritten, journalRoom, pagesOf, recoveredDrafts, retireInvitation, savePage, SCOPE } from './pages.js';
import { EditorDraft, JournalWriting } from './domain/writing.js';

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
  const drafts = useRef(new Map());
  const key = `${records.replica}:${today}`;
  const engine = session.engine;
  const pages = engine && session.ready ? pagesOf(engine, records) : [];
  const held = pages.find((page) => page.day === today) ?? { day: today, body: '', mood: null, energy: null, source: 'typed' };
  const shown = editor?.replica === records.replica && !editor.saved && !editor.recovered ? editor.doc : held;
  const persist = useCallback((writing, previous = null) => {
    drafts.current.set(writing.replica, writing);
    setEditor(writing); setFailure(false);
    const save = () => {
      if (engine.activeReplica() !== writing.replica) throw new Error('journal-replica-changed');
      const retained = engine.device.activeReplica.deviceRows('journal')[EditorDraft.key];
      let priorDraft = writing.priorDraft ?? null;
      if (priorDraft && previous?.saved && !retained) priorDraft = null;
      const previousDocument = previous && { body: previous.doc.body, mood: previous.doc.mood, energy: previous.doc.energy, source: previous.doc.source };
      const matchesPrevious = previousDocument && Object.entries(previousDocument).every(([field, value]) => retained?.document[field] === value);
      if (priorDraft && retained?.day === writing.doc.day && matchesPrevious) priorDraft = null;
      if (!priorDraft && retained && writing.carriedFrom && retained.day === writing.carriedFrom) {
        if (!matchesPrevious) throw new Error('journal-draft-changed');
        priorDraft = retained;
      }
      return savePage(engine, writing.doc, writing.replica, {}, priorDraft);
    };
    writing.pending = true;
    writing.saving = (previous?.pending ? previous.saving.then(save) : Promise.resolve().then(save)).then(() => {
      writing.saved = true;
      if (drafts.current.get(writing.replica) === writing) {
        drafts.current.delete(writing.replica);
        if (engine.activeReplica() === writing.replica) { setEditor(null); setFailure(false); }
      }
      setSaveTick((tick) => tick + 1);
    }).catch(() => {
      writing.failed = true;
      if (drafts.current.get(writing.replica) === writing && engine.activeReplica() === writing.replica) setFailure(true);
      captureError('journal', 'journal-save', '', '/journal');
    }).finally(() => { writing.pending = false; });
  }, [engine]);
  const change = useCallback((field, value) => {
    if (!engine || !session.ready) return;
    const previous = drafts.current.get(records.replica);
    const retained = engine.device.activeReplica.deviceRows('journal')[EditorDraft.key];
    const destination = pagesOf(engine).find((page) => page.day === today) ?? held;
    const current = previous && !previous.saved && !previous.recovered ? previous.doc
      : retained && retained.day !== today ? { day: retained.day, ...retained.document } : destination;
    const carriedFrom = current.day !== today ? current.day : previous?.carriedFrom;
    const priorDraft = current.day !== today && retained?.day === current.day ? retained
      : retained?.day === today ? null : previous?.priorDraft ?? null;
    const doc = { day: today, body: current.body, mood: current.mood, energy: current.energy,
      source: current.source,
      ...(current.day !== today ? { body: JournalWriting.claimBody(destination.body, current.body) } : {}), [field]: value };
    persist({ key, replica: records.replica, doc, saved: false, carriedFrom, priorDraft }, previous);
  }, [engine, session.ready, key, today, held.body, held.mood, held.energy, held.source, records.replica, persist]);
  useEffect(() => {
    if (!engine || !session.ready) return;
    let writing = drafts.current.get(records.replica);
    const retained = engine.device.activeReplica.deviceRows('journal')[EditorDraft.key];
    if (writing?.recovered && writing.recovered !== retained) {
      drafts.current.delete(records.replica);
      writing = null;
    }
    if (!writing && retained) {
      const saved = EditorDraft.fromJSON(retained);
      writing = { key: `${records.replica}:${saved.day.text}`, replica: records.replica,
        doc: { day: saved.day.text, ...saved.document.fields() }, saved: false, failed: true, recovered: retained };
      drafts.current.set(records.replica, writing);
    }
    if (writing && !writing.pending && writing.doc.day !== today) {
      const destination = pagesOf(engine).find((page) => page.day === today) ?? { body: '' };
      const doc = { ...writing.doc, day: today, body: JournalWriting.claimBody(destination.body, writing.doc.body) };
      persist({ key, replica: records.replica, doc, saved: false, carriedFrom: writing.doc.day,
        priorDraft: retained?.day === writing.doc.day ? retained : null }, writing);
      return;
    }
    if (editor !== (writing ?? null)) {
      setEditor(writing ?? null);
      setFailure(Boolean(writing?.failed));
    }
  }, [engine, session.ready, records, today, key, editor, failure, saveTick, persist]);
  const hasPending = engine?.device.activeReplica.entries(SCOPE).length > 0
    || Object.keys(engine?.device.activeReplica.deviceRows('journal') ?? {}).some((key) => key.startsWith('pendingClaim:'));
  const room = engine && session.ready ? journalRoom(engine, records) : null;
  const retainedDraft = engine?.device.activeReplica.deviceRows('journal')[EditorDraft.key];
  const retireScales = () => {
    if (engine && session.ready) retireInvitation(engine, 'scales', records.replica)
      .catch(() => captureError('journal', 'journal-invitation', '', '/journal'));
  };
  const readState = !session.ready ? 'loading' : engine.device.activeReplica.meta.state === 'anon' ? 'device'
    : records.firstPullComplete ? 'ready' : 'failed';
  const saveState = records.notices.some((notice) => !notice.dismissed) ? 'refused' : failure || retainedDraft ? 'unsaved' : !session.online ? 'offline'
    : engine?.device.activeReplica.meta.state === 'anon' || hasPending ? 'device' : 'saved';
  return { today, history: pages.filter((page) => page.day < today && isWritten(page)), recoveries: recoveredDrafts(engine),
    loading: !session.ready, readState,
    firstRun: room?.firstRunKnown && !pages.some(isWritten) && room.state.placeholder !== 'retired',
    scalesInvitation: room?.scaleInvitationDue ?? false, retireScales,
    body: shown.body, mood: shown.mood, energy: shown.energy, saveState, saveTick,
    setBody: (value) => change('body', value), setMood: (value) => change('mood', value), setEnergy: (value) => change('energy', value),
  };
}
