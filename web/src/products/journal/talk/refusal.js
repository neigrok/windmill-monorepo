// Why Talk said no, the way the sheet says it: one sentence, when Talk is back where a date brings it back, and what the
// person can do with the take it kept. The sentences are Coach's own for the same allowance codes, with Talk's name.

import { APP_LOCALE } from '../../../platform/i18n/index.js';
import { TalkError } from './talkApi.js';
import { t } from '../i18n/index.js';

// What each face says, and the two acts it offers while it holds a take.
const FACES = {
  spent: { sentence: t('journal.talk.refused.spent'), acts: ['download', 'close'] },
  tooLittleLeft: { sentence: t('journal.talk.refused.tooLittleLeft'), acts: ['download', 'close'] },
  held: { sentence: t('journal.talk.refused.held'), acts: ['retry', 'download'] },
  anotherRequest: { sentence: t('journal.talk.refused.anotherRequest'), acts: ['retry', 'download'] },
  unfunded: { sentence: t('journal.talk.refused.unfunded'), acts: ['download', 'close'] },
  allowanceUnavailable: { sentence: t('journal.talk.refused.allowanceUnavailable'), acts: ['retry', 'download'] },
  turnUsed: { sentence: t('journal.talk.refused.turnUsed'), acts: ['download', 'close'] },
  signedOut: { sentence: t('journal.talk.refused.signedOut'), acts: ['signIn', 'download'] },
  locked: { sentence: t('journal.talk.locked'), acts: ['download', 'close'] },
  tooLong: { sentence: t('journal.talk.refused.tooLong'), acts: ['download', 'close'] },
  transcriberFailed: { sentence: t('journal.talk.refused.transcriberFailed'), acts: ['retry', 'download'] },
  busy: { sentence: t('journal.talk.refused.busy'), acts: ['retry', 'download'] },
  notAvailable: { sentence: t('journal.talk.refused.notAvailable'), acts: ['download', 'close'] },
  unreachable: { sentence: t('journal.talk.refused.unreachable'), acts: ['retry', 'download'] },
};

// The AI allowance's codes (backend/AI_ALLOWANCES.md), and the ledger failing to answer.
const LEDGER_CODES = new Set(['subject_exhausted', 'free_month_exhausted', 'free_day_exhausted', 'concurrency_exhausted',
  'funding_required', 'device_bound', 'debt_outstanding', 'unconfigured', 'ai_accounting_unavailable']);
// The voice route's own codes.
const VOICE_CODES = new Set(['voice_busy', 'voice_unavailable', 'voice_ration_spent']);

// The browser's zone and its clock — 9:14 AM or 09:14 — around English words.
function clock() {
  const { hourCycle } = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
  return new Intl.DateTimeFormat(APP_LOCALE, { hour: 'numeric', minute: '2-digit', hourCycle });
}

function againOn(ms) {
  const day = new Intl.DateTimeFormat(APP_LOCALE, { month: 'short', day: 'numeric' }).format(ms);
  return t('journal.talk.again.on', { day, time: clock().format(ms) });
}

function againAt(ms) {
  return t('journal.talk.again.at', { time: clock().format(ms) });
}

export class Refusal {
  // `code` and `reason` are bounded labels for telemetry. `until` is the moment a remembered refusal stops holding the
  // mic shut — Infinity for the rest of the tab — or null for one that is not remembered.
  constructor({ face, code, reason = 'none', detail = null, until = null }) {
    this.face = face;
    this.code = code;
    this.reason = reason;
    this.detail = detail;
    this.until = until;
  }

  get sentence() {
    return FACES[this.face].sentence;
  }

  // The face's two acts while it holds a take, and Close alone once there is no take to act on. Signed out, it asks
  // for sign-in; signed back in, it offers the send again.
  acts({ holding, signedIn }) {
    if (!holding) return ['close'];
    return FACES[this.face].acts.map((act) => (act === 'signIn' && signedIn ? 'retry' : act));
  }

  // A refusal only a date lifts is remembered by the tab, and until then a press opens it without opening the mic.
  blocks(now) {
    return this.until !== null && now < this.until;
  }

  // What the transcribe route answered, or the fetch's own error when nothing did. `renews` decides whether a spent
  // allowance names the date it comes back: a plan that ends then brings nothing back.
  static ofAnswer(error, { renews }) {
    if (!(error instanceof TalkError)) return new Refusal({ face: 'unreachable', code: 'unreachable' });
    const { status, body } = error;
    const code = body.code ?? '';
    if (LEDGER_CODES.has(code) || body.allowance) return ofAllowance(body.allowance, code, body.reason, renews);
    const known = VOICE_CODES.has(code) ? code : code ? 'other' : `status_${status}`;
    if (status === 401) return new Refusal({ face: 'signedOut', code: known, detail: t('journal.talk.again.afterSignIn') });
    if (status === 403) return new Refusal({ face: 'locked', code: known });
    if (status === 413) return new Refusal({ face: 'tooLong', code: known });
    if (status === 429) {
      return new Refusal({ face: 'turnUsed', code: known,
        detail: body.retryAtMs ? againAt(body.retryAtMs) : t('journal.talk.again.later') });
    }
    if (code === 'voice_busy') return new Refusal({ face: 'busy', code: known, detail: t('journal.talk.again.inAMoment') });
    if (code === 'voice_unavailable' || status < 500) return new Refusal({ face: 'notAvailable', code: known });
    return new Refusal({ face: 'transcriberFailed', code: known });
  }

  // The allowance as the ledger reads it when the sheet opens. Only a refusal the tab would remember is said before a
  // take, so no take is made that cannot be written down; everything else is left to the take's own answer.
  static beforeTake(allowance, { renews }) {
    if (allowance.code === 'ok') return null;
    const refusal = ofAllowance(allowance, allowance.code, null, renews);
    return refusal.until === null ? null : refusal;
  }
}

// A ledger code, read with the allowance object the route sends beside it. A spent allowance is back at its period's
// end; a take too large for what is left needs the same reset, as every take holds the same amount. A spent allowance
// still holding something may free up when that request settles.
function ofAllowance(allowance, code, reason, renews) {
  const known = LEDGER_CODES.has(code) ? code : 'other';
  const resetsAt = allowance?.resetsAtMs ?? null;
  const dated = { detail: renews && resetsAt ? againOn(resetsAt) : null, until: resetsAt ?? Infinity };
  if (code === 'subject_exhausted') {
    if (reason === 'request_exceeds_remaining' || Number(allowance?.remaining) > 0) {
      return new Refusal({ face: 'tooLittleLeft', code: known, reason: 'request_exceeds_remaining', ...dated });
    }
    if (Number(allowance?.reserved) > 0) {
      return new Refusal({ face: 'held', code: known, reason: 'held', detail: t('journal.talk.again.whenFinished') });
    }
    return new Refusal({ face: 'spent', code: known, reason: 'allowance_exhausted', ...dated });
  }
  if (code === 'concurrency_exhausted') {
    return new Refusal({ face: 'anotherRequest', code: known, reason: 'unavailable', detail: t('journal.talk.again.whenFinished') });
  }
  if (code === 'funding_required') return new Refusal({ face: 'unfunded', code: known, reason: 'unavailable', until: Infinity });
  return new Refusal({ face: 'allowanceUnavailable', code: known, reason: 'unavailable' });
}
