import React, { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { API_BASE } from '../apiBase.js';
import { fetchMe, logout } from './AuthClient.js';
import { closeAccount as requestAccountClosure, listSessions } from './AccountClient.js';
import { DeviceSeat } from './accountChange.js';
import { PRODUCTS } from '../products.js';
import { syncSession } from '../../platform/sync/session.js';
import { captureError } from '../../telemetry/sentry.js';
import { track } from '../../telemetry/beacon.js';
import { SyncDecisions } from './SyncDecisions.jsx';

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
  const [question, setQuestion] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState(false);
  const session = useSyncExternalStore(syncSession.subscribe, syncSession.getSnapshot, syncSession.getSnapshot);
  const upgradeRequired = useSyncExternalStore(
    useCallback((listener) => session.engine?.observeEngine(listener) ?? (() => {}), [session.engine]),
    () => session.engine?.getSnapshot().upgradeRequired ?? false,
    () => false,
  );
  const [seat] = useState(() => new DeviceSeat());
  const channel = useRef(null);
  const pending = useRef(null);
  const signOutResult = useRef(null);
  const queue = useRef(Promise.resolve());
  const enqueue = useCallback((run) => {
    const next = queue.current.then(run);
    queue.current = next.catch(() => { captureError('auth', 'auth-session', '', '/auth'); setError(true); });
    return next;
  }, []);
  const settle = useCallback((me) => {
    const value = seat.receive(me);
    if (!value) return;
    setUser(value.user); setStatus(value.status); setAccount(value.account);
    syncSession.publish({ signedIn: Boolean(value.account) });
    if (value.confirmed) remember(value.user);
  }, [seat]);
  const signedOut = useCallback(() => {
    pending.current = null; setQuestion(null); setError(false); settle(null);
    channel.current?.postMessage({ type: 'signed-out' });
    signOutResult.current?.resolve(true); signOutResult.current = null;
  }, [settle]);
  const finishClosure = useCallback(async () => {
    const engine = syncSession.engine;
    const { account, sessionId } = engine.device.meta.closingAccount;
    const replica = engine.device.activeReplica.meta;
    if (replica.state === 'bound' && replica.account === account) {
      const me = await fetchMe();
      if (me === undefined) throw new Error('account-closure-unavailable');
      if (me?.id === account) {
        const current = (await listSessions()).find((session) => session.current);
        if (!current?.id) throw new Error('account-closure-session-unavailable');
        if (current.id === sessionId) {
          try { await requestAccountClosure(); }
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
        await engine.finishSignOut({ choice: 'discard' });
    }
    if (engine.device.meta.clearCredential === account) {
      await engine.cleanupCredentials();
      if (engine.device.meta.clearCredential === account) throw new Error('account-closure-cleanup-unavailable');
    }
    await engine.write(null, (device) => { if (device.meta.closingAccount?.sessionId === sessionId) delete device.meta.closingAccount; });
    signedOut();
  }, [signedOut]);
  const bind = useCallback(async (me, answers = {}) => {
    const engine = syncSession.engine;
    const current = engine.device.activeReplica.meta;
    if (current.state === 'bound' && current.account !== me.id) {
      // A cookie replaced elsewhere cannot move this account's work to its successor.
      await engine.finishSignOut({ choice: 'keep' });
    }
    const result = await engine.signIn(me.id, answers);
    pending.current = { user: me, ...answers };
    if (!result.complete) {
      setQuestion(result.due?.[0] ?? null);
      setError(!result.upgradeRequired && !result.due?.length);
      return;
    }
    pending.current = null; setQuestion(null); setError(false); settle(me);
  }, [settle]);
  const refresh = useCallback(() => enqueue(async () => {
    const engine = await syncSession.opening;
    if (engine?.restoring) await engine.restoring;
    if (!engine || engine.closed) return undefined;
    if (engine.device.meta.closingAccount) {
      const lock = engine.device.meta.signOut?.lock;
      if (lock && !engine.releaseSignOut && (await navigator.locks.query()).held.some((held) => held.name === lock)) return undefined;
      await finishClosure();
      return null;
    }
    if (engine.signingOut || signOutResult.current) return undefined;
    await engine.cleanupCredentials();
    if (engine.device.meta.clearCredential) { settle(null); return null; }
    const me = await fetchMe();
    if (engine.restoring) await engine.restoring;
    if (engine.closed || engine.signingOut || engine.device.meta.closingAccount || signOutResult.current) return undefined;
    if (me === undefined) {
      const cached = hint();
      const meta = engine.device.activeReplica.meta;
      if (meta.state === 'bound' && cached?.id === meta.account) settle(cached);
      else if (!seat.confirmed) settle(undefined);
      return undefined;
    }
    if (me) { await bind(me, pending.current?.user.id === me.id ? pending.current : {}); return me; }
    if (engine.device.activeReplica.meta.state === 'bound') await engine.finishSignOut({ choice: 'keep' });
    pending.current = null; setQuestion(null); settle(null);
    return null;
  }), [enqueue, settle, bind, seat, finishClosure]);
  const signIn = useCallback((me) => enqueue(async () => {
    await syncSession.opening;
    if (syncSession.engine.device.meta.closingAccount) await finishClosure();
    // A freshly verified cookie supersedes any cleanup owed for an earlier session.
    await syncSession.engine.write(null, (device) => { delete device.meta.clearCredential; });
    await bind(me);
    channel.current?.postMessage({ type: 'signed-in' });
  }), [enqueue, bind, finishClosure]);
  const signOut = useCallback(() => {
    if (signOutResult.current) return signOutResult.current.promise;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    signOutResult.current = { promise, resolve };
    enqueue(async () => {
      setBusy(true); setError(false);
      try {
        setQuestion(await syncSession.engine.beginSignOut());
        track('sync_signout', { outcome: 'pending' });
      } finally { setBusy(false); }
    }).catch(() => { signOutResult.current = null; resolve(false); });
    return promise;
  }, [enqueue]);
  const closeAccount = useCallback(() => enqueue(async () => {
    setBusy(true); setError(false);
    const engine = syncSession.engine;
    try {
      if (!engine.device.meta.closingAccount) {
        const account = engine.device.activeReplica.meta.account;
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
          await bind(p.user, { decisions, counted });
        } else {
          const result = await syncSession.engine.finishSignOut({ choice, counted: question.counted });
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
      const current = await fetchMe();
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
      prepare: async (engine) => { for (const each of hooks) await each.prepare?.(engine); },
      onPushResult: (...args) => { for (const each of hooks) each.onPushResult?.(...args); },
      pendingDeviceWork: (product, rows) => hooks.flatMap((each) => each.pendingDeviceWork?.(product, rows) ?? []),
      liveHint: (replica) => hooks.some((each) => each.liveHint?.(syncSession.engine, replica)),
    }).then(() => { if (alive) refresh().catch(() => {}); }).catch(() => {});
    const broadcast = new BroadcastChannel('wm-auth');
    channel.current = broadcast;
    broadcast.onmessage = () => refresh().catch(() => {});
    const wake = () => refresh().catch(() => {});
    window.addEventListener('focus', wake); window.addEventListener('online', wake);
    const poll = setInterval(wake, 20000);
    return () => { alive = false; broadcast.close(); channel.current = null; clearInterval(poll);
      window.removeEventListener('focus', wake); window.removeEventListener('online', wake); };
  }, [refresh]);
  return <AuthContext.Provider value={{ user, status, account, signIn, signOut, closeAccount, refresh }}>
    <div style={{ display: 'contents' }} inert={question && !upgradeRequired ? '' : undefined}>{children}</div>
    {!session.online && <div role="status" style={{ position: 'fixed', left: 16, bottom: 62, zIndex: 80, padding: '8px 12px', background: 'var(--surface-card)', color: 'var(--text-secondary)', borderRadius: 8, fontSize: 13 }}>Offline. Coach, echoes, nudges, voice and export need a connection.</div>}
    {session.error && <div role="alert">Couldn’t open this device’s saved work. Reload to try again.</div>}
    {upgradeRequired && <div role="alert" style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 90, padding: '12px 16px', background: 'var(--surface-card)', color: 'var(--text-primary)', borderRadius: 8 }}>
      <p>Update required. Reload Windmill to reconnect your account. Your pending work stays on this device.</p>
      <button type="button" onClick={reloadLatest} disabled={updating}>{updating ? 'Fetching update…' : 'Reload latest version'}</button>
      {updateError && <p>Couldn’t fetch the update. Your work is still here. Try again when connected.</p>}
    </div>}
    {error && !question && !upgradeRequired && <div role="alert">Couldn’t finish updating your account on this device. Try again.</div>}
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
