import { Replica } from '../../../../packages/api-contract/sync/reference/client/replica.js';
import { commit } from '../../../../packages/api-contract/sync/reference/client/commit.js';
import { hashText } from '../../platform/sync/core/encoding.js';
import { compareDocumentStamps, isCalendarDay, isDocumentStamp } from '../../platform/sync/core/content.js';
import { claimGesture, isWritten, normalizePage, retainRecoveredPage, SCOPE } from './pages.js';
import { EditorDraft, SavePageCommand } from './domain/writing.js';
import { Violation } from '../../platform/domain-kit/values.js';
import { captureError } from '../../telemetry/sentry.js';
import { track } from '../../telemetry/beacon.js';

export function documentStamp(text) {
  const [ms, counter, ...actor] = String(text || '0:0:').split(':');
  const stamp = { ms: Number(ms), counter: Number(counter), actor: actor.join(':') };
  if (!isDocumentStamp(stamp)) throw new Error('journal-legacy-stamp');
  return stamp;
}

export async function migratePages(engine, storage) {
  let complete = true;
  try {
    storage ??= globalThis.localStorage;
    const sources = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!/^wm\.journal\.(v2\.pages|pages)(\.(anon|unclaimed|u\..+))?$/.test(key)) continue;
      const raw = storage.getItem(key);
      let data;
      try {
        data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('journal-legacy-format');
      } catch { complete = false; continue; }
      sources.push({ key, raw, hash: hashText(raw), data, v1: !key.startsWith('wm.journal.v2.'),
        account: key.includes('.u.') ? key.split('.u.')[1] : null,
        quarantine: key.endsWith('.unclaimed') || key === 'wm.journal.pages' });
    }
    if (!sources.length) {
      if (!complete) captureError('journal', 'journal-migration', '', '/journal');
      return { complete };
    }
    await engine.write(null, (device, ctx) => {
      const markers = device.meta.journalMigration ??= {};
      const receipts = device.meta.journalMigrationEntries ??= {};
      const groups = new Map();
      for (const source of sources) {
        const seat = source.quarantine ? 'quarantine' : source.account ?? 'anon';
        if (!groups.has(seat)) groups.set(seat, new Map());
        const pages = groups.get(seat);
        for (const [day, entry] of Object.entries(source.data)) {
          try {
            if (!isCalendarDay(day) || !entry?.page) throw new Error('journal-legacy-page');
            const page = { ...normalizePage(entry.page), day };
            if (source.v1) {
              page.mood = page.mood >= 1 && page.mood <= 5 ? page.mood * 2 - 1 : null;
              page.energy = ({ 1: 2, 2: 5, 3: 8 })[page.energy] ?? null;
            }
            const stamp = documentStamp(page.stamp);
            const receipt = hashText(JSON.stringify([seat, page]));
            if (markers[source.key] === source.hash) receipts[receipt] ??= true;
            if (receipts[receipt]) continue;
            const held = pages.get(day);
            const unread = Boolean(entry.needsPush) && !entry.read;
            const heldUnread = Boolean(held?.entry.needsPush) && !held?.entry.read;
            const preferred = !held || Boolean(entry.needsPush) !== Boolean(held.entry.needsPush)
              ? !held || Boolean(entry.needsPush)
              : unread !== heldUnread ? unread : compareDocumentStamps(stamp, held.stamp) >= 0;
            const winner = preferred ? { page, stamp, entry } : held;
            const loser = held && (preferred ? held.page : page);
            pages.set(day, { ...winner, owed: Boolean(entry.needsPush) || Boolean(held?.owed),
              alternatives: [...(held?.alternatives ?? []), ...(loser ? [loser] : [])],
              receipts: [...(held?.receipts ?? []), receipt] });
          } catch { source.failed = true; complete = false; }
        }
      }
      for (const [seat, pages] of groups) {
        if (!pages.size) continue;
        const anon = device.anonReplica() ?? device.add(Replica.fresh({ replica: ctx.newReplicaId(), state: 'anon' }));
        if (seat === 'quarantine') {
          const held = device.meta.journalUnclaimed ?? [];
          const imported = [...pages.values()].flatMap(({ page, alternatives }) => [page,
            ...alternatives.filter((other) => !new EditorDraft({ day: page.day, document: page }).document.equals(new EditorDraft({ day: other.day, document: other }).document))
              .map((other) => ({ ...other, recovered: true }))]);
          device.meta.journalUnclaimed = [...new Map([...held, ...imported].map((page) =>
            [new EditorDraft({ day: page.day, document: page }).recoveryKey, page])).values()];
          for (const pending of pages.values()) for (const receipt of pending.receipts) receipts[receipt] = true;
          continue;
        }
        const replica = seat === 'anon' ? anon : device.replicas.find((r) => r.meta.account === seat)
          ?? device.add(Replica.fresh({ replica: ctx.newReplicaId(), state: 'dormant', account: seat }));
        // Existing writers do not repeat first run. Retirements travel with any owed page command.
        const retired = [...pages.values()].some(({ page }) => isWritten(page))
          ? { placeholder: 'retired', privacyLine: 'retired', firstPage: 'retired', scales: 'retired' } : {};
        if (Object.keys(retired).length && !replica.confirmedRow(SCOPE, 'journalState', 'journalState')) {
          replica.putConfirmed(SCOPE, { t: 'journalState', id: 'journalState', seq: 0, rc: 0, ru: 0,
            f: Object.fromEntries(Object.entries(retired).map(([name, value]) => [name, [value, '0:0:']])) });
        }
        for (const [day, { page, stamp, entry, owed, alternatives, receipts: received }] of pages) {
          const { stamp: _legacy, ...doc } = page;
          const draft = new EditorDraft({ day, document: doc });
          const rows = replica.deviceRows('journal');
          for (const other of alternatives) {
            const earlier = new EditorDraft({ day: other.day, document: other });
            if (!draft.document.equals(earlier.document)) EditorDraft.retain(rows, earlier);
          }
          const occupied = replica.confirmedRow(SCOPE, 'page', day)
            || replica.entries(SCOPE).some((entry) => entry.intent.cmd?.args.day === day)
            || Object.values(rows).some((row) => row?.day === day && row?.claimId)
            || rows[EditorDraft.key]?.day === day;
          if (occupied) {
            EditorDraft.retain(rows, draft);
            for (const receipt of received) receipts[receipt] = true;
            continue;
          }
          // Cache imports never manufacture an owed write. A fresh pull replaces their temporary view.
          if (!owed || seat !== 'anon' && entry.read) replica.putConfirmed(SCOPE, { t: 'page', id: day, seq: 0, rc: 0, ru: 0,
            f: Object.fromEntries(['mood', 'energy', 'source'].map((name) => [name, [doc[name], '0:0:']]).concat([['documentStamp', [stamp, '0:0:']]])),
            x: { body: { text: doc.body, rev: null, base: null } } });
          if (!owed && seat !== 'anon') {
            for (const receipt of received) receipts[receipt] = true;
            continue;
          }
          // Dormant accounts are populated in the same transaction without ever becoming active.
          const state = replica.meta.state;
          if (state === 'dormant') replica.meta.state = 'bound';
          let gesture;
          try {
            if (seat === 'anon' || !entry.read) gesture = claimGesture(doc);
            else {
              const command = new SavePageCommand({ ...doc, stamp });
              gesture = { changes: [], opts: { cmd: { name: command.name, args: command.args },
                predict: [{ op: 'write', t: 'page', id: day, f: { mood: doc.mood, energy: doc.energy, source: doc.source, documentStamp: stamp }, x: { body: doc.body } }] } };
            }
          } catch (error) {
            if (!(error instanceof Violation)) throw error;
            retainRecoveredPage(replica, doc);
            for (const receipt of received) receipts[receipt] = true;
            replica.meta.state = state;
            continue;
          }
          if (Object.keys(retired).length) gesture.changes = [{ op: 'write', t: 'journalState', id: 'journalState', f: retired }];
          const result = commit(replica, ctx, SCOPE, gesture.changes, gesture.opts);
          if (result.refused) retainRecoveredPage(replica, doc);
          for (const receipt of received) receipts[receipt] = gesture.opts.cmd.args.claimId ?? true;
          replica.meta.state = state;
        }
      }
      for (const source of sources) if (!source.failed) markers[source.key] = source.hash;
    }, engine.device.replicas.map((replica) => ({ handle: replica.storageHandle, scope: SCOPE })));
    // A crash here leaves durable markers; retry removes the old bytes without enqueueing them again.
    for (const source of sources) {
      if (source.failed) continue;
      try { if (storage.getItem(source.key) === source.raw) storage.removeItem(source.key); }
      catch { complete = false; }
    }
    if (!complete) captureError('journal', 'journal-migration', '', '/journal');
    track('sync_commit', { outcome: 'ok' });
    return { complete };
  } catch (error) {
    captureError('journal', 'journal-migration', '', '/journal');
    return { complete: false };
  }
}
