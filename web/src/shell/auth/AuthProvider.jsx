import React, { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { fetchMe, logout } from './AuthClient.js';
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
    if (!engine || engine.closed || engine.signingOut) return undefined;
    await engine.cleanupCredentials();
    if (engine.device.meta.clearCredential) { settle(null); return null; }
    const me = await fetchMe();
    if (engine.restoring) await engine.restoring;
    if (engine.closed || engine.signingOut) return undefined;
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
  }), [enqueue, settle, bind, seat]);
  const signIn = useCallback((me) => enqueue(async () => {
    await syncSession.opening;
    // A freshly verified cookie supersedes any cleanup owed for an earlier session.
    await syncSession.engine.write(null, (device) => { delete device.meta.clearCredential; });
    await bind(me);
    channel.current?.postMessage({ type: 'signed-in' });
  }), [enqueue, bind]);
  const signOut = useCallback(() => enqueue(async () => {
    setBusy(true); setError(false);
    try {
      setQuestion(await syncSession.engine.beginSignOut());
      track('sync_signout', { outcome: 'pending' });
    } finally { setBusy(false); }
  }), [enqueue]);
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
          setQuestion(null); settle(null);
          channel.current?.postMessage({ type: 'signed-out' });
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
    syncSession.open({ credentials: { clear: async (account) => {
      const current = await fetchMe();
      if (current === undefined) throw new Error('cookie-cleanup-unavailable');
      if (current?.id === account) await logout();
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
  return <AuthContext.Provider value={{ user, status, account, signIn, signOut, refresh }}>
    <div style={{ display: 'contents' }} inert={question && !upgradeRequired ? '' : undefined}>{children}</div>
    {!session.online && <div role="status" style={{ position: 'fixed', left: 16, bottom: 62, zIndex: 80, padding: '8px 12px', background: 'var(--surface-card)', color: 'var(--text-secondary)', borderRadius: 8, fontSize: 13 }}>Offline. Coach, echoes, nudges, voice and export need a connection.</div>}
    {session.error && <div role="alert">Couldn’t open this device’s saved work. Reload to try again.</div>}
    {upgradeRequired && <div role="alert" style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 90, padding: '12px 16px', background: 'var(--surface-card)', color: 'var(--text-primary)', borderRadius: 8 }}>
      <p>Update required. Reload Windmill to reconnect your account. Your pending work stays on this device.</p>
      <button type="button" onClick={reloadLatest} disabled={updating}>{updating ? 'Fetching update…' : 'Reload latest version'}</button>
      {updateError && <p>Couldn’t fetch the update. Your work is still here. Try again when connected.</p>}
    </div>}
    {error && !question && !upgradeRequired && <div role="alert">Couldn’t connect your account. Your work is still on this device.</div>}
    <SyncDecisions key={`${question?.product ?? 'signout'}:${question?.counted?.join('|') ?? ''}`} question={upgradeRequired ? null : question}
      work={PRODUCTS.find((product) => product.id === question?.product)?.sync?.signedOutWork} busy={busy} error={error} onDecision={decide}
      onCancel={async () => {
        setBusy(true); setError(false);
        try { await enqueue(() => syncSession.engine.cancelSignOut()); setQuestion(null); }
        catch { setError(true); }
        finally { setBusy(false); }
      }} />
  </AuthContext.Provider>;
}
