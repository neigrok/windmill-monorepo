import { syncSession } from '../../platform/sync/session.js';
import { compareDocumentStamps, nextDocumentStamp } from '../../platform/sync/core/content.js';
import { commit } from '../../platform/sync/client/commit.js';
import { drawn } from '../../platform/sync/client/views.js';
import { queueClaim, editPendingClaim, pendingClaimKey, reconcilePendingClaim } from '../../platform/sync/journal/client.js';
import { captureError } from '../../telemetry/sentry.js';
import { track } from '../../telemetry/beacon.js';

export const SCOPE = 'self/journal';
const fields = ['body', 'mood', 'energy', 'source'];
export const isWritten = (page) => Boolean(page.body) || page.mood != null || page.energy != null;
export function normalizePage(raw) {
  const score = (value) => Number.isInteger(value) && value >= 0 && value <= 10 ? value : null;
  return { day: String(raw?.day ?? ''), body: typeof raw?.body === 'string' ? raw.body : '',
    mood: score(raw?.mood), energy: score(raw?.energy), source: raw?.source === 'spoken' ? 'spoken' : 'typed', stamp: raw?.stamp ?? '' };
}
export function pagesOf(engine, snapshot = engine.observe(SCOPE).getSnapshot()) {
  const pages = new Map(snapshot.drawn.filter((row) => row.t === 'page').map((row) => [row.id, {
    day: row.id, body: typeof row.x?.body === 'string' ? row.x.body : row.x?.body?.text ?? '', mood: row.f.mood?.[0] ?? null,
    energy: row.f.energy?.[0] ?? null, source: row.f.source?.[0] ?? 'typed',
    updatedAt: engine.device.activeReplica.confirmedRow(SCOPE, 'page', row.id)?.ru
      ? new Date(engine.device.activeReplica.confirmedRow(SCOPE, 'page', row.id).ru).toISOString() : undefined,
  }]));
  for (const [key, pending] of Object.entries(engine.device.activeReplica.deviceRows('journal'))) {
    if (key.startsWith('pendingClaim:') && pending) pages.set(pending.day, { day: pending.day, ...pending.latest });
  }
  // Refused commands leave the outbox, but their full document remains durable in the notice.
  const replica = engine.device.activeReplica;
  for (const notice of snapshot.notices) {
    const cmd = notice.content.cmd;
    if (notice.dismissed || !['journal.savePage', 'journal.claimPage'].includes(cmd?.name)) continue;
    const args = cmd.args;
    if (cmd.name === 'journal.savePage') {
      const newer = [replica.confirmedRow(SCOPE, 'page', args.day)?.f.documentStamp?.[0],
        ...replica.entries(SCOPE).filter((entry) => entry.intent.cmd?.name === 'journal.savePage' && entry.intent.cmd.args.day === args.day)
          .map((entry) => entry.intent.cmd.args.stamp)].filter(Boolean);
      if (newer.some((stamp) => compareDocumentStamps(stamp, args.stamp) >= 0)) continue;
    }
    const pending = args.claimId && replica.deviceRows('journal')[pendingClaimKey(args.claimId)];
    pages.set(args.day, { ...normalizePage(args), ...(pending ? pending.latest : {}) });
  }
  return [...pages.values()].sort((a, b) => a.day.localeCompare(b.day));
}
export function claimGesture(doc, claimId = crypto.randomUUID()) {
  const args = { ...doc, claimId };
  const document = Object.fromEntries(fields.map((field) => [field, doc[field]]));
  return { changes: [], opts: { cmd: { name: 'journal.claimPage', args },
    predict: [{ op: 'write', t: 'page', id: doc.day, f: { mood: doc.mood, energy: doc.energy, source: doc.source }, x: { body: doc.body } }],
    local: { [pendingClaimKey(claimId)]: { day: doc.day, claimId, base: document, latest: structuredClone(document),
      touched: [], retirements: {}, claimResult: null, refusal: null } } } };
}

export async function savePage(engine, doc, expectedReplica = engine.activeReplica(), retirements = {}) {
  const result = await engine.write('sync-commit', (device, ctx) => {
    const replica = device.activeReplica;
    if (replica.id !== expectedReplica) throw new Error('journal-replica-changed');
    const pending = Object.values(replica.deviceRows('journal')).find((row) => row?.claimId && row.day === doc.day);
    const changes = [{ op: 'write', t: 'journalState', id: 'journalState',
      f: { placeholder: 'retired', ...(isWritten(doc) ? { privacyLine: 'retired', firstPage: 'retired' } : {}),
        ...(doc.mood != null || doc.energy != null ? { scales: 'retired' } : {}), ...retirements } }];
    let outcome;
    if (replica.meta.state === 'anon') {
      const supersede = replica.entries(SCOPE).filter((entry) => entry.intent.cmd?.args.day === doc.day).map((entry) => entry.gestureId);
      outcome = queueClaim(replica, ctx, { ...doc, claimId: crypto.randomUUID() }, changes, supersede);
    } else if (pending?.refusal) {
      const gesture = claimGesture(doc);
      gesture.opts.local[pendingClaimKey(gesture.opts.cmd.args.claimId)].retirements = { ...pending.retirements, ...changes[0].f };
      gesture.opts.local[pendingClaimKey(pending.claimId)] = null;
      outcome = commit(replica, ctx, SCOPE, changes, gesture.opts);
    } else if (pending) {
      const edits = Object.fromEntries(fields.filter((field) => doc[field] !== pending.latest[field]).map((field) => [field, doc[field]]));
      outcome = editPendingClaim(replica, ctx, pending.claimId, edits, changes[0].f);
    } else if (!replica.cursorOf(SCOPE).booted && !replica.confirmedRow(SCOPE, 'page', doc.day)) {
      // A day not yet read is a contribution, never a replacement of unseen account prose.
      const gesture = claimGesture(doc);
      gesture.opts.local[pendingClaimKey(gesture.opts.cmd.args.claimId)].retirements = changes[0].f;
      outcome = commit(replica, ctx, SCOPE, changes, gesture.opts);
    } else {
      const observed = drawn(replica, engine.registry, SCOPE).get(JSON.stringify(['page', doc.day]))?.f.documentStamp?.[0];
      const stamp = nextDocumentStamp({ pair: replica.deviceRows('journal').contentClock, observed,
        now: ctx.deviceNow + replica.meta.serverOffsetMs, actor: ctx.actor });
      outcome = commit(replica, ctx, SCOPE, changes, { cmd: { name: 'journal.savePage', args: { ...doc, stamp } },
        predict: [{ op: 'write', t: 'page', id: doc.day, f: { mood: doc.mood, energy: doc.energy, source: doc.source }, x: { body: doc.body } }],
        local: { contentClock: { ms: stamp.ms, counter: stamp.counter } } });
    }
    if (!outcome?.refused) {
      for (const notice of replica.notices) if (notice.scope === SCOPE && notice.content.cmd?.args.day === doc.day) notice.dismissed = true;
    }
    return outcome;
  }, [SCOPE]);
  if (result?.refused) throw new Error('journal-local-refusal');
  engine.kick();
  return result;
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
        await engine.write(null, (device, ctx) => {
          if (device.activeReplica.meta.state !== 'bound') return;
          for (const row of pending) reconcilePendingClaim(device.activeReplica, ctx, row.claimId);
        }, [SCOPE]);
        engine.kick();
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
      const { stamp, ...doc } = page;
      const gesture = claimGesture(doc);
      const result = commit(replica, ctx, SCOPE, gesture.changes, gesture.opts);
      if (result.refused) throw new Error('journal-restore-refused');
    }
    delete device.meta.journalUnclaimed;
  }, [SCOPE]);
  engine.kick();
  return pages.length;
}
