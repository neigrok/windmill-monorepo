// Billing's client half: read this account's subscription and open a checkout for it.

import { API_BASE } from '../apiBase.js';

const TOKEN = import.meta.env?.VITE_PADDLE_TOKEN || '';
const ENVIRONMENT = import.meta.env?.VITE_PADDLE_ENV || 'sandbox';
const PADDLE_SCRIPT = 'https://cdn.paddle.com/paddle/v2/paddle.js';

let scriptPromise = null;
let initialized = false;
let onCheckoutCompleted = null;

export function billingConfigured() {
  return !!TOKEN;
}

// While this is false no surface may offer a checkout; every buy control must read it first.
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

// Paddle keeps one global, so initialize once.
function initialize(paddle) {
  if (initialized) return;
  if (ENVIRONMENT !== 'production') paddle.Environment?.set('sandbox');
  paddle.Initialize({
    token: TOKEN,
    eventCallback: (event) => {
      if (event?.name !== 'checkout.completed') return;
      const handler = onCheckoutCompleted;
      onCheckoutCompleted = null;
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
    onCheckoutCompleted = onCompleted ?? null;
    paddle.Checkout.open({ transactionId });
    return true;
  } catch {
    onCheckoutCompleted = null;
    return false;
  }
}

// False means there is nothing left to try.
export async function beginUpgrade({ onCompleted } = {}) {
  const checkout = await startCheckout();
  if (!checkout) return false;
  rememberMintedCheckout(checkout.transactionId);
  if (await openCheckout(checkout.transactionId, { onCompleted })) return true;
  if (!checkout.checkoutUrl) return false;
  window.location.href = checkout.checkoutUrl;
  return true;
}

// A `?_ptxn=<transaction>` return trip resumes only if this tab minted it; the mint is spent on read.
const RESUMABLE_KEY = 'windmill:checkout:mine';

function rememberMintedCheckout(transactionId) {
  try {
    sessionStorage.setItem(RESUMABLE_KEY, transactionId);
  } catch { /* storage unavailable — the return trip simply won't resume */ }
}

export function pendingTransactionId() {
  try {
    const claimed = new URLSearchParams(window.location.search).get('_ptxn') || '';
    if (!claimed) return '';  // leave the mint unspent for a real return trip
    const mine = sessionStorage.getItem(RESUMABLE_KEY) || '';
    sessionStorage.removeItem(RESUMABLE_KEY);
    if (claimed !== mine) return '';
    return claimed;
  } catch {
    return '';
  }
}
