export function receiptLine(run) {
  if (run.status === 'running') return 'Working…';
  if (run.status === 'failed') return 'Couldn’t finish';
  if (!run.summary || run.edits === 0) return 'Nothing changed';
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
  if (!run) return { kind: 'failed', line: 'Nothing changed — the tree is untouched and your sentence is still here.' };
  if (run.status === 'running') return { kind: 'working', line: 'Tending your tree…' };
  // `created` is the server-recorded set the run planted, so Undo reverts exactly its additions.
  if (run.status === 'done') return { kind: 'receipt', line: receiptLine(run), created: run.created ?? [], detail: run.detail ?? '' };
  if (run.status === 'failed') return { kind: 'failed', line: 'Nothing changed — the tree is untouched and your sentence is still here.' };
  if (run.status === 'refused') return refusalFace(run.refusal);
  return { kind: 'failed', line: 'Nothing changed — the tree is untouched.' };
}

function refusalFace(refusal) {
  if (refusal === 'rate-limited') return { kind: 'rate', line: 'That’s a lot of tending quickly. Your tree is exactly as you left it.' };
  if (refusal === 'out-of-allowance') return { kind: 'out', line: 'You’ve used this month’s tending. You can still edit by hand — nothing is gated.' };
  if (refusal === 'out-of-budget') return { kind: 'out', line: 'This account has reached its AI ceiling for the last 30 days. You can still edit by hand, and tending returns as that window rolls on.' };
  if (refusal === 'prompt-too-long') return { kind: 'long', line: 'That’s a lot at once — paste an outline instead for a whole plan.' };
  if (refusal === 'not-enabled') return { kind: 'off', line: 'Tending is off for this account.' };
  if (refusal === 'prompt-empty') return { kind: 'empty', line: '' };
  return { kind: 'failed', line: 'Nothing changed — the tree is untouched.' };
}
