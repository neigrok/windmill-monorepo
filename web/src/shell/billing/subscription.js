import { API_BASE } from '../apiBase.js';
import { routeFamily } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';

const ENVIRONMENTS = new Set(['production', 'sandbox']);
const KNOWN_STORES = new Set(['app_store', 'play_store', 'paddle']);
const KNOWN_STATES = new Set(['active', 'grace', 'on_hold', 'paused', 'expired', 'revoked']);

export const APPLE_REFUND_URL = 'https://reportaproblem.apple.com';
export const STORE_MANAGE_URLS = Object.freeze({
  app_store: 'https://apps.apple.com/account/subscriptions',
  play_store: 'https://play.google.com/store/account/subscriptions',
});

const objectOrNull = (value) => value === null || (typeof value === 'object' && !Array.isArray(value));

function isSafeHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export function readSubscription(body) {
  if (body === null || !objectOrNull(body)) return null;
  const shaped = typeof body.windmillOne === 'boolean'
    && ENVIRONMENTS.has(body.environment)
    && typeof body.allowlisted === 'boolean'
    && (body.plan === null || typeof body.plan === 'string')
    && (body.accessUntil === null || Number.isSafeInteger(body.accessUntil))
    && objectOrNull(body.governing)
    && Array.isArray(body.others) && body.others.every((entry) => entry !== null && objectOrNull(entry))
    && objectOrNull(body.manage)
    && Array.isArray(body.purchasable) && body.purchasable.every((store) => typeof store === 'string')
    && objectOrNull(body.offer);
  return shaped ? body : null;
}

export function holdsWindmillOne(subscription) {
  return subscription?.windmillOne === true;
}

export function telemetryStore(store) {
  if (!store) return 'none';
  return KNOWN_STORES.has(store) ? store : 'other';
}

export function isRenewalSlack(entry, now = Date.now()) {
  if (!entry || entry.state !== 'active' || entry.autoRenew !== true) return false;
  const dueAt = entry.nextChargeAt ?? entry.currentPeriod?.end ?? null;
  return Number.isFinite(dueAt) && dueAt <= now;
}

export function manageUrlFor(subscription, entry) {
  if (!entry) return null;
  const manage = subscription?.manage;
  if (manage && manage.store === entry.store && isSafeHttpsUrl(manage.url)) {
    return manage.url;
  }
  return typeof entry.store === 'string' && Object.hasOwn(STORE_MANAGE_URLS, entry.store)
    ? STORE_MANAGE_URLS[entry.store]
    : null;
}

export function hasProductionAppStoreRefundLink(subscription) {
  if (!subscription || subscription.environment !== 'production' || !subscription.governing) return false;
  const entries = [subscription.governing, ...(subscription.others ?? [])];
  return entries.some((entry) => entry?.store === 'app_store' && (entry.state === 'active' || entry.state === 'grace'));
}

function willKeepCharging(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.state === 'active') return entry.autoRenew === true;
  return entry.state === 'grace' || entry.state === 'on_hold' || entry.state === 'paused';
}

export function storesChargingAfterClose(subscription) {
  if (!subscription || subscription.environment !== 'production') return [];
  const entries = [subscription.governing, ...(subscription.others ?? [])].filter(willKeepCharging);
  const seen = new Set();
  const links = [];
  for (const entry of entries) {
    if (!entry.store || seen.has(entry.store)) continue;
    const url = manageUrlFor(subscription, entry);
    if (!url) continue;
    seen.add(entry.store);
    links.push({ store: entry.store, url });
  }
  return links;
}

export function planTelemetry(subscriptionStatus, subscription, now = Date.now()) {
  if (subscriptionStatus === 'error' || !subscription) {
    return { state: 'error', store: 'none', environment: 'none', twice: false };
  }
  const environment = ENVIRONMENTS.has(subscription.environment) ? subscription.environment : 'none';
  const governing = subscription.governing;
  const twice = Array.isArray(subscription.others) && subscription.others.length > 0;
  if (!governing) {
    return { state: 'free', store: 'none', environment, twice: false };
  }
  const store = telemetryStore(governing.store);
  if (governing.state === 'active') {
    const state = governing.autoRenew === false
      ? 'renewal_off'
      : isRenewalSlack(governing, now) ? 'renewal_slack' : 'active';
    return { state, store, environment, twice };
  }
  const state = KNOWN_STATES.has(governing.state) ? governing.state : 'other';
  return { state, store, environment, twice };
}

function reportSubscriptionFailure(reason) {
  const route = typeof window === 'undefined' ? '' : routeFamily(window.location);
  captureError('billing', 'subscription.read', new Error('subscription.read').stack, route, { reason });
}

export async function fetchSubscription(report = reportSubscriptionFailure) {
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/subscription`, { credentials: 'include' });
  } catch {
    return null;
  }
  if (response.status >= 500) {
    report('server');
    return null;
  }
  if (!response.ok) return null;
  const subscription = readSubscription(await response.json().catch(() => null));
  if (!subscription) report('shape');
  return subscription;
}
