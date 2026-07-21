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
