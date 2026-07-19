// Billing's client half: read this account's subscription, and open a checkout for it.
//
// The checkout is minted server-side — the browser asks for one and gets back a transaction that
// already carries the customer and the account id, so there is no email field here to get wrong and
// no way to open somebody else's checkout. Paddle.js is fetched lazily, only when a checkout is
// actually opened, so a third-party script never loads for someone who is just reading a tree.

import { API_BASE } from '../apiBase.js';

const TOKEN = import.meta.env?.VITE_PADDLE_TOKEN || '';
const ENVIRONMENT = import.meta.env?.VITE_PADDLE_ENV || 'sandbox';
const PADDLE_SCRIPT = 'https://cdn.paddle.com/paddle/v2/paddle.js';

let scriptPromise = null;
let initialized = false;
const completedHandlers = new Set();

export function billingConfigured() {
  return !!TOKEN;
}

export async function fetchSubscription() {
  try {
    const response = await fetch(`${API_BASE}/v1/subscription`, { credentials: 'include' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// One checkout per click: the server mints a fresh transaction each time, so a link left in history
// can't be reused into another session.
export async function startCheckout() {
  try {
    const response = await fetch(`${API_BASE}/v1/billing/checkout`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) return null;
    return await response.json(); // { transactionId, checkoutUrl }
  } catch {
    return null;
  }
}

function loadPaddle() {
  if (window.Paddle) return Promise.resolve(window.Paddle);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = PADDLE_SCRIPT;
    tag.async = true;
    tag.onload = () => resolve(window.Paddle);
    tag.onerror = () => reject(new Error('paddle.js unreachable'));
    document.head.appendChild(tag);
  });
  return scriptPromise;
}

// Initialize exactly once — Paddle keeps one global — and fan its events out to whoever is waiting,
// so a second checkout later doesn't re-register the vendor or lose the first caller's callback.
function initialize(paddle) {
  if (initialized) return;
  if (ENVIRONMENT !== 'production') paddle.Environment?.set('sandbox');
  paddle.Initialize({
    token: TOKEN,
    eventCallback: (event) => {
      if (event?.name === 'checkout.completed')
        for (const handler of completedHandlers) handler(event);
    },
  });
  initialized = true;
}

export async function openCheckout(transactionId, { onCompleted } = {}) {
  if (!TOKEN || !transactionId) return false;
  if (onCompleted) completedHandlers.add(onCompleted);
  try {
    const paddle = await loadPaddle();
    if (!paddle) return false;
    initialize(paddle);
    paddle.Checkout.open({ transactionId });
    return true;
  } catch {
    return false;
  }
}

// Paddle's payment link lands back on our own origin as `?_ptxn=<transaction>`; whichever route the
// browser opens, that parameter means "resume this checkout".
export function pendingTransactionId() {
  try {
    return new URLSearchParams(window.location.search).get('_ptxn') || '';
  } catch {
    return '';
  }
}
