import React, { useState } from 'react';
import { Button, Dialog } from '../../design-system';

const kinds = { page: 'page', session: 'workout', routine: 'routine', weighin: 'weigh-in', exercise: 'movement', note: 'note', tree: 'tree' };
export function decisionCounts(count) {
  return Object.entries(count).filter(([kind, n]) => n && !['journalState', 'preferences', 'routineEntry', 'set', 'gymState'].includes(kind))
    .map(([kind, n]) => `${n} ${kinds[kind] ?? kind}${n === 1 ? '' : 's'}`).join(' · ');
}

export function SyncDecisions({ question, busy, error, onDecision, onCancel }) {
  const [discarding, setDiscarding] = useState(false);
  if (!question) return null;
  const signin = question.kind === 'signed-out';
  const count = signin ? decisionCounts(question.count) : question.unsent;
  const owned = { journal: 'pages', gym: 'training', roadmap: 'trees' }[question.product];
  return <Dialog open title={signin ? (discarding ? `Discard ${count}?` : 'Add to your account?') : 'Sign out?'} footer={<>
    {signin && !discarding && <>
      <Button variant="secondary" disabled={busy} onClick={() => onDecision('add')}>Add</Button>
      <Button variant="secondary" disabled={busy} onClick={() => setDiscarding(true)}>Discard</Button>
    </>}
    {signin && discarding && <>
      <Button variant="secondary" disabled={busy} onClick={() => setDiscarding(false)}>Cancel</Button>
      <Button variant="danger" disabled={busy} onClick={() => onDecision('discard')}>Discard</Button>
    </>}
    {!signin && <>
      <Button variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button variant="secondary" disabled={busy} onClick={() => onDecision('keep')}>{count ? 'Keep' : 'Sign out'}</Button>
      {count > 0 && <Button variant="danger" disabled={busy} onClick={() => onDecision('discard')}>Discard</Button>}
    </>}
  </>}>
    {signin ? discarding
      ? <p>They never reached an account, and deleting them from this device can’t be undone.</p>
      : <p>{count} from before you signed in are only on this device, and your account already has {owned}. Add them, or discard them for good.</p>
      : count ? <p>{count === 1 ? "1 change hasn’t" : `${count} changes haven’t`} been confirmed by your account yet. Keep {count === 1 ? 'it' : 'them'} on this device until you sign back in, or discard {count === 1 ? 'it' : 'them'} from this device. Everything else is in your account and leaves this device.</p>
        : <p>Your pages and log stay in your account and leave this device.</p>}
    {error && <p role="alert">Couldn’t finish just now. Your changes are still here. Try again when connected.</p>}
  </Dialog>;
}
