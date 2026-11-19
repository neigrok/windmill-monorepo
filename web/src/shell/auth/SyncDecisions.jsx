import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Dialog } from '../../design-system';
import { useDialogFocus } from '../../design-system/feedback/Dialog.jsx';
import { t } from '../i18n/entry/index.js';
import './sync-decisions.css';

const WIDE = '(min-width: 744px)';

// `work` is the asking product's `sync.signedOutWork`: its record type, `counted(3)` ("3 pages") and plural noun `many`.
// `notices` are the products' `signOutNotice()` answers: a line on what signing out discards from this tab, and the
// download that keeps it. A question whose product words it (`question.words`) is the account decision below, but for a
// sign-out that a notice would add to, which keeps the shell's words and the notice's download.
export function SyncDecisions({ question, work, notices = [], busy, error, onDecision, onCancel }) {
  const [discarding, setDiscarding] = useState(false);
  if (!question) return null;
  const signin = question.kind === 'signed-out';
  if (question.words && (signin || notices.length === 0)) {
    return <AccountDecision question={question} busy={busy} error={error} onDecision={onDecision} onCancel={onCancel} />;
  }
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
    {!signin && notices.map(({ line, download }) => <p key={line}>
      {line} <a href={download.href} download={download.filename} onClick={download.onDownload}>{download.label}</a>
    </p>)}
    {error && <p role="alert">{t('shell.syncDecisions.failed')}</p>}
  </Dialog>;
}

function signedOutCount(work, held, pending) {
  const kept = held || !pending ? work.counted(held) : null;
  const unsaved = pending ? t('shell.syncDecisions.unsaved', { count: pending }) : null;
  if (kept && unsaved) return t('shell.syncDecisions.keptAndUnsaved', { kept, unsaved });
  return kept ?? unsaved;
}

function useWide() {
  const subscribe = useCallback((changed) => {
    const query = window.matchMedia(WIDE);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  return useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => true);
}

// A sign-in or sign-out question in its product's words (flow 50 draws roadmap's): a title, a sentence, the names of what
// the work changes and a note, over the shell's two answers, a quiet Discard and the answer that keeps the work. From
// 744px a dialog over the page; below, a page of its own with the answers pinned under the thumb. Focus enters on the
// title, Escape cancels without discarding, and each step is told to the product (`words.onStep`): shown, the answer
// chosen, or cancel.
export function AccountDecision({ question, busy, error, onDecision, onCancel }) {
  const { words } = question;
  const signin = question.kind === 'signed-out';
  const wide = useWide();
  const cardRef = useRef(null);
  const titleRef = useRef(null);
  const titleId = useId();
  const cancel = () => {
    words.onStep('cancel');
    onCancel();
  };
  const answer = (choice) => {
    words.onStep(choice);
    onDecision(choice);
  };
  useLayoutEffect(() => { titleRef.current?.focus(); }, []);
  const onKeyDown = useDialogFocus({ open: true, cardRef, onClose: busy ? null : cancel });
  // Once a question: a refresh asks it again in fresh words while it stands, and a question of other work mounts anew.
  useEffect(() => { words.onStep('shown'); }, []);

  const kept = signin ? 'add' : 'keep';
  const answers = [
    <span key="discard" className="wm-decision-discard">
      <Button variant="ghost" size="lg" full={!wide} disabled={busy} onClick={() => answer('discard')}>{t('shell.syncDecisions.discard')}</Button>
    </span>,
    <Button key={kept} size="lg" full={!wide} disabled={busy} onClick={() => answer(kept)}>
      {signin ? t('shell.syncDecisions.add') : t('shell.syncDecisions.keep')}
    </Button>,
  ];
  return (
    <div className={`wm-decision wm-decision--${wide ? 'dialog' : 'page'}`}>
      <div ref={cardRef} className="wm-decision-card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="wm-decision-words">
          <h2 id={titleId} ref={titleRef} tabIndex={-1}>{words.title}</h2>
          <p className="wm-decision-lead">{words.lead}</p>
          <ul className="wm-decision-items">{words.items.map((item, index) => <li key={index}>{item}</li>)}</ul>
          <p className="wm-decision-note">{words.note}</p>
          {error && <p className="wm-decision-note" role="alert">{t('shell.syncDecisions.failed')}</p>}
        </div>
        <div className="wm-decision-answers">{wide ? answers : [...answers].reverse()}</div>
      </div>
    </div>
  );
}
