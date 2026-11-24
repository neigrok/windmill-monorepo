import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Dialog } from '../../design-system';
import { useDialogFocus } from '../../design-system/feedback/Dialog.jsx';
import { t } from '../i18n/entry/index.js';
import './sync-decisions.css';

const WIDE = '(min-width: 744px)';

// A sign-in question always has words, its product's or the shell's (`ProductQuestions.signInWords`), and is the account
// decision below. A sign-out question its product words is too, unless a notice adds to it: the shell's sign-out question
// then says each notice's line, a product's `signOutNotice()` on what signing out discards from this tab, with the download
// that keeps it.
export function SyncDecisions({ question, notices = [], busy, error, onDecision, onCancel }) {
  if (!question) return null;
  if (question.words && (question.kind === 'signed-out' || notices.length === 0)) {
    return <AccountDecision question={question} busy={busy} error={error} onDecision={onDecision} onCancel={onCancel} />;
  }
  const count = question.unsent;
  return <Dialog open title={t('shell.syncDecisions.signOutTitle')} footer={<>
    <Button variant="secondary" disabled={busy} onClick={onCancel}>{t('shell.common.cancel')}</Button>
    <Button variant="secondary" disabled={busy} onClick={() => onDecision('keep')}>{count ? t('shell.syncDecisions.keep') : t('shell.auth.signOut')}</Button>
    {count > 0 && <Button variant="danger" disabled={busy} onClick={() => onDecision('discard')}>{t('shell.syncDecisions.discard')}</Button>}
  </>}>
    {count ? <p>{t('shell.syncDecisions.signOutUnsent', { count })}</p> : <p>{t('shell.syncDecisions.signOutClean')}</p>}
    {notices.map(({ line, download }) => <p key={line}>
      {line} <a href={download.href} download={download.filename} onClick={download.onDownload}>{download.label}</a>
    </p>)}
    {error && <p role="alert">{t('shell.syncDecisions.failed')}</p>}
  </Dialog>;
}

function useWide() {
  const subscribe = useCallback((changed) => {
    const query = window.matchMedia(WIDE);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  return useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => true);
}

// An account decision in its words: a title, a sentence, what the work holds and a note, over its answers. From 744px a
// dialog over the page; below, a page of its own with the answers pinned under the thumb. Focus enters on the title.
// A sign-in (consistency 7d, WD9) answers Add or Discard, of equal weight, or cancels the sign-in, as Escape does; its
// Discard asks again, in its words' `discard` (Discard all of it? where a product's words carry none), and Cancel or
// Escape there returns to the question. A sign-out (flow 50) answers Keep, or a quiet Discard, and Escape cancels it.
// Each step is told to the product (`words.onStep`): shown, the answer chosen, or cancel.
export function AccountDecision({ question, busy, error, onDecision, onCancel }) {
  const { words } = question;
  const signin = question.kind === 'signed-out';
  const [discarding, setDiscarding] = useState(false);
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
  useLayoutEffect(() => { titleRef.current?.focus(); }, [discarding]);
  const onKeyDown = useDialogFocus({ open: true, cardRef, onClose: busy ? null : discarding ? () => setDiscarding(false) : cancel });
  // Once a question: a refresh asks it again in fresh words while it stands, and a question of other work mounts anew.
  useEffect(() => { words.onStep('shown'); }, []);

  const confirm = discarding ? words.discard ?? { title: t('shell.syncDecisions.discardAll'),
    body: t('shell.syncDecisions.discardBody', { count: words.items.length }) } : null;
  const button = (key, label, variant, run) => <Button key={key} variant={variant} size="lg" full={!wide} disabled={busy} onClick={run}>{label}</Button>;
  const answers = confirm ? [
    button('cancel', t('shell.common.cancel'), 'secondary', () => setDiscarding(false)),
    button('discard', t('shell.syncDecisions.discard'), 'danger', () => answer('discard')),
  ] : signin ? [
    <span key="leave" className="wm-decision-leave">{button('leave', t('shell.syncDecisions.cancelSignIn'), 'ghost', cancel)}</span>,
    button('discard', t('shell.syncDecisions.discard'), 'secondary', () => setDiscarding(true)),
    button('add', t('shell.syncDecisions.add'), 'secondary', () => answer('add')),
  ] : [
    <span key="discard" className="wm-decision-discard">{button('discard', t('shell.syncDecisions.discard'), 'ghost', () => answer('discard'))}</span>,
    button('keep', t('shell.syncDecisions.keep'), 'primary', () => answer('keep')),
  ];
  return (
    <div className={`wm-decision wm-decision--${wide ? 'dialog' : 'page'}`}>
      <div ref={cardRef} className="wm-decision-card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="wm-decision-words">
          <h2 id={titleId} ref={titleRef} tabIndex={-1}>{confirm ? confirm.title : words.title}</h2>
          <p className="wm-decision-lead">{confirm ? confirm.body : words.lead}</p>
          {!confirm && <ul className={`wm-decision-items${words.items.some((item) => typeof item === 'object') ? ' wm-decision-items--counted' : ''}`}>
            {words.items.map((item, index) => (typeof item === 'object'
              ? <li key={index}><span className="wm-decision-item">{item.label}</span>{item.detail && <span className="wm-decision-detail">{item.detail}</span>}</li>
              : <li key={index}>{item}</li>))}
          </ul>}
          {!confirm && <p className="wm-decision-note">{words.note}</p>}
          {error && <p className="wm-decision-note" role="alert">{t('shell.syncDecisions.failed')}</p>}
        </div>
        <div className="wm-decision-answers">{wide ? answers : [...answers].reverse()}</div>
      </div>
    </div>
  );
}
