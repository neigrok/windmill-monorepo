// First-party funnel telemetry. track() queues; batches flush to POST /v1/events when the queue
// fills, on a short debounce, and on page hide via sendBeacon. Fire-and-forget by contract: a
// failed send is silently dropped and must never affect product behavior.

import { API_BASE } from '../shell/apiBase.js';
import { captureError } from './sentry.js';

const SESSION_KEY_STORAGE = 'windmill:beacon:key';
const DEV_OPT_IN_STORAGE = 'windmill:beacon:dev';
const FLUSH_AT = 20;
const FLUSH_AFTER_MS = 5000;
const MAX_EVENTS_PER_SEND = 50;

const queue = [];
let flushTimer = null;
let mintedKey = null;

export function track(name, props) {
  if (typeof window === 'undefined') return;
  queue.push({ name, clientMs: Date.now(), ...(props ? { props } : {}) });
  if (queue.length >= FLUSH_AT) {
    flush('fetch');
    return;
  }
  if (flushTimer === null) flushTimer = window.setTimeout(() => flush('fetch'), FLUSH_AFTER_MS);
}

// A crash beacons once and flushes NOW, because the page may reload before the debounce fires.
// The props stay a flat object under the endpoint's 1KB budget.
export function reportError(error, kind = 'error') {
  if (typeof window === 'undefined') return;
  const stack = scrubbed(String(error?.stack ?? ''));
  const message = scrubbed(String(error?.message ?? error ?? 'unknown'));
  const route = routeFamily(window.location?.hash || window.location?.pathname || '');
  track('client_error', { kind: String(kind).slice(0, 40), message: message.slice(0, 280), stack: stack.slice(0, 480), route });
  captureError(kind, message, stack, route); // no-op without a DSN
  flush('beacon');
}

// Secrets ride in the fragment (#/auth?token=…, #/gym/shared/<token>, #/oauth/authorize?…), so a
// route is cut to its FAMILY before it leaves the page: the query is dropped whole, and the two
// segments that ARE capabilities — a coach-share token and the tree id in a #/t/ link — become `*`.
// An id the server still guards for its owner (#/app/<treeId>) is kept.
export function routeFamily(route) {
  const path = String(route).split('?')[0].slice(0, 120);
  return path.replace(/^(#\/gym\/shared)\/.+$/, '$1/*').replace(/^(#\/t)\/.+$/, '$1/*');
}

// The same secrets can ride a message or a stack, so every capability routeFamily strips is struck
// out of the prose too, wherever it appears, plus the `code=` an OAuth error carries.
function scrubbed(text) {
  return text
    .replace(/token=[^&\s'"]+/gi, 'token=*')
    .replace(/code=[^&\s'"]+/gi, 'code=*')
    .replace(/(\/gym\/shared\/)[^/\s'"]+/gi, '$1*')
    .replace(/(#\/t\/)[^/\s'"?]+/gi, '$1*');
}

function flush(transport) {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  while (queue.length > 0) send(queue.splice(0, MAX_EVENTS_PER_SEND), transport);
}

function send(events, transport) {
  if (muted()) return;
  const body = JSON.stringify({ sessionKey: sessionKey(), events });
  if (transport === 'beacon' && sendViaBeacon(body)) return;
  try {
    fetch(`${API_BASE}/v1/events`, {
      method: 'POST',
      credentials: 'include',
      keepalive: transport === 'beacon',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {});
  } catch {
    // swallowed by contract
  }
}

function sendViaBeacon(body) {
  if (!navigator.sendBeacon) return false;
  try {
    return navigator.sendBeacon(`${API_BASE}/v1/events`, new Blob([body], { type: 'application/json' }));
  } catch {
    return false;
  }
}

function muted() {
  if (window.location.hostname !== 'localhost') return false;
  try {
    return !localStorage.getItem(DEV_OPT_IN_STORAGE);
  } catch {
    return true;
  }
}

function sessionKey() {
  if (mintedKey) return mintedKey;
  const mint = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    mintedKey = localStorage.getItem(SESSION_KEY_STORAGE);
    if (!mintedKey) {
      mintedKey = mint();
      localStorage.setItem(SESSION_KEY_STORAGE, mintedKey);
    }
  } catch {
    mintedKey = mint();
  }
  return mintedKey;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flush('beacon'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush('beacon');
  });
}
