import React, { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { API_BASE } from '../apiBase.js';
import { fetchMe, logout } from './AuthClient.js';
import { closeAccount as requestAccountClosure, listSessions } from './AccountClient.js';
import { DeviceSeat } from './accountChange.js';
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
  const upgradeRequired = useSyncExternalStore(
    useCallback((listener) => session.engine?.observeEngine(listener) ?? (() => {}), [session.engine]),
    () => session.engine?.getSnapshot().upgradeRequired ?? false,
    () => false,
  );
  const [seat] = useState(() => new DeviceSeat(PRODUCTS));
  // Earlier queued binds cannot release a newer confirmed account's room.
  const roomOwnership = useRef({ revision: 0, confirmed: null, target: null,
    blocked: Boolean(syncSession.engine?.device.meta.deviceCleanup) });
  const [roomChanging, setRoomChanging] = useState(roomOwnership.current.blocked);
  const confirmRoom = useCallback((me) => {
    if (!me) return roomOwnership.current.revision;
    const previous = roomOwnership.current.confirmed;
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
  }, [seat]);
  const channel = useRef(null);
  const pending = useRef(null);
  const signOutResult = useRef(null);
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
    syncSession.publish({ signedIn: Boolean(value.account) });
    if (value.confirmed) remember(value.user);
  }, [seat]);
  const signedOut = useCallback(() => {
    pending.current = null; setQuestion(null); setError(false); settle(null, { signedOut: true });
    channel.current?.postMessage({ type: 'signed-out' });
    signOutResult.current?.resolve(true); signOutResult.current = null;
  }, [settle]);
  const cleanupDevice = useCallback(async (engine, next = null) => {
    const change = engine.device.meta.deviceCleanup;
    if (!change) return;
    roomOwnership.current.blocked = true;
    flushSync(() => setRoomChanging(true));
    await seat.finishDeviceCleanup({ previous: change.previous, next });
    await engine.write(null, (device) => {
      if (device.meta.deviceCleanup?.previous === change.previous && device.meta.deviceCleanup?.generation === change.generation)
        delete device.meta.deviceCleanup;
    });
  }, [seat]);
  const finishSignOut = useCallback(async (options, next = null) => {
    const engine = syncSession.engine;
    const result = await engine.finishSignOut({ ...options, deviceCleanup: true });
    if (result.complete) await cleanupDevice(engine, next);
    return result;
  }, [cleanupDevice]);
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
              await engine.write(null, (device) => { if (device.meta.closingAccount?.sessionId === sessionId) delete device.meta.closingAccount; });
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
    await engine.write(null, (device) => { if (device.meta.closingAccount?.sessionId === sessionId) delete device.meta.closingAccount; });
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
      const automatic = (result.due ?? []).flatMap((question) => {
        if (answers.decisions?.[question.product]) return [];
        const answer = PRODUCTS.find((product) => product.id === question.product)?.sync?.adoptionAnswer?.(engine);
        return answer ? [[question.product, answer, question.counted]] : [];
      });
      if (automatic.length) {
        answers = { ...answers,
          decisions: { ...answers.decisions, ...Object.fromEntries(automatic.map(([product, answer]) => [product, answer])) },
          counted: { ...answers.counted, ...Object.fromEntries(automatic.map(([product, , counted]) => [product, counted])) } };
        result = await engine.signIn(me.id, answers);
      }
    }
    pending.current = { user: me, ...answers, revision };
    if (!result.complete) {
      const due = result.due?.[0];
      const product = PRODUCTS.find((product) => product.id === due?.product)?.sync;
      const count = product?.adoptionCount?.(engine);
      setQuestion(due && count !== undefined ? { ...due, count: { ...due.count, [product.signedOutWork.type]: count } } : due ?? null);
      setError(!result.upgradeRequired && !result.due?.length);
      return;
    }
    pending.current = null; setQuestion(null); setError(false); settle(me, undefined, revision);
  }, [settle, finishSignOut]);
  const refresh = useCallback(({ signedOut = false } = {}) => enqueue(async () => {
    const engine = await syncSession.opening;
    if (engine?.restoring) await engine.restoring;
    if (!engine || engine.closed) return undefined;
    await cleanupDevice(engine);
    seat.restoreHolder(engine);
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
    if (me === undefined) {
      const cached = hint();
      const meta = engine.device.activeReplica.meta;
      if (meta.state === 'bound' && cached?.id === meta.account) settle(cached, undefined, confirmedRevision);
      else if (!seat.confirmed) settle(undefined, undefined, confirmedRevision);
      return undefined;
    }
    if (me) { await bind(me, pending.current?.user.id === me.id ? pending.current : {}, confirmedRevision); return me; }
    const ended = signedOut || Boolean(seat.previousAccount && engine.device.activeReplica.meta.state === 'anon');
    if (ended && engine.device.activeReplica.meta.state === 'bound') {
      await finishSignOut({ choice: 'keep' }, me?.id ?? null);
    } else if (engine.device.activeReplica.meta.state === 'bound' && !engine.device.activeReplica.meta.authPaused) {
      await engine.write(null, (device) => { device.activeReplica.meta.authPaused = true; });
    }
    pending.current = null; setQuestion(null); settle(null, { signedOut: ended }, confirmedRevision);
    return null;
  }), [enqueue, settle, bind, seat, finishClosure, finishSignOut, cleanupDevice, confirmRoom]);
  const signIn = useCallback((me) => {
    const revision = confirmRoom(me);
    return enqueue(async () => {
      await syncSession.opening;
      await cleanupDevice(syncSession.engine);
      seat.restoreHolder(syncSession.engine);
      if (syncSession.engine.device.meta.closingAccount) await finishClosure();
      // A freshly verified cookie supersedes any cleanup owed for an earlier session.
      await syncSession.engine.write(null, (device) => { delete device.meta.clearCredential; });
      await bind(me, {}, revision);
      channel.current?.postMessage({ type: 'signed-in' });
    });
  }, [enqueue, bind, finishClosure, seat, cleanupDevice, confirmRoom]);
  const signOut = useCallback(() => {
    if (signOutResult.current) return signOutResult.current.promise;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    signOutResult.current = { promise, resolve, account: syncSession.engine.device.activeReplica.meta.account };
    enqueue(async () => {
      setBusy(true); setError(false);
      try {
        setQuestion(await syncSession.engine.beginSignOut());
        track('sync_signout', { outcome: 'pending' });
      } finally { setBusy(false); }
    }).catch(() => { signOutResult.current = null; resolve(false); });
    return promise;
  }, [enqueue]);
  const closeAccount = useCallback((account) => enqueue(async () => {
    setBusy(true); setError(false);
    const engine = syncSession.engine;
    try {
      if (!account || (engine.device.meta.closingAccount?.account ?? engine.device.activeReplica.meta.account) !== account)
        throw new Error('account-changed-during-closure');
      if (!engine.device.meta.closingAccount) {
        const current = (await listSessions()).find((session) => session.current);
        if (!current?.id) throw new Error('account-closure-session-unavailable');
        if (!engine.releaseSignOut) await engine.beginSignOut();
        try { await engine.write(null, (device) => {
          if (device.activeReplica.meta.state !== 'bound' || device.activeReplica.meta.account !== account)
            throw new Error('account-changed-during-closure');
          device.meta.closingAccount = { account, sessionId: current.id };
        }); }
        catch (error) { await engine.cancelSignOut(); throw error; }
        track('sync_signout', { outcome: 'pending' });
      }
      await finishClosure();
    } finally { setBusy(false); }
  }), [enqueue, finishClosure]);
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
            await cleanupDevice(engine);
            signedOut();
            return;
          }
          const result = await finishSignOut({ choice, counted: question.counted });
          if (!result.complete) { setQuestion(result); return; }
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
    syncSession.open({ base: API_BASE, credentials: { clear: async (account) => {
      const revision = roomOwnership.current.revision;
      const current = await fetchMe();
      if (revision !== roomOwnership.current.revision) throw new Error('account-changed-during-cleanup');
      confirmRoom(current);
      if (current === undefined) throw new Error('cookie-cleanup-unavailable');
      if (current?.id !== account) return;
      const closure = syncSession.engine.device.meta.closingAccount;
      if (closure?.account === account) {
        const session = (await listSessions()).find((session) => session.current);
        if (!session?.id) throw new Error('cookie-cleanup-session-unavailable');
        if (session.id !== closure.sessionId) return;
      }
      await logout();
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
  return <AuthContext.Provider value={{ user, status, account, confirmed, lapsed, roomChanging, signIn, signOut, closeAccount, refresh, holdDeviceLine }}>
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
      <p>{t('shell.auth.updateRequired')}</p>
      <button type="button" onClick={reloadLatest} disabled={updating}>{updating ? t('shell.auth.fetchingUpdate') : t('shell.auth.reloadLatest')}</button>
      {updateError && <p>{t('shell.auth.updateFailed')}</p>}
    </div>}
    {error && !question && !upgradeRequired && <div role="alert">{t('shell.auth.accountChangeFailed')}</div>}
    <SyncDecisions key={`${question?.product ?? 'signout'}:${question?.counted?.join('|') ?? ''}`} question={upgradeRequired ? null : question}
      work={PRODUCTS.find((product) => product.id === question?.product)?.sync?.signedOutWork} busy={busy} error={error} onDecision={decide}
      onCancel={async () => {
        setBusy(true); setError(false);
        try {
          await enqueue(() => syncSession.engine.cancelSignOut()); setQuestion(null);
          signOutResult.current?.resolve(false); signOutResult.current = null;
        }
        catch { setError(true); }
        finally { setBusy(false); }
      }} />
  </AuthContext.Provider>;
}
