import test from 'node:test';
import assert from 'node:assert/strict';

import { Refusal } from '../../../../src/products/journal/talk/refusal.js';
import { TalkError } from '../../../../src/products/journal/talk/talkApi.js';

process.env.TZ = 'UTC';

// The browser's clock decides 9:14 AM or 09:14, so each expectation is written for the clock this machine keeps, and
// with the space its ICU puts before the day half (a narrow no-break one since ICU 72).
const twelveHour = ['h11', 'h12'].includes(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle);
const half = new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h12' }).format(0).includes('\u202f') ? '\u202f' : ' ';
const resetsAtMs = Date.UTC(2026, 11, 3, 9, 14);
const retryAtMs = Date.UTC(2026, 10, 15, 14, 40);

const allowance = (code, { remaining = '0.000000000', reserved = '0.000000000', resets = resetsAtMs } = {}) => ({
  code, currency: 'USD', period: 'billing_period', tier: 'windmill_one', configured: true, limit: '7.000000000',
  used: '7.000000000', reserved, remaining, resetsAtMs: resets, budgetResetsAtMs: resets,
});

// What a person sees and can do: the sentence, the line under it, the acts with the take and without it, and when the
// tab stops remembering it; with the labels telemetry carries.
function seen(refusal) {
  return {
    face: refusal.face,
    sentence: refusal.sentence,
    detail: refusal.detail,
    acts: refusal.acts({ holding: true, signedIn: true, now: 0 }),
    bare: refusal.acts({ holding: false, signedIn: true, now: 0 }),
    until: refusal.until,
    returnsAt: refusal.returnsAt,
    code: refusal.code,
    reason: refusal.reason,
  };
}

test('every answer the voice route can give has its face, its way out and its labels', () => {
  const dated = twelveHour ? `You can use Talk again on Dec 3 at 9:14${half}AM.` : 'You can use Talk again on Dec 3 at 09:14.';
  const timed = twelveHour ? `You can use Talk again at 2:40${half}PM.` : 'You can use Talk again at 14:40.';
  const keep = ['download', 'close'];
  const again = ['retry', 'download'];
  const cases = [
    [429, { code: 'subject_exhausted', reason: 'allowance_exhausted', allowance: allowance('subject_exhausted') },
      { face: 'spent', sentence: 'You have used all of your AI allowance.', detail: dated, acts: keep, until: resetsAtMs,
        returnsAt: resetsAtMs, code: 'subject_exhausted', reason: 'allowance_exhausted' }],
    [429, { code: 'subject_exhausted', reason: 'request_exceeds_remaining',
      allowance: allowance('subject_exhausted', { remaining: '0.050000000' }) },
    { face: 'tooLittleLeft', sentence: 'A take needs more AI allowance than you have left.', detail: dated, acts: keep,
      until: resetsAtMs, returnsAt: resetsAtMs, code: 'subject_exhausted', reason: 'request_exceeds_remaining' }],
    [429, { code: 'subject_exhausted', reason: 'allowance_exhausted', allowance: allowance('subject_exhausted', { reserved: '0.060000000' }) },
      { face: 'held', sentence: 'The rest of your AI allowance is held by an earlier request whose cost is not yet confirmed.',
        detail: 'It frees when that request’s cost is confirmed, at most 10 minutes after it began.', acts: again, until: null,
        returnsAt: null, code: 'subject_exhausted', reason: 'held' }],
    [503, { code: 'concurrency_exhausted', reason: 'unavailable', allowance: allowance('concurrency_exhausted') },
      { face: 'anotherRequest', sentence: 'Your earlier AI requests hold every slot you have.',
        detail: 'Each frees when its cost is confirmed, at most 10 minutes after it began.', acts: again, until: null,
        returnsAt: null, code: 'concurrency_exhausted', reason: 'unavailable' }],
    [503, { code: 'funding_required', reason: 'unavailable', allowance: allowance('funding_required', { resets: null }) },
      { face: 'unfunded', sentence: 'Your plan has no funded AI allowance for this period.', detail: null, acts: keep,
        until: Infinity, returnsAt: null, code: 'funding_required', reason: 'unavailable' }],
    [503, { code: 'ai_accounting_unavailable', error: 'talk’s AI allowance could not be checked right now' },
      { face: 'allowanceUnavailable', sentence: 'Talk’s AI allowance is unavailable right now.', detail: null, acts: again,
        until: null, code: 'ai_accounting_unavailable', reason: 'unavailable' }],
    [503, { code: 'debt_outstanding', reason: 'unavailable', allowance: allowance('debt_outstanding') },
      { face: 'allowanceUnavailable', sentence: 'Talk’s AI allowance is unavailable right now.', detail: null, acts: again,
        until: null, code: 'debt_outstanding', reason: 'unavailable' }],
    [503, { code: 'a_code_from_tomorrow', reason: 'unavailable', allowance: allowance('a_code_from_tomorrow') },
      { face: 'allowanceUnavailable', sentence: 'Talk’s AI allowance is unavailable right now.', detail: null, acts: again,
        until: null, code: 'other', reason: 'unavailable' }],
    [429, { error: 'talk has had its turn for now' },
      { face: 'turnUsed', sentence: 'Talk has had its turn for now.', detail: 'Try again later.', acts: keep, until: null,
        code: 'status_429', reason: 'none' }],
    [429, { code: 'voice_ration_spent', error: 'talk has had its turn for now', retryAtMs },
      { face: 'turnUsed', sentence: 'Talk has had its turn for now.', detail: timed, acts: keep, until: null,
        returnsAt: retryAtMs, code: 'voice_ration_spent', reason: 'none' }],
    [403, { error: 'talk is part of Windmill One' },
      { face: 'locked', sentence: 'Talk is part of Windmill One', detail: null, acts: keep, until: null, code: 'status_403', reason: 'none' }],
    [413, { error: 'that take is too long to transcribe' },
      { face: 'tooLong', sentence: 'That take is too long to transcribe.', detail: null, acts: keep, until: null,
        code: 'status_413', reason: 'none' }],
    [502, { error: 'the transcriber could not answer' },
      { face: 'transcriberFailed', sentence: 'The transcriber could not answer.', detail: null, acts: again, until: null,
        code: 'status_502', reason: 'none' }],
    [500, {},
      { face: 'transcriberFailed', sentence: 'The transcriber could not answer.', detail: null, acts: again, until: null,
        code: 'status_500', reason: 'none' }],
    [200, {},
      { face: 'transcriberFailed', sentence: 'The transcriber could not answer.', detail: null, acts: again, until: null,
        code: 'status_200', reason: 'none' }],
    [503, { code: 'voice_busy', error: 'voice is busy right now' },
      { face: 'busy', sentence: 'Talk is busy right now.', detail: 'Try again in a moment.', acts: again, until: null,
        code: 'voice_busy', reason: 'none' }],
    [503, { code: 'voice_unavailable', error: 'voice is not available right now' },
      { face: 'notAvailable', sentence: 'Talk is not available right now.', detail: null, acts: keep, until: null,
        code: 'voice_unavailable', reason: 'none' }],
    [400, { error: 'no audio' },
      { face: 'notAvailable', sentence: 'Talk is not available right now.', detail: null, acts: keep, until: null,
        code: 'status_400', reason: 'none' }],
  ];
  for (const [status, body, expected] of cases) {
    assert.deepEqual(seen(Refusal.ofAnswer(new TalkError(status, body), { renews: true })), { returnsAt: null, ...expected, bare: ['close'] },
      `${status} ${body.code ?? ''}`);
  }
});

test('signed out mid-take, the face asks for sign-in, and offers the send again once the account is back', () => {
  const refusal = Refusal.ofAnswer(new TalkError(401, { error: 'sign in to talk' }), { renews: true });

  assert.deepEqual(seen(refusal), { face: 'signedOut', sentence: 'You’re signed out.', detail: 'Sign in, then send it again.',
    acts: ['retry', 'download'], bare: ['close'], until: null, returnsAt: null, code: 'status_401', reason: 'none' });
  assert.deepEqual(refusal.acts({ holding: true, signedIn: false, now: 0 }), ['signIn', 'download']);
});

test('no answer at all, or none in time, is the network’s face, and Try again resends', () => {
  for (const error of [new TypeError('Failed to fetch'), new DOMException('signal timed out', 'TimeoutError')]) {
    assert.deepEqual(seen(Refusal.ofAnswer(error, { renews: true })), { face: 'unreachable', sentence: 'Couldn’t reach Windmill.',
      detail: null, acts: ['retry', 'download'], bare: ['close'], until: null, returnsAt: null, code: 'unreachable', reason: 'none' });
  }
});

test('a spent allowance names its date only while the plan renews, and is remembered either way', () => {
  const answer = new TalkError(429, { code: 'subject_exhausted', reason: 'allowance_exhausted', allowance: allowance('subject_exhausted') });

  const ending = Refusal.ofAnswer(answer, { renews: false });

  assert.equal(ending.detail, null);
  assert.equal(ending.until, resetsAtMs);
  assert.equal(ending.blocks(resetsAtMs - 1), true);
  assert.equal(ending.blocks(resetsAtMs), false);
});

test('before a take, only what the tab would remember is said; everything else leaves the microphone to open', () => {
  const said = (read) => {
    const refusal = Refusal.beforeTake(read, { renews: true });
    return refusal && { face: refusal.face, detail: refusal.detail, bare: refusal.acts({ holding: false, signedIn: true, now: 0 }), until: refusal.until };
  };
  const dated = twelveHour ? `You can use Talk again on Dec 3 at 9:14${half}AM.` : 'You can use Talk again on Dec 3 at 09:14.';

  assert.equal(said(allowance('ok', { remaining: '2.000000000' })), null);
  assert.deepEqual(said(allowance('subject_exhausted')), { face: 'spent', detail: dated, bare: ['close'], until: resetsAtMs });
  assert.equal(said(allowance('subject_exhausted', { reserved: '0.060000000' })), null);
  assert.deepEqual(said(allowance('funding_required', { resets: null })), { face: 'unfunded', detail: null, bare: ['close'], until: Infinity });
  assert.equal(said(allowance('concurrency_exhausted')), null);
  assert.equal(said(allowance('debt_outstanding')), null);
  assert.equal(Refusal.beforeTake(allowance('funding_required', { resets: null }), { renews: true }).blocks(Number.MAX_SAFE_INTEGER), true);
});

// A take refused for its date waits for that date, then may go again: once the allowance resets or the day's audio
// refills, the kept take offers Try again in place of Close.
test('a take refused for its date offers Try again once the date has come', () => {
  const spent = Refusal.ofAnswer(new TalkError(429, { code: 'subject_exhausted', reason: 'allowance_exhausted',
    allowance: allowance('subject_exhausted') }), { renews: true });
  const ration = Refusal.ofAnswer(new TalkError(429, { code: 'voice_ration_spent', retryAtMs }), { renews: true });

  assert.deepEqual([resetsAtMs - 1, resetsAtMs].map((now) => spent.acts({ holding: true, signedIn: true, now })),
    [['download', 'close'], ['retry', 'download']]);
  assert.deepEqual([retryAtMs - 1, retryAtMs].map((now) => ration.acts({ holding: true, signedIn: true, now })),
    [['download', 'close'], ['retry', 'download']]);
  assert.deepEqual(ration.acts({ holding: false, signedIn: true, now: retryAtMs }), ['close']);
});
