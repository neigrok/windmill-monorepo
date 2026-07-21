// The pure presentation of a tend run and its meter — the settings package's testable seam, kept
// out of the React component so the honest-word logic can be asserted directly.

// The receipt line a run shows in the ledger: the summary when it did something, an honest word
// when it didn't or couldn't. Refusals never reach here — the ledger only lists runs that spent
// allowance, so a `refused` run is already filtered out server-side.
export function receiptLine(run) {
  if (run.status === 'running') return 'Working…';
  if (run.status === 'failed') return 'Couldn’t finish';
  if (!run.summary || run.edits === 0) return 'Nothing changed';
  return run.summary;
}

// The meter fill as a percentage, floored at 0 and capped at 100 — an account somehow over its
// limit reads as a full bar, never an overflowing one.
export function meterPct(used, limit) {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

// A run has reached rest once it is anything but `running` — the poll stops here and reads the face.
export function isTerminal(run) {
  return !!run && run.status !== 'running';
}

// The quiet face a finished or refused run wears in the composer — guidelines/tending.md §6/§9. A
// fact and a next step, never a wall, never a spinner. `kind` drives the visual register; `line` is
// the copy; `undo` marks a receipt whose edits are worth the revert button.
export function runFace(run) {
  if (!run) return { kind: 'failed', line: 'Nothing changed — the tree is untouched and your sentence is still here.' };
  if (run.status === 'running') return { kind: 'working', line: 'Tending your tree…' };
  if (run.status === 'done') return { kind: 'receipt', line: receiptLine(run), undo: run.edits > 0 };
  if (run.status === 'failed') return { kind: 'failed', line: 'Nothing changed — the tree is untouched and your sentence is still here.' };
  if (run.status === 'refused') return refusalFace(run.refusal);
  return { kind: 'failed', line: 'Nothing changed — the tree is untouched.' };
}

// The four honest refusal faces (§6): each a fact and a way forward, and out-of-allowance points at
// hand editing rather than a paywall. `empty` is the no-op of a blank submit — nothing to say.
function refusalFace(refusal) {
  if (refusal === 'rate-limited') return { kind: 'rate', line: 'That’s a lot of tending quickly. Your tree is exactly as you left it.' };
  if (refusal === 'out-of-allowance') return { kind: 'out', line: 'You’ve used this month’s tending. You can still edit by hand — nothing is gated.' };
  if (refusal === 'prompt-too-long') return { kind: 'long', line: 'That’s a lot at once — paste an outline instead for a whole plan.' };
  if (refusal === 'not-enabled') return { kind: 'off', line: 'Tending is off for this account.' };
  if (refusal === 'prompt-empty') return { kind: 'empty', line: '' };
  return { kind: 'failed', line: 'Nothing changed — the tree is untouched.' };
}
