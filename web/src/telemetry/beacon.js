// First-party funnel telemetry. track() queues; batches flush to POST /v1/events when the queue
// fills, on a short debounce, and on page hide via sendBeacon. Offline events stay in the bounded
// memory queue until reconnect; attempted sends are fire-and-forget and never affect the product.

import { API_BASE } from '../shell/apiBase.js';
import { captureError } from './sentry.js';

const SESSION_KEY_STORAGE = 'windmill:beacon:key';
const DEV_OPT_IN_STORAGE = 'windmill:beacon:dev';
const FLUSH_AT = 20;
const FLUSH_AFTER_MS = 5000;
const MAX_EVENTS_PER_SEND = 50;
const MAX_QUEUED_EVENTS = 200;

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
  if (queue.length > MAX_QUEUED_EVENTS) queue.shift();
  if (globalThis.navigator?.onLine === false) return;
  if (queue.length >= FLUSH_AT) {
    flush('fetch');
    return;
  }
  if (flushTimer === null) flushTimer = window.setTimeout(() => flush('fetch'), FLUSH_AFTER_MS);
}

// A crash beacons once and flushes NOW, because the page may reload before the debounce fires. The
// message leaves in neither report: the event carries labels only, and Sentry gets a static message,
// the same labels and the frames. V8 repeats the message whole at the head of the stack, so it is cut
// from there first. `labels` are what a caller adds for Sentry, bounded labels and nothing else.
export function reportError(error, kind, labels = {}) {
  if (typeof window === 'undefined') return;
  const route = routeFamily(window.location);
  const reportKind = labelIn(REPORT_KINDS, kind);
  const failureKind = labelIn(FAILURE_KINDS, error?.constructor?.name);
  track('client_error', { kind: reportKind, failure_kind: failureKind, route });
  const stack = scrubbed(String(error?.stack ?? '').replace(`: ${error?.message}`, ''));
  captureError(reportKind, 'client-error', stack, route, { ...labels, failure_kind: failureKind }); // no-op without a DSN
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

// A frame's file can be the page's own address, so every address that is a capability is struck out
// of the stack wherever it appears, with `token=` and `code=` values.
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
  if (globalThis.navigator?.onLine === false) return;
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
  window.addEventListener?.('online', () => flush('fetch'));
  window.addEventListener?.('pagehide', () => flush('beacon'));
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush('beacon');
  });
}
