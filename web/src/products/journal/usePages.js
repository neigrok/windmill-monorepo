import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ReplicaChanged } from '../../platform/sync/engine.js';
import { useSyncRecords, useSyncReplica } from '../../platform/sync/react.js';
import { syncSession } from '../../platform/sync/session.js';
import { captureError } from '../../telemetry/sentry.js';
import { track } from '../../telemetry/beacon.js';
import { localDay, watchLocalDay } from './localDay.js';
import { isWritten, journalRoom, pagesOf, recoveredDrafts, retireInvitation, savePage, SCOPE } from './pages.js';
import { EditorDraft, JournalWriting } from './domain/writing.js';

export function useToday() {
  const [today, setToday] = useState(localDay);
  useEffect(() => watchLocalDay(setToday), []);
  return today;
}

// The journal draws the replica this tab draws (`useSyncReplica`): nothing of another seat's while the shell catches up.
// What is typed belongs to the seat it was typed under, its binding, which a re-identify keeps: a save that comes due after
// a sign-in or a sign-out moved the seat is refused (`ReplicaChanged`), told as the engine tells it, and lands in no other.
// Its words stay on the screen, unsaved, until the person changes them under the seat that stands.
export function usePages() {
  const session = useSyncExternalStore(syncSession.subscribe, syncSession.getSnapshot, syncSession.getSnapshot);
  const replica = useSyncReplica();
  const records = useSyncRecords(SCOPE);
  const today = useToday();
  const [editor, setEditor] = useState(null);
  const [failure, setFailure] = useState(false);
  const [saveTick, setSaveTick] = useState(0);
  const drafts = useRef(new Map());
  const staged = useRef(null);
  const binding = replica?.binding ?? null;
  const engine = replica?.engine ?? null;
  const pages = engine ? pagesOf(engine, records) : [];
  const held = pages.find((page) => page.day === today) ?? { day: today, body: '', mood: null, energy: null };
  const shown = editor?.binding === binding && !editor.saved && !editor.recovered ? editor.doc : held;
  const show = useCallback((writing) => {
    clearTimeout(staged.current?.timer);
    drafts.current.set(writing.binding, writing);
    setEditor(writing); setFailure(false);
  }, []);
  const persist = useCallback((writing, previous = null) => {
    show(writing);
    staged.current = null;
    const save = () => {
      if (engine.activeBinding() !== writing.binding) {
        track('sync_commit', { outcome: 'not-writable' });
        throw new ReplicaChanged();
      }
      const retained = engine.readDeviceRows('journal')[EditorDraft.key];
      let priorDraft = writing.priorDraft ?? null;
      if (priorDraft && previous?.saved && !retained) priorDraft = null;
      const previousDocument = previous && { body: previous.doc.body, mood: previous.doc.mood, energy: previous.doc.energy, source: previous.doc.source };
      const matchesPrevious = previousDocument && Object.entries(previousDocument).every(([field, value]) => retained?.document[field] === value);
      if (priorDraft && retained?.day === writing.doc.day && matchesPrevious) priorDraft = null;
      if (!priorDraft && retained && writing.carriedFrom && retained.day === writing.carriedFrom) {
        if (!matchesPrevious) throw new Error('journal-draft-changed');
        priorDraft = retained;
      }
      return savePage(engine, writing.doc, writing.binding, {}, priorDraft);
    };
    writing.pending = true;
    writing.saving = (previous?.pending ? previous.saving.then(save) : Promise.resolve().then(save)).then(() => {
      writing.saved = true;
      if (drafts.current.get(writing.binding) === writing) {
        drafts.current.delete(writing.binding);
        if (engine.activeBinding() === writing.binding) { setEditor(null); setFailure(false); }
      }
      setSaveTick((tick) => tick + 1);
    }).catch((error) => {
      writing.failed = true;
      if (!(error instanceof ReplicaChanged)) {
        if (drafts.current.get(writing.binding) === writing && engine.activeBinding() === writing.binding) setFailure(true);
        captureError('journal', 'journal-save', error?.stack ?? '', '/journal');
        return;
      }
      // Words a seat change refused stay on the screen under the seat that now stands, unsaved (spec §7): nothing saves them
      // there but the person's next change, so words typed under one seat reach another only by their hand. A writing the
      // standing seat already holds is its own, and stays.
      if (drafts.current.get(writing.binding) !== writing) return;
      drafts.current.delete(writing.binding);
      const standing = engine.activeBinding();
      if (drafts.current.has(standing)) return;
      const kept = { binding: standing, doc: writing.doc, saved: false, failed: true, typedUnder: writing.binding };
      drafts.current.set(standing, kept);
      setEditor(kept); setFailure(true);
    }).finally(() => { writing.pending = false; });
  }, [engine, show]);
  // A staged writing shows at once and reaches the engine 600 ms after the last keystroke, or on the next flush.
  const flush = useCallback(() => {
    if (staged.current) persist(staged.current.writing, staged.current.previous);
  }, [persist]);
  // A writing staged under a seat that no longer stands goes to the engine at once, which refuses it, so its words come
  // back on the screen without the 600 ms of the seat's own page between.
  useEffect(() => {
    if (engine && staged.current && staged.current.writing.binding !== binding) flush();
  }, [engine, binding, flush]);
  const stage = useCallback((writing, previous) => {
    show(writing);
    staged.current = { writing, previous, timer: setTimeout(flush, 600) };
  }, [show, flush]);
  // The last writing the engine was given: a staged one was never sent, so the one it is staged behind.
  const sentBefore = useCallback((writing) => (writing && staged.current?.writing === writing ? staged.current.previous : writing), []);
  const change = useCallback((field, value) => {
    if (!engine) return;
    const previous = drafts.current.get(binding);
    const retained = engine.readDeviceRows('journal')[EditorDraft.key];
    const destination = pagesOf(engine).find((page) => page.day === today) ?? held;
    const current = previous && !previous.saved && !previous.recovered ? previous.doc
      : retained && retained.day !== today ? { day: retained.day, ...retained.document } : destination;
    const carriedFrom = current.day !== today ? current.day : previous?.carriedFrom;
    const priorDraft = current.day !== today && retained?.day === current.day ? retained
      : retained?.day === today ? null : previous?.priorDraft ?? null;
    const doc = { day: today, body: current.body, mood: current.mood, energy: current.energy, source: 'typed',
      ...(current.day !== today ? { body: JournalWriting.claimBody(destination.body, current.body) } : {}), [field]: value };
    const writing = { binding, doc, saved: false, carriedFrom, priorDraft };
    if (field === 'body') stage(writing, sentBefore(previous));
    else persist(writing, sentBefore(previous));
  }, [engine, binding, today, held.body, held.mood, held.energy, stage, persist, sentBefore]);
  useEffect(() => {
    if (!engine) return;
    let writing = drafts.current.get(binding);
    const retained = engine.readDeviceRows('journal')[EditorDraft.key];
    if (writing?.recovered && writing.recovered !== retained) {
      drafts.current.delete(binding);
      writing = null;
    }
    if (!writing && retained) {
      const saved = EditorDraft.fromJSON(retained);
      writing = { binding, doc: { day: saved.day.text, ...saved.document.fields() }, saved: false, failed: true, recovered: retained };
      drafts.current.set(binding, writing);
    }
    if (writing && !writing.pending && !writing.typedUnder && writing.doc.day !== today) {
      const destination = pagesOf(engine).find((page) => page.day === today) ?? { body: '' };
      const doc = { ...writing.doc, day: today, body: JournalWriting.claimBody(destination.body, writing.doc.body) };
      persist({ binding, doc, saved: false, carriedFrom: writing.doc.day,
        priorDraft: retained?.day === writing.doc.day ? retained : null }, sentBefore(writing));
      return;
    }
    if (editor !== (writing ?? null)) {
      setEditor(writing ?? null);
      setFailure(Boolean(writing?.failed));
    }
  }, [engine, binding, records, today, editor, failure, saveTick, persist, sentBefore]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      flush();
    };
  }, [flush]);
  const hasPending = engine?.device.activeReplica.entries(SCOPE).length > 0
    || Object.keys(engine?.readDeviceRows('journal') ?? {}).some((key) => key.startsWith('pendingClaim:'));
  const room = engine ? journalRoom(engine, records) : null;
  const retainedDraft = engine?.readDeviceRows('journal')[EditorDraft.key];
  const retireScales = () => {
    if (engine) retireInvitation(engine, 'scales', binding)
      .catch((error) => { if (!(error instanceof ReplicaChanged)) captureError('journal', 'journal-invitation', error?.stack ?? '', '/journal'); });
  };
  const readState = !engine ? 'loading' : engine.device.activeReplica.meta.state === 'anon' ? 'device'
    : records.firstPullComplete ? 'ready' : 'failed';
  const saveState = records.notices.some((notice) => !notice.dismissed) ? 'refused' : failure || retainedDraft ? 'unsaved' : !session.online ? 'offline'
    : engine?.device.activeReplica.meta.state === 'anon' || hasPending ? 'device' : 'saved';
  return { today, history: pages.filter((page) => page.day < today && isWritten(page)), recoveries: recoveredDrafts(engine),
    loading: !engine, readState,
    firstRun: room?.firstRunKnown && !pages.some(isWritten) && room.state.placeholder !== 'retired',
    scalesInvitation: room?.scaleInvitationDue ?? false, retireScales,
    body: shown.body, mood: shown.mood, energy: shown.energy, saveState, saveTick,
    setBody: (value) => change('body', value), setMood: (value) => change('mood', value), setEnergy: (value) => change('energy', value),
  };
}
