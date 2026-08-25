// Minimal Sentry error reporting: a single envelope POST to the ingest endpoint, no SDK. Teed off
// beacon.reportError. An unset DSN is a no-op, like the beacon's mute, and a failed send is
// swallowed by contract.

const DSN = import.meta.env?.VITE_SENTRY_DSN || '';
const RELEASE = import.meta.env?.VITE_RELEASE || '';
const DEV_OPT_IN_STORAGE = 'windmill:beacon:dev';

function parseDsn(dsn) {
  const m = /^https:\/\/([0-9a-f]+)@([^/]+)\/(\d+)$/i.exec(dsn);
  if (!m) return null;
  return { publicKey: m[1], host: m[2], projectId: m[3] };
}

const parsed = parseDsn(DSN);

// Mirror the beacon's mute: never send from localhost unless a dev has opted in.
function muted() {
  if (typeof window === 'undefined') return true;
  if (window.location.hostname !== 'localhost') return false;
  try {
    return !localStorage.getItem(DEV_OPT_IN_STORAGE);
  } catch {
    return true;
  }
}

// Flood guard: collapse a repeating error (same kind+message+route) within a short window, and cap
// total events per rolling minute, so a throw inside a rAF loop cannot burn the quota.
const DEDUP_MS = 10000;
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 30;
const recentSignatures = new Map();
let windowStart = 0;
let windowCount = 0;

function allowed(signature) {
  const now = Date.now();
  const last = recentSignatures.get(signature);
  if (last !== undefined && now - last < DEDUP_MS) return false;
  if (now - windowStart > RATE_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= RATE_MAX) return false;
  windowCount++;
  recentSignatures.set(signature, now);
  if (recentSignatures.size > 200)
    for (const [key, at] of recentSignatures) if (now - at > DEDUP_MS) recentSignatures.delete(key);
  return true;
}

function eventId() {
  const hex = (crypto.randomUUID?.() ?? '').replace(/-/g, '');
  return hex.length === 32 ? hex : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// A V8/Safari stack into Sentry frames, ordered oldest-first (the crashing frame last, as Sentry
// expects). Lines with no file:line:col are skipped.
function framesFromStack(stack) {
  const frames = [];
  for (const line of String(stack).split('\n')) {
    const at = /\(?(\S+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (!at) continue;
    const named = /at\s+([^(]+?)\s*\(/.exec(line);
    frames.push({ filename: at[1], lineno: Number(at[2]), colno: Number(at[3]), function: named ? named[1].trim() : '?', in_app: true });
  }
  return frames.reverse();
}

export function captureError(kind, message, stack, route) {
  // The whole body is guarded: captureError runs from the window 'error' handler, so a throw here
  // would re-dispatch 'error' → captureError → throw.
  try {
    if (!parsed || muted()) return;
    const type = String(kind || 'Error').slice(0, 40);
    const value = String(message ?? 'unknown').slice(0, 1000);
    if (!allowed(`${type}|${value}|${route}`)) return;
    const id = eventId();
    const event = {
      event_id: id,
      timestamp: Date.now() / 1000,
      platform: 'javascript',
      level: 'error',
      logger: 'windmill-web',
      environment: import.meta.env?.PROD ? 'production' : 'development',
      ...(RELEASE ? { release: RELEASE } : {}),
      tags: { kind: type },
      // Already reduced to its family by reportError, the one caller: falling back to
      // window.location.href here would put the magic-link and shared-workout secrets back.
      request: { url: route || '' },
      exception: { values: [{ type, value, stacktrace: { frames: framesFromStack(stack) } }] },
    };
    const envelope = `${JSON.stringify({ event_id: id, dsn: DSN })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}`;
    fetch(`https://${parsed.host}/api/${parsed.projectId}/envelope/`, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=windmill-web/1.0, sentry_key=${parsed.publicKey}`,
      },
      body: envelope,
    }).catch(() => {});
  } catch {
    // swallowed by contract
  }
}
