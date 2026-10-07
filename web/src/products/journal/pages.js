import { syncSession } from '../../platform/sync/session.js';
import { compareDocumentStamps } from '../../platform/sync/core/content.js';
import { commit } from '../../platform/sync/client/commit.js';
import { registry } from '../../platform/sync/schema.js';
import { recordKey } from '../../platform/sync/core/rows.js';
import { jcs } from '../../platform/sync/core/jcs.js';
import { ActionRunner, EngineReplica } from '../../platform/domain-kit/runner.js';
import { Decision, decision } from '../../platform/domain-kit/actions.js';
import { Violation } from '../../platform/domain-kit/values.js';
import { translate } from '../../platform/domain-kit/translation.js';
import { JournalRoom, PageDocument } from './domain/page.js';
import { EditorDraft, JournalWriting, PreserveEditorDraft, ReconcileClaim, RetireJournalInvitation, SavePage } from './domain/writing.js';
import { captureError } from '../../telemetry/sentry.js';
import { track } from '../../telemetry/beacon.js';

export const SCOPE = 'self/journal';
export const isWritten = (page) => new PageDocument(page).isWritten;
export const pendingClaimWork = (product, rows) => JournalWriting.pendingWork(product, rows);
export function adoptDeviceRows(product, incoming, kept) {
  if (product !== 'journal') return undefined;
  const rows = { ...incoming, ...kept };
  const { current, recovered } = EditorDraft.adopt(
    incoming[EditorDraft.key] ? EditorDraft.fromJSON(incoming[EditorDraft.key]) : null,
    kept[EditorDraft.key] ? EditorDraft.fromJSON(kept[EditorDraft.key]) : null);
  if (current) rows[EditorDraft.key] = current.json;
  if (recovered) EditorDraft.retain(rows, recovered);
  return rows;
}
const pendingClaimKey = (claimId) => `pendingClaim:${claimId}`;
const deviceZone = { offsetSeconds: (instant) => -new Date(instant.ms).getTimezoneOffset() * 60 };

function journalRunner(engine, expectedReplica = engine.activeReplica(), snapshot) {
  const port = new EngineReplica(engine);
  return new ActionRunner({
    commit: (scope, body) => port.commit(scope, (views) => {
      if (views.replica !== expectedReplica) throw new Error('journal-replica-changed');
      return body(views);
    }),
    read: (scope) => {
      const views = port.read(scope);
      if (!snapshot) return views;
      const keyed = (rows) => new Map(rows.map((row) => [recordKey(row.t, row.id), row]));
      return { ...views, drawn: keyed(snapshot.drawn), stored: keyed(snapshot.stored ?? snapshot.drawn), firstPullComplete: snapshot.firstPullComplete };
    },
    mintId: (type, taken) => port.mintId(type, taken),
    opaqueID: () => port.opaqueID(),
    physNow: () => port.physNow(),
    undo: (id) => port.undo(id),
    dismissNotice: (id) => port.dismissNotice(id),
  }, engine.registry, deviceZone);
}

export function journalRoom(engine, snapshot = engine.observe(SCOPE).getSnapshot()) {
  return journalRunner(engine, engine.activeReplica(), snapshot).read(SCOPE, (read) => new JournalRoom(read));
}
export function normalizePage(raw) {
  const score = (value) => Number.isInteger(value) && value >= 0 && value <= 10 ? value : null;
  return { day: String(raw?.day ?? ''), body: typeof raw?.body === 'string' ? raw.body : '',
    mood: score(raw?.mood), energy: score(raw?.energy), source: raw?.source === 'spoken' ? 'spoken' : 'typed', stamp: raw?.stamp ?? '' };
}
export function pagesOf(engine, snapshot = engine.observe(SCOPE).getSnapshot()) {
  const pages = new Map(journalRoom(engine, snapshot).pages.map((page) => {
    const day = page.day.text;
    const updated = engine.device.activeReplica.confirmedRow(SCOPE, 'page', day)?.ru;
    return [day, { day, ...page.document.fields(), updatedAt: updated ? new Date(updated).toISOString() : undefined }];
  }));
  // Refused commands leave the outbox, but their full document remains durable in the notice.
  const replica = engine.device.activeReplica;
  for (const notice of snapshot.notices) {
    const cmd = notice.content.cmd;
    if (notice.dismissed || !['journal.savePage', 'journal.claimPage'].includes(cmd?.name)) continue;
    const args = cmd.args;
    if (Object.values(replica.deviceRows('journal')).some((row) => row?.claimId && row.day === args.day)) continue;
    if (cmd.name === 'journal.savePage') {
      const newer = [replica.confirmedRow(SCOPE, 'page', args.day)?.f.documentStamp?.[0],
        ...replica.entries(SCOPE).filter((entry) => entry.intent.cmd?.name === 'journal.savePage' && entry.intent.cmd.args.day === args.day)
          .map((entry) => entry.intent.cmd.args.stamp)].filter(Boolean);
      if (newer.some((stamp) => compareDocumentStamps(stamp, args.stamp) >= 0)) continue;
    }
    const pending = args.claimId && replica.deviceRows('journal')[pendingClaimKey(args.claimId)];
    pages.set(args.day, { ...normalizePage(args), ...(pending ? pending.latest : {}) });
  }
  const draft = replica.deviceRows('journal')[EditorDraft.key];
  if (draft) {
    const retained = EditorDraft.fromJSON(draft);
    pages.set(retained.day.text, { day: retained.day.text, ...retained.document.fields() });
  }
  return [...pages.values()].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
}
export function claimGesture(doc, claimId = crypto.randomUUID()) {
  const plan = JournalWriting.claimPlan({ day: doc.day, document: doc, claimId });
  const { changes, atomic, hold, guards, retire, cmd, predict, local } = translate(plan, SCOPE, registry);
  return { changes, opts: { atomic, hold, guard: guards, retire, cmd, predict,
    local: Object.fromEntries(local.map(({ key, value }) => [key, value])) } };
}

export async function savePage(engine, doc, expectedReplica = engine.activeReplica(), retirements = {}, priorDraft = null) {
  const action = new SavePage({ day: doc.day, document: doc, retiring: Object.keys(retirements) });
  const runner = journalRunner(engine, expectedReplica);
  const notices = new Set(engine.observe(SCOPE).getSnapshot().notices
    .filter((notice) => !notice.dismissed && notice.content.cmd?.args.day === doc.day).map((notice) => notice.id));
  const outcome = await runner.run({
    scope: SCOPE, refusals: action.refusals, load: (read) => {
      const retained = read.device(EditorDraft.key);
      if (priorDraft && jcs(retained) !== jcs(priorDraft)) throw new Error('journal-draft-changed');
      return { state: action.load(read), retained };
    },
    decide: ({ state: loaded, retained }, ids) => {
      const saved = decision(action, loaded, ids);
      if (saved.kind !== 'refuse') {
        if (retained && saved.kind === 'write') {
          const draft = EditorDraft.fromJSON(retained);
          if (draft.day.text !== doc.day || !draft.document.equals(action.document)) saved.plan.device(draft.recoveryKey, draft.json);
        }
        if (priorDraft && saved.kind === 'write' && !loaded.hasEditorDraft) saved.plan.device(EditorDraft.key, null);
        return saved;
      }
      if (retained && retained.day !== doc.day && !priorDraft) return saved;
      const preserved = new PreserveEditorDraft({ day: doc.day, document: doc }).decide(null, ids);
      if (retained && retained.day !== doc.day) {
        const draft = EditorDraft.fromJSON(retained);
        preserved.plan.device(draft.recoveryKey, draft.json);
      }
      return Decision.write(preserved.plan, { refusal: saved.refusal });
    },
  });
  const refusal = outcome.kind === 'refused' ? outcome.refusal : outcome.result?.refusal;
  if (refusal) throw Object.assign(new Error('journal-local-refusal'), { refusal });
  if (notices.size) await engine.write(null, (device) => {
    const replica = device.activeReplica;
    if (replica.id !== expectedReplica) return;
    const refusedClaim = Object.values(replica.deviceRows('journal')).some((row) => row?.day === doc.day && row.refusal);
    if (refusedClaim) return;
    for (const notice of replica.notices) if (notice.scope === SCOPE && notices.has(notice.id)) notice.dismissed = true;
  }, [SCOPE]).catch(() => captureError('journal', 'journal-notice-cleanup', '', '/journal'));
  return outcome;
}

export function retainRecoveredPage(replica, doc) {
  const draft = new EditorDraft({ day: doc.day, document: doc });
  const rows = replica.deviceRows('journal');
  const occupied = rows[EditorDraft.key] || replica.confirmedRow(SCOPE, 'page', doc.day)
    || replica.entries(SCOPE).some((entry) => entry.intent.cmd?.args.day === doc.day);
  if (occupied) EditorDraft.retain(rows, draft);
  else rows[EditorDraft.key] = draft.json;
}

export function recoveredDrafts(engine = syncSession.engine) {
  return Object.entries(engine?.device.activeReplica.deviceRows('journal') ?? {})
    .filter(([key]) => key.startsWith(EditorDraft.recoveryPrefix)).map(([key, value]) => {
      const draft = EditorDraft.fromJSON(value);
      return { key, day: draft.day.text, ...draft.document.fields() };
    }).sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key));
}

export async function retireInvitation(engine, field, expectedReplica = engine.activeReplica()) {
  const outcome = await journalRunner(engine, expectedReplica).run(new RetireJournalInvitation({ field }));
  if (outcome.kind === 'refused') throw Object.assign(new Error('journal-local-refusal'), { refusal: outcome.refusal });
  return outcome;
}

export function onSyncResult(replica, _ctx, result, body) {
  const entry = replica.entries(SCOPE).find((entry) => entry.state === 'sent' && entry.n === result.n);
  if (entry?.intent.cmd?.name === 'journal.savePage' && result.s === 'ok') {
    for (const notice of replica.notices) {
      const cmd = notice.content.cmd;
      if (cmd?.name === 'journal.savePage' && cmd.args.day === entry.intent.cmd.args.day
          && compareDocumentStamps(cmd.args.stamp, entry.intent.cmd.args.stamp) <= 0) notice.dismissed = true;
    }
  }
  if (entry?.intent.cmd?.name !== 'journal.claimPage') return;
  const pending = replica.deviceRows('journal')[pendingClaimKey(entry.intent.cmd.args.claimId)];
  if (!pending) return;
  if (result.s === 'ok') pending.claimResult = { seq: result.seq, epoch: body.epoch };
  if (result.s === 'refused' && !['clock-skew', 'base-unknown'].includes(result.code)) pending.refusal = result.code;
}

export function watchClaims(engine) {
  let running = false;
  let dirty = false;
  const reconcile = async () => {
    dirty = true;
    if (running || engine.closed) return;
    running = true;
    try {
      while (dirty && !engine.closed) {
        dirty = false;
        if (engine.device.activeReplica.meta.state !== 'bound') continue;
        const pending = Object.values(engine.device.activeReplica.deviceRows('journal')).filter((row) => row?.claimResult && !row.refusal);
        if (!pending.length) continue;
        const runner = journalRunner(engine);
        for (const row of pending) {
          const result = await runner.run(new ReconcileClaim({ day: row.day, claimId: row.claimId }));
          if (result.kind === 'refused') track('sync_commit', { outcome: 'failed' });
        }
      }
    } catch { captureError('journal', 'journal-claim-reconcile', '', '/journal'); }
    finally { running = false; }
  };
  engine.observe(SCOPE).subscribe(reconcile);
  reconcile();
}

export function corpus({ account = null } = {}) {
  const { engine } = syncSession;
  if (!engine || !syncSession.snapshot.ready) return { pages: [], source: 'failed' };
  const meta = engine.device.activeReplica.meta;
  if ((account ?? null) !== (meta.state === 'bound' ? meta.account : null)) return { pages: [], source: 'failed' };
  const snapshot = engine.observe(SCOPE).getSnapshot();
  return { pages: pagesOf(engine, snapshot).filter(isWritten), source: meta.state === 'anon' ? 'device' : snapshot.firstPullComplete ? 'account' : 'failed' };
}
export function unclaimedPages(engine = syncSession.engine) {
  return engine?.device.meta.journalUnclaimed ?? [];
}
export async function dropUnclaimedPages(engine = syncSession.engine) {
  await engine.write(null, (device) => { delete device.meta.journalUnclaimed; });
  track('sync_commit', { outcome: 'ok' });
}
export async function restoreUnclaimedPages(account, engine = syncSession.engine) {
  const pages = unclaimedPages(engine);
  await engine.write('sync-commit', (device, ctx) => {
    const replica = device.activeReplica;
    if (replica.meta.state !== 'bound' || replica.meta.account !== account) throw new Error('journal-account-changed');
    if (JSON.stringify(device.meta.journalUnclaimed ?? []) !== JSON.stringify(pages)) throw new Error('journal-unclaimed-changed');
    for (const page of pages) {
      const { stamp, recovered, ...doc } = page;
      if (recovered) {
        EditorDraft.retain(replica.deviceRows('journal'), new EditorDraft({ day: doc.day, document: doc }));
        continue;
      }
      let gesture;
      try { gesture = claimGesture(doc); }
      catch (error) {
        if (!(error instanceof Violation)) throw error;
        retainRecoveredPage(replica, doc);
        continue;
      }
      const result = commit(replica, ctx, SCOPE, gesture.changes, gesture.opts);
      if (result.refused) throw new Error('journal-restore-refused');
    }
    delete device.meta.journalUnclaimed;
  }, [SCOPE]);
  engine.kick();
  return pages.length;
}
