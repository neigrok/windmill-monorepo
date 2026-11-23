import { track } from '../../../telemetry/beacon.js';
import { captureError } from '../../../telemetry/sentry.js';

const OTHER = 'other';
const ROUTE = '/app/gym';

// A turn's code: what the engine, the pass door or the AI service answered (Coach engine §7), or this browser's own.
const CODES = new Set(['subject_exhausted', 'free_day_exhausted', 'free_month_exhausted', 'concurrency_exhausted', 'rate_limited', 'busy',
  'paused', 'unauthenticated', 'invalid_installation', 'device_bound', 'client-update-required', 'anonymous_ai_unavailable', 'unavailable',
  'provider_unavailable', 'provider_failed', 'provider_rejected', 'accounting_unavailable', 'result_gone', 'answer-timeout', 'model-call-limit',
  'invalid_request', 'invalid-answer', 'untrusted-origin', 'unsupported-media-type', 'too_large', 'funding_required', 'conflict',
  'call_unknown', 'picture_gone', 'pass_expired', 'pass_missing', 'pass_signature', 'pass_audience', 'pass_malformed', 'stopped',
  'host-fault']);
const ABILITY_OUTCOMES = new Set(['ok', 'not-offered', 'seat-required', 'invalid-input', 'invalid-arguments', 'refused', 'load-floor',
  'result-too-large', 'coach-turn-volume', 'one-proposal', 'one-note', 'stopped', 'product-refused']);
const FAULTS = new Set(['storage', 'share', 'refusal']);
const ASK_OUTCOMES = new Set(['answered', 'cancelled', 'refused', 'failed', 'capped', 'offline', 'absent']);

// The stack of an error the turn met, with its message struck wherever it stands, so the frames reach Sentry and nothing
// said does.
function frames(error) {
  const stack = String(error?.stack ?? '');
  const message = typeof error?.message === 'string' ? error.message : '';
  return message ? stack.split(message).join('') : stack;
}

// What a turn tells (gym Coach on the AI service §11), from the engine's telemetry port and from the host: every value
// is a catalog name, a known code or a number, so no question, answer, input, result, pass or id leaves through here.
export class GymTurnTelemetry {
  constructor({ catalog, event = track, report = captureError }) {
    this.catalog = catalog;
    this.event = (name, props) => { try { event(name, props); } catch { /* telling cannot stop a turn */ } };
    this.report = (...args) => { try { report(...args); } catch { /* telling cannot stop a turn */ } };
  }

  turn({ state, seat, code, rounds, abilityCalls, refusals, answerBytes, durationMs }) {
    this.event('coach_turn', { state, seat, ...(code === null ? {} : { code: CODES.has(code) ? code : OTHER }), rounds,
      ability_calls: abilityCalls, refusals, answer_bytes: answerBytes, duration_ms: Math.round(durationMs) });
  }

  ability({ name, outcome, code }) {
    const said = outcome === 'ok' ? 'ok' : code;
    this.event('coach_ability', { name: this.catalog.ability(name) ? name : OTHER, outcome: ABILITY_OUTCOMES.has(said) ? said : OTHER });
  }

  // `ai-call`, `ai-pass` and `agent-host`, each a static operation, with the error that raised it where there is one.
  failure(operation, error) {
    this.report(error?.name ?? 'Error', operation, frames(error), ROUTE, { operation });
  }

  // A fault of gym's own around the turn: its store, a record that refused its own write, or the Share door.
  fault(kind, error) {
    const label = FAULTS.has(kind) ? kind : OTHER;
    this.report(error?.name ?? 'Error', 'gym-coach-turn', frames(error), ROUTE, { failure_kind: label });
  }

  started() { this.event('gym_ask_started', { screen: 'coach' }); }

  // How a send settled, as the lifter met it: `answered`, `cancelled`, `refused`, `failed`, `capped` (the allowance or
  // the shared capacity), `offline` or `absent` (no Coach on this server).
  asked(outcome, durationMs = null) {
    this.event('gym_ask_outcome', { screen: 'coach', outcome: ASK_OUTCOMES.has(outcome) ? outcome : OTHER,
      ...(durationMs === null ? {} : { duration_ms: Math.round(durationMs) }) });
  }
}
