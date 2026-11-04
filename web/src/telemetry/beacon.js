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

// client_error carries only labels from these closed sets; anything they do not name reads `other`.
const REPORT_KINDS = new Set(['window', 'promise', 'render', 'shape']);
const FAILURE_KINDS = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'DOMException']);
const OTHER = 'other';

// An address and the family it reports as, first match wins. A family is a literal from this table,
// so an id, token or date in a URL cannot leave the page and a new route reads `other` until named.
const ROUTE_FAMILIES = [
  ['#/', '/'],
  ['#/app', '/app/roadmap'],
  ['#/t', '/t'],
  ['#/demo', '/demo'],
  ['#/browse', '/browse'],
  ['#/gym/shared', '/gym/shared'],
  ['#/gym/shared-log', '/gym/shared'],
  ['#/gym', '/app/gym'],
  ['#/journal', '/app/journal'],
  ['#/settings', '/app/settings'],
  ['#/connect', '/app/connect'],
  ['#/auth', '/auth'],
  ['#/oauth/authorize', '/oauth/authorize'],
  ['#/showcase', '/showcase'],
  ['/', '/'],
  ['/app/roadmap', '/app/roadmap'],
  ['/app/gym', '/app/gym'],
  ['/app/journal', '/app/journal'],
  ['/app/settings', '/app/settings'],
  ['/app/connect', '/app/connect'],
  ['/app', '/app'],
  ['/t', '/t'],
  ['/roadmap', '/roadmap'],
  ['/gym', '/gym'],
  ['/journal', '/journal'],
];

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

// A crash beacons once and flushes NOW, because the page may reload before the debounce fires. The
// event carries labels only; the message and the stack go to Sentry alone.
export function reportError(error, kind) {
  if (typeof window === 'undefined') return;
  const route = routeFamily(window.location);
  track('client_error', { kind: labelIn(REPORT_KINDS, kind), failure_kind: labelIn(FAILURE_KINDS, error?.constructor?.name), route });
  const message = scrubbed(String(error?.message ?? error ?? 'unknown'));
  const stack = scrubbed(String(error?.stack ?? ''));
  captureError(kind, message, stack, route); // no-op without a DSN
  flush('beacon');
}

function labelIn(labels, value) {
  return labels.has(value) ? value : OTHER;
}

// The hash wins when it names an app destination, as it does in the router.
export function routeFamily({ hash, pathname }) {
  const address = (hash.startsWith('#/') ? hash : pathname).split('?')[0];
  const family = ROUTE_FAMILIES.find(([prefix]) => address === prefix || address.startsWith(`${prefix}/`));
  return family ? family[1] : OTHER;
}

// A secret can ride a message or a stack on its way to Sentry, so every address that is a capability
// is struck out wherever it appears, plus the `code=` an OAuth error carries.
function scrubbed(text) {
  return text
    .replace(/token=[^&\s'"]+/gi, 'token=*')
    .replace(/code=[^&\s'"]+/gi, 'code=*')
    .replace(/(\/gym\/shared(?:-log)?\/)[^/\s'"]+/gi, '$1*')
    .replace(/(\/t\/)[^/\s'"?]+/gi, '$1*');
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
  window.addEventListener?.('pagehide', () => flush('beacon'));
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush('beacon');
  });
}
