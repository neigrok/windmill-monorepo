import { t } from '../i18n/index.js';

export function receiptLine(run) {
  if (run.status === 'running') return t('roadmap.tend.working');
  if (run.status === 'failed') return t('roadmap.tend.couldNotFinish');
  if (!run.summary || run.edits === 0) return t('roadmap.tend.nothingChanged');
  return run.summary;
}

export function meterPct(used, limit) {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

export function isTerminal(run) {
  return !!run && run.status !== 'running';
}

// `kind` drives the visual register, `line` is the copy.
export function runFace(run) {
  if (!run) return { kind: 'failed', line: t('roadmap.tend.untouchedSentenceKept') };
  if (run.status === 'running') return { kind: 'working', line: t('roadmap.tend.updating') };
  // `created` is the server-recorded set the run planted, so Undo reverts exactly its additions.
  if (run.status === 'done') return { kind: 'receipt', line: receiptLine(run), created: run.created ?? [], detail: run.detail ?? '' };
  if (run.status === 'failed') return { kind: 'failed', line: t('roadmap.tend.untouchedSentenceKept') };
  if (run.status === 'refused') return refusalFace(run.refusal);
  return { kind: 'failed', line: t('roadmap.tend.untouched') };
}

function refusalFace(refusal) {
  if (refusal === 'rate-limited') return { kind: 'rate', line: t('roadmap.tend.rateLimited') };
  if (refusal === 'out-of-allowance') return { kind: 'out', line: t('roadmap.tend.outOfAllowance') };
  if (refusal === 'out-of-budget') return { kind: 'out', line: t('roadmap.tend.outOfBudget') };
  if (refusal === 'prompt-too-long') return { kind: 'long', line: t('roadmap.tend.promptTooLong') };
  if (refusal === 'not-enabled') return { kind: 'off', line: t('roadmap.tend.notEnabled') };
  if (refusal === 'prompt-empty') return { kind: 'empty', line: '' };
  return { kind: 'failed', line: t('roadmap.tend.untouched') };
}
