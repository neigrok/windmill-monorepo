// The account's subscription as `GET /v1/subscription` answers it from the backend's copy
// (docs/foundation/subscriptions.md §5.3): the Entitlement shown, where to manage it, and the stores it may buy through now.

import { API_BASE } from '../apiBase.js';
import { routeFamily } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';

const ENVIRONMENTS = new Set(['production', 'sandbox']);

const objectOrNull = (value) => value === null || (typeof value === 'object' && !Array.isArray(value));

// The body when it is a SubscriptionResponse, whose every key is always present (packages/api-contract/subscriptions);
// otherwise null.
export function readSubscription(body) {
  if (body === null || !objectOrNull(body)) return null;
  const shaped = ENVIRONMENTS.has(body.environment)
    && typeof body.allowlisted === 'boolean'
    && (body.plan === null || typeof body.plan === 'string')
    && (body.accessUntil === null || Number.isSafeInteger(body.accessUntil))
    && objectOrNull(body.governing)
    && Array.isArray(body.others)
    && objectOrNull(body.manage)
    && Array.isArray(body.purchasable) && body.purchasable.every((store) => typeof store === 'string')
    && objectOrNull(body.offer);
  return shaped ? body : null;
}

// Whether the Entitlement shown holds Windmill One at `nowMs`: a plan, until its accessUntil (§3.3).
export function holdsWindmillOne(subscription, nowMs = Date.now()) {
  return Boolean(subscription?.plan) && subscription.accessUntil !== null && nowMs < subscription.accessUntil;
}

// A static operation and a bounded reason (`server`, `shape`); never a body.
function reportSubscriptionFailure(reason) {
  const route = typeof window === 'undefined' ? '' : routeFamily(window.location);
  captureError('billing', 'billing-subscription', new Error('billing-subscription').stack, route, { reason });
}

// Null when there is nothing to show: signed out, a request lost, or a server that failed. A 5xx, or a 200 that is not a
// SubscriptionResponse, reports.
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
