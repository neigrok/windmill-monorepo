import React, { useState } from 'react';
import { Button, Dialog } from '../../design-system';

// `work` is the asking product's `sync.signedOutWork`: the record type a sign-in question counts, in its nouns.
export function SyncDecisions({ question, work, busy, error, onDecision, onCancel }) {
  const [discarding, setDiscarding] = useState(false);
  if (!question) return null;
  const signin = question.kind === 'signed-out';
  const held = signin ? question.count[work.type] ?? 0 : 0;
  const pending = question.pending ?? 0;
  const count = signin ? [held || !pending ? `${held} ${held === 1 ? work.one : work.many}` : null,
    pending ? `${pending} unsaved ${pending === 1 ? 'change' : 'changes'}` : null].filter(Boolean).join(' and ') : question.unsent;
  const singular = held + pending === 1;
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
      : <p>{count} from before you signed in {singular ? 'is' : 'are'} only on this device, and your account already has {work.many}. Add {singular ? 'it' : 'them'}, or discard {singular ? 'it' : 'them'} for good.</p>
      : count ? <p>{count === 1 ? "1 change hasn’t" : `${count} changes haven’t`} been confirmed by your account yet. Keep {count === 1 ? 'it' : 'them'} on this device until you sign back in, or discard {count === 1 ? 'it' : 'them'} from this device. Everything else is in your account and leaves this device.</p>
        : <p>Your pages and log stay in your account and leave this device.</p>}
    {error && <p role="alert">Couldn’t finish just now. Your changes are still here. Try again when connected.</p>}
  </Dialog>;
}
