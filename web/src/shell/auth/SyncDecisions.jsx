import React, { useState } from 'react';
import { Button, Dialog } from '../../design-system';
import { t } from '../i18n/index.js';

// `work` is the asking product's `sync.signedOutWork`: the record type a sign-in question counts, its
// counted phrase (`counted(3)` is "3 pages") and its plural noun (`many`).
export function SyncDecisions({ question, work, busy, error, onDecision, onCancel }) {
  const [discarding, setDiscarding] = useState(false);
  if (!question) return null;
  const signin = question.kind === 'signed-out';
  const held = signin ? question.count[work.type] ?? 0 : 0;
  const pending = question.pending ?? 0;
  const count = signin ? signedOutCount(work, held, pending) : question.unsent;
  return <Dialog open title={signin ? (discarding ? t('shell.syncDecisions.discardTitle', { work: count }) : t('shell.syncDecisions.addTitle')) : t('shell.syncDecisions.signOutTitle')} footer={<>
    {signin && !discarding && <>
      <Button variant="secondary" disabled={busy} onClick={() => onDecision('add')}>{t('shell.syncDecisions.add')}</Button>
      <Button variant="secondary" disabled={busy} onClick={() => setDiscarding(true)}>{t('shell.syncDecisions.discard')}</Button>
    </>}
    {signin && discarding && <>
      <Button variant="secondary" disabled={busy} onClick={() => setDiscarding(false)}>{t('shell.common.cancel')}</Button>
      <Button variant="danger" disabled={busy} onClick={() => onDecision('discard')}>{t('shell.syncDecisions.discard')}</Button>
    </>}
    {!signin && <>
      <Button variant="secondary" disabled={busy} onClick={onCancel}>{t('shell.common.cancel')}</Button>
      <Button variant="secondary" disabled={busy} onClick={() => onDecision('keep')}>{count ? t('shell.syncDecisions.keep') : t('shell.auth.signOut')}</Button>
      {count > 0 && <Button variant="danger" disabled={busy} onClick={() => onDecision('discard')}>{t('shell.syncDecisions.discard')}</Button>}
    </>}
  </>}>
    {signin ? discarding
      ? <p>{t('shell.syncDecisions.discardBody')}</p>
      : <p>{t('shell.syncDecisions.addBody', { work: count, total: held + pending, existing: work.many })}</p>
      : count ? <p>{t('shell.syncDecisions.signOutUnsent', { count })}</p>
        : <p>{t('shell.syncDecisions.signOutClean')}</p>}
    {error && <p role="alert">{t('shell.syncDecisions.failed')}</p>}
  </Dialog>;
}

function signedOutCount(work, held, pending) {
  const kept = held || !pending ? work.counted(held) : null;
  const unsaved = pending ? t('shell.syncDecisions.unsaved', { count: pending }) : null;
  if (kept && unsaved) return t('shell.syncDecisions.keptAndUnsaved', { kept, unsaved });
  return kept ?? unsaved;
}
