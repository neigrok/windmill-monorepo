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
// Only one overlay can be open at a time, so there is only ever one caller waiting on it. Holding
// a single slot instead of a growing set means a component that re-renders between clicks can't
// leave older callbacks behind to fire on somebody else's checkout later.
let onCheckoutCompleted = null;

export function billingConfigured() {
  return !!TOKEN;
}

// Nothing is for sale right now. The paid line is tending — the in-app AI, which costs us
// something per run. Until it ships there is no plan to be on and no Upgrade, so the settings
// page carries no Plan section at all: naming a tier nobody can buy is an advertisement, not a
// setting. Flip this to true when tending arms, and the section comes back with it.
export function paidPlansOpen() {
  return false;
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
      if (event?.name !== 'checkout.completed') return;
      const handler = onCheckoutCompleted;
      onCheckoutCompleted = null;  // one checkout, one completion — never replayed onto the next
      handler?.(event);
    },
  });
  initialized = true;
}

export async function openCheckout(transactionId, { onCompleted } = {}) {
  if (!TOKEN || !transactionId) return false;
  try {
    const paddle = await loadPaddle();
    if (!paddle) return false;
    initialize(paddle);
    onCheckoutCompleted = onCompleted ?? null;  // armed only once the overlay is really opening
    paddle.Checkout.open({ transactionId });
    return true;
  } catch {
    onCheckoutCompleted = null;
    return false;
  }
}

// The whole upgrade ceremony, so every door into Pro behaves the same: mint a fresh transaction,
// open the overlay, and fall back to Paddle's own hosted page when the overlay can't open (blocked
// script, stubborn browser). False means there is nothing left to try and the caller should say so.
export async function beginUpgrade({ onCompleted } = {}) {
  const checkout = await startCheckout();
  if (!checkout) return false;
  if (await openCheckout(checkout.transactionId, { onCompleted })) return true;
  if (!checkout.checkoutUrl) return false;
  window.location.href = checkout.checkoutUrl;
  return true;
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
