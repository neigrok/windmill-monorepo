import { API_BASE } from '../apiBase.js';
import { routeFamily } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';

const TIERS = new Set(['anonymous', 'logged_in', 'windmill_one']);
const PERIODS = new Set(['lifetime', 'calendar_month_utc', 'billing_period']);

function isDecimalString(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Number(value));
}

export function readAllowance(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const shaped = typeof body.currency === 'string' && body.currency.length > 0
    && TIERS.has(body.tier)
    && PERIODS.has(body.period)
    && typeof body.configured === 'boolean'
    && isDecimalString(body.remaining)
    && (body.limit === null || isDecimalString(body.limit))
    && (body.resetsAtMs === null || body.resetsAtMs === undefined || Number.isSafeInteger(body.resetsAtMs));
  return shaped ? body : null;
}

function reportAllowanceFailure(reason) {
  const route = typeof window === 'undefined' ? '' : routeFamily(window.location);
  captureError('billing', 'allowance.read', new Error('allowance.read').stack, route, { reason });
}

export async function fetchAllowance(report = reportAllowanceFailure) {
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/ai/allowance`, { credentials: 'include' });
  } catch {
    return { status: 'error', allowance: null };
  }
  const body = await response.json().catch(() => null);
  if (response.status === 503 && body?.code === 'ai_allowance_disabled') {
    return { status: 'disabled', allowance: null };
  }
  if (response.status >= 500) {
    report('server');
    return { status: 'error', allowance: null };
  }
  if (!response.ok) {
    return { status: 'error', allowance: null };
  }
  const allowance = readAllowance(body);
  if (!allowance) {
    report('shape');
    return { status: 'error', allowance: null };
  }
  if (!allowance.configured || allowance.limit === null) {
    return { status: 'error', allowance: null };
  }
  return { status: 'ready', allowance };
}
