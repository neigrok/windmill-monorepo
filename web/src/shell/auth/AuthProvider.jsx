import React, { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { API_BASE } from '../apiBase.js';
import { fetchMe, logout } from './AuthClient.js';
import { closeAccount as requestAccountClosure, listSessions } from './AccountClient.js';
import { DeviceSeat, DocumentDataScope, ProductQuestions } from './accountChange.js';
import { requestNavigation } from '../navigation.js';
import { PRODUCTS } from '../products.js';
import { syncSession } from '../../platform/sync/session.js';
import { captureError } from '../../telemetry/sentry.js';
import { track } from '../../telemetry/beacon.js';
import { SyncDecisions } from './SyncDecisions.jsx';
import { useRoomStatus } from '../roomStatus.js';
import { t } from '../i18n/entry/index.js';

const AuthContext = createContext(null);
const HINT_KEY = 'windmill:auth-hint';
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within an AuthProvider');
  return value;
}
function hint() {
  try { return JSON.parse(localStorage.getItem(HINT_KEY) || 'null')?.user ?? null; } catch { return null; }
}
function remember(user) {
  try { localStorage.setItem(HINT_KEY, JSON.stringify(user ? { status: 'signed-in', user } : { status: 'ghost' })); }
  catch { captureError('auth', 'auth-hint-storage', '', '/auth'); }
}
const syncOf = (id) => PRODUCTS.find((product) => product.id === id)?.sync;
// The sign-in decisions still due: those the answers leave open, and those answered for work that changed since, which
// the engine asks again (an answer that pins no work is given to the question as it stands).
function unanswered(result, answers) {
  return (result.due ?? []).filter((question) => {
    const pinned = answers.counted?.[question.product];
    return !answers.decisions?.[question.product] || (pinned !== undefined && JSON.stringify(pinned) !== JSON.stringify(question.counted));
  });
}

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(hint);
  const [status, setStatus] = useState('loading');
  const [account, setAccount] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [lapsed, setLapsed] = useState(false);
  const [question, setQuestion] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState(false);
  const [deviceLineHolders, setDeviceLineHolders] = useState(0);
  const roomStatus = useRoomStatus();
  const session = useSyncExternalStore(syncSession.subscribe, syncSession.getSnapshot, syncSession.getSnapshot);
  const observeEngine = useCallback((listener) => session.engine?.observeEngine(listener) ?? (() => {}), [session.engine]);
  const upgradeRequired = useSyncExternalStore(observeEngine, () => session.engine?.getSnapshot().upgradeRequired ?? false, () => false);
  // A newer bundle's upgrade closed this tab's store: what is typed now stays on the screen alone.
  const superseded = useSyncExternalStore(observeEngine, () => session.engine?.getSnapshot().superseded ?? false, () => false);
  const [seat] = useState(() => new DeviceSeat(PRODUCTS,
    (error) => captureError('auth', 'auth-credential-held', error?.stack ?? '', '/auth')));
  const [productQuestions] = useState(() => new ProductQuestions(PRODUCTS,
    (question, error) => captureError('auth', 'auth-product-words', error?.stack ?? '', '/auth', { question })));
  const [dataScope] = useState(() => new DocumentDataScope({
    invalidate: () => {
      for (const product of PRODUCTS) {
        try { product.session?.invalidateAccount?.(); }
        catch { captureError('auth', 'auth-document-data-invalidate', '', '/auth'); }
      }
    },
    report: () => captureError('auth', 'auth-document-data-invalidate', '', '/auth'),
  }));
  // Earlier queued binds cannot release a newer confirmed account's room.
  const roomOwnership = useRef({ revision: 0, confirmed: null, target: null,
    blocked: Boolean(syncSession.engine?.device.meta.deviceCleanup) });
  const [roomChanging, setRoomChanging] = useState(roomOwnership.current.blocked);
  const confirmRoom = useCallback((me) => {
    if (!me) return roomOwnership.current.revision;
    const previous = roomOwnership.current.confirmed;
    const owner = dataScope.read.getSnapshot().owner;
    if (owner && !dataScope.sameOwner(owner, { kind: 'account', id: me.id }))
      roomOwnership.current.scopeTicket = dataScope.begin({ kind: 'account', id: me.id });
    if (previous !== me.id) roomOwnership.current.revision += 1;
    roomOwnership.current.confirmed = me.id;
    const engine = syncSession.engine;
    const active = engine?.device.activeReplica.meta;
    const holders = [engine?.device.meta.deviceCleanup?.previous,
      active?.state === 'bound' ? active.account : null, seat.previousAccount, previous];
    if (!roomOwnership.current.blocked && engine && !holders.some((holder) => holder && holder !== me.id)) return roomOwnership.current.revision;
    roomOwnership.current.target = me.id;
    roomOwnership.current.blocked = true;
    // Remove the previous room in this turn, before queued writes or cleanup can yield.
    flushSync(() => setRoomChanging(true));
    return roomOwnership.current.revision;
  }, [seat, dataScope]);
  const channel = useRef(null);
  const pending = useRef(null);
  const signOutResult = useRef(null);
  const signOutRequest = useRef(null);
  const queue = useRef(Promise.resolve());
  const enqueue = useCallback((run) => {
    const next = queue.current.then(run);
    queue.current = next.catch((error) => {
      captureError('auth', 'auth-session', error?.stack ?? new Error('auth-session').stack, '/auth');
      setError(true);
    });
    return next;
  }, []);
  const settle = useCallback((me, options, revision = roomOwnership.current.revision) => {
    const value = seat.receive(me, options);
    if (!value) return;
    setUser(value.user); setStatus(value.status); setAccount(value.account);
    // The server has answered for this account since the page loaded; a start with no connection stands on the cached hint until it does.
    setConfirmed(Boolean(value.account) && roomOwnership.current.confirmed === value.account.id);
    setLapsed(seat.lapsed);
    if (revision === roomOwnership.current.revision && !syncSession.engine?.device.meta.deviceCleanup
      && (!roomOwnership.current.target || roomOwnership.current.target === value.account?.id)) {
      roomOwnership.current.blocked = false;
      roomOwnership.current.target = null;
      setRoomChanging(false);
    }
    if (revision === roomOwnership.current.revision)
      dataScope.reconcile(syncSession.engine, roomOwnership.current.scopeTicket ?? dataScope.ticket);
    syncSession.publish({ signedIn: Boolean(value.account) });
    if (value.confirmed) remember(value.user);
  }, [seat, dataScope]);
  const signedOut = useCallback(() => {
    pending.current = null; setQuestion(null); setError(false); settle(null, { signedOut: true });
    channel.current?.postMessage({ type: 'signed-out' });
    signOutResult.current?.resolve(true); signOutResult.current = null;
  }, [settle]);
  // Cancelling a sign-in its question asks (engine §7.10) leaves the device as it was before it: the work from before stays
  // here, unsent, and the account's credential goes, recorded first so a reload or another tab finishes it.
  const cancelSignIn = useCallback(async () => {
    const engine = syncSession.engine;
    await engine.cancelSignIn(pending.current?.user.id);
    pending.current = null; setQuestion(null); setError(false);
    await engine.cleanupCredentials();
    settle(null, { signedOut: true });
    channel.current?.postMessage({ type: 'signed-out' });
  }, [settle]);
  const cleanupDevice = useCallback(async (engine, next = null, navigation = null) => {
    const change = engine.device.meta.deviceCleanup;
    if (!change) return;
    if (dataScope.read.getSnapshot().phase !== 'changing')
      roomOwnership.current.scopeTicket = dataScope.begin(next ? { kind: 'account', id: next } : { kind: 'anonymous' });
    roomOwnership.current.blocked = true;
    flushSync(() => setRoomChanging(true));
    await seat.finishDeviceCleanup({ previous: change.previous, next, ...(navigation ? { navigation } : {}) });
    await engine.clearDeviceCleanup(change);
  }, [seat, dataScope]);
  const finishSignOut = useCallback(async (options, next = null, navigation = null) => {
    const engine = syncSession.engine;
    const captured = dataScope.read.getSnapshot();
    let ticket = roomOwnership.current.scopeTicket;
    const forgetDeviceRows = await productQuestions.signOutForgets(engine);
    const result = await engine.finishSignOut({ ...options, deviceCleanup: true, forgetDeviceRows, beforeSignOutCommit: () => {
      const current = dataScope.read.getSnapshot();
      if (current !== captured && !(current.phase === 'changing' && dataScope.ticket === ticket && current.epoch === ticket?.epoch))
        throw new Error('stale document data transition');
      if (current.phase !== 'changing') {
        ticket = dataScope.begin(next ? { kind: 'account', id: next } : { kind: 'anonymous' });
        roomOwnership.current.scopeTicket = ticket;
      }
    } });
    if (result.complete) await cleanupDevice(engine, next, navigation);
    return result;
  }, [cleanupDevice, dataScope, productQuestions]);
  const finishClosure = useCallback(async () => {
    const engine = syncSession.engine;
    const { account, sessionId } = engine.device.meta.closingAccount;
    const replica = engine.device.activeReplica.meta;
    if (replica.state === 'bound' && replica.account === account) {
      const revision = roomOwnership.current.revision;
      const me = await fetchMe();
      if (revision !== roomOwnership.current.revision) throw new Error('account-changed-during-closure');
      confirmRoom(me);
      if (me === undefined) throw new Error('account-closure-unavailable');
      if (me?.id === account) {
        const current = (await listSessions()).find((session) => session.current);
        if (!current?.id) throw new Error('account-closure-session-unavailable');
        if (current.id === sessionId) {
          try { await requestAccountClosure(account); }
          catch (error) {
            if (error.status && error.status !== 401) {
              await engine.clearAccountClosure(sessionId);
              await engine.cancelSignOut();
            }
            if (error.status !== 401) throw error;
          }
        }
      }
      if (engine.device.activeReplica.meta.state === 'bound' && engine.device.activeReplica.meta.account === account)
        await finishSignOut({ choice: 'discard' });
    }
    if (engine.device.meta.clearCredential === account) {
      await engine.cleanupCredentials();
      if (engine.device.meta.clearCredential === account) throw new Error('account-closure-cleanup-unavailable');
    }
    await engine.clearAccountClosure(sessionId);
    signedOut();
  }, [signedOut, finishSignOut, confirmRoom]);
  const bind = useCallback(async (me, answers = {}, revision = roomOwnership.current.revision) => {
    const engine = syncSession.engine;
    const current = engine.device.activeReplica.meta;
    if (current.state === 'bound' && current.account !== me.id) {
      // A cookie replaced elsewhere cannot move this account's work to its successor.
      await finishSignOut({ choice: 'keep' }, me?.id ?? null);
    }
    let result = await engine.signIn(me.id, answers);
    if (!result.complete) {
      const automatic = (await Promise.all(unanswered(result, answers).map(async (question) => {
        const answer = await productQuestions.adoptionAnswer(engine, question);
        return answer ? [[question.product, answer, question.counted]] : [];
      }))).flat();
      if (automatic.length) {
        answers = { ...answers,
          decisions: { ...answers.decisions, ...Object.fromEntries(automatic.map(([product, answer]) => [product, answer])) },
          counted: { ...answers.counted, ...Object.fromEntries(automatic.map(([product, , counted]) => [product, counted])) } };
        result = await engine.signIn(me.id, answers);
      }
    }
    pending.current = { user: me, ...answers, revision };
    if (!result.complete) {
      const due = unanswered(result, answers)[0];
      const count = due ? await productQuestions.adoptionCount(engine, due) : undefined;
      const words = due ? await productQuestions.signInWords(engine, due) ?? null : null;
      setQuestion(due ? { ...due, ...(count === undefined ? {} : { count: { ...due.count, [syncOf(due.product).signedOutWork.type]: count } }), words } : null);
      setError(!result.upgradeRequired && !result.due?.length);
      return;
    }
    pending.current = null; setQuestion(null); setError(false); settle(me, undefined, revision);
  }, [settle, finishSignOut, productQuestions]);
  const refresh = useCallback(({ signedOut = false } = {}) => enqueue(async () => {
    const engine = await syncSession.opening;
    if (engine?.restoring) await engine.restoring;
    if (!engine || engine.closed) return undefined;
    await cleanupDevice(engine);
    seat.restoreHolder(engine);
    const owner = dataScope.read.getSnapshot();
    const replica = engine.device.activeReplica.meta;
    if (owner.phase === 'ready' && !engine.signingOut && !engine.device.meta.deviceCleanup) {
      const holder = replica.state === 'bound' ? { kind: 'account', id: replica.account } : { kind: 'anonymous' };
      if (!dataScope.sameOwner(owner.owner, holder)) roomOwnership.current.scopeTicket = dataScope.begin(holder);
    }
    dataScope.reconcile(engine, roomOwnership.current.scopeTicket ?? dataScope.ticket);
    if (engine.device.meta.closingAccount) {
      const lock = engine.device.meta.signOut?.lock;
      if (lock && !engine.releaseSignOut && (await navigator.locks.query()).held.some((held) => held.name === lock)) return undefined;
      await finishClosure();
      return null;
    }
    if (engine.signingOut || signOutResult.current) return undefined;
    await engine.cleanupCredentials();
    if (engine.device.meta.clearCredential) { settle(null, { signedOut: true }); return null; }
    const revision = roomOwnership.current.revision;
    const me = await fetchMe();
    if (revision !== roomOwnership.current.revision) return undefined;
    const confirmedRevision = confirmRoom(me);
    if (engine.restoring) await engine.restoring;
    if (engine.closed || engine.signingOut || engine.device.meta.closingAccount || signOutResult.current) return undefined;
    await seat.tellCredential(engine, me);
    if (me === undefined) {
      const cached = hint();
      const meta = engine.device.activeReplica.meta;
      if (meta.state === 'bound' && cached?.id === meta.account) settle(cached, undefined, confirmedRevision);
      else if (!seat.confirmed) settle(undefined, undefined, confirmedRevision);
      return undefined;
    }
    if (me) { await bind(me, pending.current?.user.id === me.id ? pending.current : {}, confirmedRevision); return me; }
    const ended = signedOut || Boolean(seat.previousAccount && engine.device.activeReplica.meta.state === 'anon');
    if (ended && engine.device.activeReplica.meta.state === 'bound') await finishSignOut({ choice: 'keep' }, me?.id ?? null);
    pending.current = null; setQuestion(null); settle(null, { signedOut: ended }, confirmedRevision);
    return null;
  }), [enqueue, settle, bind, seat, finishClosure, finishSignOut, cleanupDevice, confirmRoom, dataScope]);
  const signIn = useCallback((me) => {
    const revision = confirmRoom(me);
    return enqueue(async () => {
      await syncSession.opening;
      await cleanupDevice(syncSession.engine);
      seat.restoreHolder(syncSession.engine);
      if (syncSession.engine.device.meta.closingAccount) await finishClosure();
      await bind(me, {}, revision);
      channel.current?.postMessage({ type: 'signed-in' });
    });
  }, [enqueue, bind, finishClosure, seat, cleanupDevice, confirmRoom]);
  const signOut = useCallback(() => {
    if (signOutRequest.current) return signOutRequest.current;
    const admitted = requestNavigation({ key: 'auth:sign-out', context: { kind: 'sign-out' }, run: (navigation) => {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      signOutResult.current = { resolve, navigation, account: syncSession.engine.device.activeReplica.meta.account };
      enqueue(async () => {
        setBusy(true); setError(false);
        try {
          await productQuestions.signOutBegins(syncSession.engine);
          setQuestion(await productQuestions.signOutWords(syncSession.engine, await syncSession.engine.beginSignOut()));
          track('sync_signout', { outcome: 'pending' });
        } finally { setBusy(false); }
      }).catch(() => { signOutResult.current = null; resolve(false); });
      return promise;
    } });
    const result = admitted.then((outcome) => outcome.status === 'completed' && outcome.value);
    signOutRequest.current = result;
    result.finally(() => { if (signOutRequest.current === result) signOutRequest.current = null; });
    return result;
  }, [enqueue, productQuestions]);
  const closeAccount = useCallback((account) => enqueue(async () => {
    setBusy(true); setError(false);
    const engine = syncSession.engine;
    try {
      if (!account || (engine.device.meta.closingAccount?.account ?? engine.device.activeReplica.meta.account) !== account)
        throw new Error('account-changed-during-closure');
      if (!engine.device.meta.closingAccount) {
        const current = (await listSessions()).find((session) => session.current);
        if (!current?.id) throw new Error('account-closure-session-unavailable');
        if (!engine.releaseSignOut) {
          await productQuestions.signOutBegins(engine);
          await engine.beginSignOut();
        }
        try { await engine.recordAccountClosure(account, current.id); }
        catch (error) { await engine.cancelSignOut(); throw error; }
        track('sync_signout', { outcome: 'pending' });
      }
      await finishClosure();
    } finally { setBusy(false); }
  }), [enqueue, finishClosure, productQuestions]);
  const decide = async (choice) => {
    setBusy(true); setError(false);
    try {
      await enqueue(async () => {
        if (question.kind === 'signed-out') {
          const p = pending.current;
          const decisions = { ...p.decisions, [question.product]: choice };
          const counted = { ...p.counted, [question.product]: question.counted };
          track('sync_signin', { outcome: 'pending' });
          await bind(p.user, { decisions, counted }, p.revision);
        } else {
          const engine = syncSession.engine;
          const previous = signOutResult.current?.account;
          const active = engine.device.activeReplica.meta;
          if (!previous || (active.state === 'bound' && active.account !== previous)
            || (engine.device.meta.deviceCleanup && engine.device.meta.deviceCleanup.previous !== previous))
            throw new Error('account-changed-during-signout');
          if (active.state === 'anon') {
            await cleanupDevice(engine, null, signOutResult.current?.navigation);
            signedOut();
            return;
          }
          const result = await finishSignOut({ choice, counted: question.counted }, null, signOutResult.current?.navigation);
          if (!result.complete) { setQuestion(await productQuestions.signOutWords(engine, result)); return; }
          signedOut();
        }
      });
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const reloadLatest = async () => {
    setUpdating(true); setUpdateError(false);
    track('sync_upgrade', { outcome: 'pending' });
    try {
      const worker = navigator.serviceWorker?.controller;
      if (worker) {
        await new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          const timer = setTimeout(() => finish(false), 30000);
          const finish = (ok) => {
            clearTimeout(timer); channel.port1.close(); channel.port2.close();
            if (ok) resolve();
            else reject(new Error('shell-update-unavailable'));
          };
          channel.port1.onmessage = ({ data }) => finish(data?.ok === true);
          channel.port1.onmessageerror = () => finish(false);
          try { worker.postMessage({ type: 'refresh-shell' }, [channel.port2]); }
          catch { finish(false); }
        });
      } else {
        const response = await fetch('/', { cache: 'reload', signal: AbortSignal.timeout(30000) });
        if (!response.ok || response.redirected) throw new Error('shell-update-unavailable');
      }
      track('sync_upgrade', { outcome: 'ok' });
      window.location.reload();
    } catch {
      captureError('offline', 'offline-shell-update', '', '/app');
      track('sync_upgrade', { outcome: 'failed' });
      setUpdateError(true); setUpdating(false);
    }
  };
  useEffect(() => session.engine?.onEvent(({ event }) => {
    if (event === 'restored') refresh().catch(() => {});
  }), [session.engine, refresh]);
  useEffect(() => {
    let alive = true;
    const hooks = PRODUCTS.map((product) => product.sync ?? {});
    // `clear` answers whether the browser holds no credential after it: another account's cookie, or a session it must keep,
    // stays. Whose credential it holds the engine hears from every refresh (`tellCredential`).
    syncSession.open({ base: API_BASE, credentials: { clear: async (account) => {
      const revision = roomOwnership.current.revision;
      const current = await fetchMe();
      if (revision !== roomOwnership.current.revision) throw new Error('account-changed-during-cleanup');
      if (current === undefined) throw new Error('cookie-cleanup-unavailable');
      if (current?.id !== account) { confirmRoom(current); return current === null; }
      const closure = syncSession.engine.device.meta.closingAccount;
      if (closure?.account === account) {
        const session = (await listSessions()).find((session) => session.current);
        if (!session?.id) throw new Error('cookie-cleanup-session-unavailable');
        if (session.id !== closure.sessionId) return false;
      }
      await logout();
      return true;
    } },
      prepare: async (engine) => {
        try { await cleanupDevice(engine); }
        catch (error) {
          captureError('auth', 'auth-session', error?.stack ?? new Error('auth-session').stack, '/auth');
          throw error;
        }
        for (const each of hooks) await each.prepare?.(engine);
      },
      onPushResult: (...args) => { for (const each of hooks) each.onPushResult?.(...args); },
      pendingDeviceWork: (product, rows) => hooks.flatMap((each) => each.pendingDeviceWork?.(product, rows) ?? []),
      adoptDeviceRows: (product, incoming, kept) => {
        for (const each of hooks) {
          const merged = each.adoptDeviceRows?.(product, incoming, kept);
          if (merged !== undefined) return merged;
        }
        return undefined;
      },
      liveHint: (replica) => hooks.some((each) => each.liveHint?.(syncSession.engine, replica)),
    }).then(() => { if (alive) refresh().catch(() => {}); }).catch(() => {});
    const broadcast = new BroadcastChannel('wm-auth');
    channel.current = broadcast;
    broadcast.onmessage = ({ data }) => refresh({ signedOut: data?.type === 'signed-out' }).catch(() => {});
    const wake = () => refresh().catch(() => {});
    window.addEventListener('focus', wake); window.addEventListener('online', wake);
    const poll = setInterval(wake, 20000);
    return () => { alive = false; broadcast.close(); channel.current = null; clearInterval(poll);
      window.removeEventListener('focus', wake); window.removeEventListener('online', wake); };
  }, [refresh, cleanupDevice, confirmRoom]);
  // A surface that says the refused-device line itself holds it from the shell while it stands, so it is said once.
  const holdDeviceLine = useCallback(() => {
    setDeviceLineHolders((holders) => holders + 1);
    return () => setDeviceLineHolders((holders) => holders - 1);
  }, []);
  return <AuthContext.Provider value={{ dataScope: dataScope.read, user, status, account, confirmed, lapsed, roomChanging, signIn, signOut, closeAccount, refresh, holdDeviceLine }}>
    <div style={{ display: 'contents' }} inert={question && !upgradeRequired ? '' : undefined}>{children}</div>
    {!session.online && roomStatus?.status?.connectivity !== 'offline' && (
      <div role="status" style={{
        position: 'fixed', left: 16, bottom: 62, zIndex: 80, padding: '8px 12px',
        background: 'var(--surface-card)', color: 'var(--text-secondary)', borderRadius: 8, fontSize: 13,
      }}>
        {t('shell.auth.offline')}
      </div>
    )}
    {session.error && !deviceLineHolders && <div role="alert">{t('shell.auth.deviceOpenFailed')}</div>}
    {upgradeRequired && <div role="alert" style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 90, padding: '12px 16px', background: 'var(--surface-card)', color: 'var(--text-primary)', borderRadius: 8 }}>
      <p>{superseded ? t('shell.auth.updateSuperseded') : t('shell.auth.updateRequired')}</p>
      <button type="button" onClick={reloadLatest} disabled={updating}>{updating ? t('shell.auth.fetchingUpdate') : t('shell.auth.reloadLatest')}</button>
      {updateError && <p>{t('shell.auth.updateFailed')}</p>}
    </div>}
    {error && !question && !upgradeRequired && <div role="alert">{t('shell.auth.accountChangeFailed')}</div>}
    <SyncDecisions key={`${question?.product ?? 'signout'}:${question?.counted?.join('|') ?? ''}`} question={upgradeRequired ? null : question}
      work={PRODUCTS.find((product) => product.id === question?.product)?.sync?.signedOutWork}
      notices={question ? productQuestions.signOutNotices() : []} busy={busy} error={error} onDecision={decide}
      onCancel={async () => {
        setBusy(true); setError(false);
        try {
          if (question.kind === 'signed-out') await enqueue(cancelSignIn);
          else {
            await enqueue(() => syncSession.engine.cancelSignOut()); setQuestion(null);
            signOutResult.current?.resolve(false); signOutResult.current = null;
          }
        }
        catch { setError(true); }
        finally { setBusy(false); }
      }} />
  </AuthContext.Provider>;
}
