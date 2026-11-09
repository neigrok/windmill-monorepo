import { CoachNavigation } from './CoachNavigation.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { Button, Menu } from '../../../design-system/index.js';
import { ImagePlus, Square } from 'lucide-react';
import { CoachPhoto } from './CoachPhoto.jsx';
import { t } from '../i18n/index.js';
import { COACH_HREF, NOTES_HREF, routineHref, THREADS_HREF } from '../log.js';
import { ProposalPanel } from '../Proposals.jsx';
import './coach.css';
import { DELETE_VERB, THREADS_TITLE } from './threads.js';
import { coachWorkout, COACH_PLACEHOLDER, COACH_TITLE, draftEntryLine, readLine, RESPONSE_INTERRUPTED, stepsLine } from './coach.js';
import { forgetCoachDraft, useCoachConversation } from './useCoachConversation.js';

export function CoachRoom({ log, accountId, initialThread, onDelete }) {
  const conversation = useCoachConversation({ accountId, initialThread, workoutInProgress: log.phase !== 'ready' || Boolean(log.session) });
  const workoutOnly = Boolean(log.session && !initialThread);
  const reading = useRef(null);
  const follow = useRef(true);
  const [latest, setLatest] = useState(false);
  useEffect(() => {
    if (follow.current && reading.current) reading.current.scrollTop = reading.current.scrollHeight;
    else if (conversation.turns.length) setLatest(true);
  }, [conversation.turns]);

  const newChat = () => {
    if (conversation.confirmBusy) {
      log.say(t('gym.coach.waitForSave'));
      return;
    }
    if (conversation.busy || conversation.pending || conversation.photoBusy || conversation.photo?.status === 'uploading') {
      log.say(t('gym.coach.stopBeforeNewChat'));
      return;
    }
    if (initialThread) {
      forgetCoachDraft(accountId);
      window.location.hash = COACH_HREF;
    } else conversation.newChat();
  };

  return (
    <section className={`gym-coach${workoutOnly ? ' is-workout' : ''}`}>
      <header className="gym-coach-head">
        <h1 className="gym-title">{COACH_TITLE}</h1>
        <nav className="gym-coach-doors" aria-label={t('gym.coach.doors')}>
          <a className="gym-coach-threads-door" href={THREADS_HREF}>{THREADS_TITLE}</a>
          <Menu label={t('gym.coach.moreOptions')} items={[
            { label: t('gym.coach.notes'), run: () => { window.location.hash = NOTES_HREF; } },
            { label: t('gym.coach.connectedLog'), run: () => { window.location.href = '/app/connect'; } },
            { label: t('gym.coach.account'), run: () => { window.location.hash = '#/settings'; } },
            ...(onDelete ? [{ label: DELETE_VERB, run: onDelete }] : []),
            ...(conversation.turns.length || initialThread || conversation.closed ? [{ label: t('gym.coach.newChat'), run: newChat }] : []),
          ]} />
        </nav>
      </header>
      <p className="gym-coach-subtitle">{t('gym.coach.subtitle')}</p>
      <CoachNavigation narrow />
      {workoutOnly ? <WorkoutInProgress log={log} /> : <>
      <div className="gym-coach-reading" ref={reading} onScroll={() => {
        const element = reading.current;
        if (!element) return;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        if (follow.current) setLatest(false);
      }}>
        {conversation.nextCursor && <button type="button" className="gym-coach-older"
          disabled={conversation.olderBusy} onClick={async () => {
            const element = reading.current;
            const height = element?.scrollHeight ?? 0;
            follow.current = false;
            await conversation.older();
            requestAnimationFrame(() => { if (element) element.scrollTop += element.scrollHeight - height; });
          }}>{conversation.olderBusy ? t('gym.coach.loading') : t('gym.coach.earlierMessages')}</button>}
        {conversation.olderNote && <p className="gym-coach-note" role="status">{conversation.olderNote}</p>}
        <ol className="gym-coach-thread">
          {conversation.turns.map((turn, index) => <CoachMessage key={`${turn.position ?? turn.requestId ?? index}-${turn.from}`}
            turn={turn} log={log} accountId={accountId} thread={conversation.thread} onRetry={conversation.send} onConfirm={conversation.confirmRoutine} confirmBusy={conversation.confirmBusy} confirmNote={conversation.confirmNote} busy={Boolean(log.session) || conversation.busy || conversation.pending} />)}
        </ol>
      </div>
      {latest && <button type="button" className="gym-coach-latest" onClick={() => {
        follow.current = true; setLatest(false);
        if (reading.current) reading.current.scrollTop = reading.current.scrollHeight;
      }}>{t('gym.coach.jumpToLatest')}</button>}
      <div className="gym-coach-bottom">
        <CoachBody log={log} accountId={accountId} conversation={conversation} onNewChat={newChat} />
      </div>
      </>}
    </section>
  );
}

export function CoachBody({ log, accountId, conversation, onNewChat }) {
  const picker = useRef(null);
  const { phase, request, busy, pending, note, closed, draft, setDraft, send, stop, photo, photoBusy,
    stopRequested, stopBusy, thread, selectPhoto, removePhoto, uploadPhoto, cancelUpload } = conversation;
  const generating = busy || pending;
  const photoUpload = photo?.status === 'uploading';
  if (log.phase === 'loading' || phase === 'loading') return <p className="gym-quiet">{t('gym.coach.openingConversation')}</p>;
  if (log.session) return <WorkoutInProgress log={log} />;

  return <>
    {note && !(note === RESPONSE_INTERRUPTED && conversation.turns.at(-1)?.status === 'failed') && <p className="gym-coach-note" role="status">{note}</p>}
    {stopRequested && <p className="gym-coach-note" role="status">{t('gym.coach.stopping')}</p>}
    {closed === 'thread' && <button type="button" className="gym-coach-retry" onClick={onNewChat}>{t('gym.coach.newChat')}</button>}
    {closed === 'account' && <a className="gym-coach-proposal-door" href="#/settings">{t('gym.coach.openAccount')}</a>}
    {!closed && <>
      {photoBusy && <p className="gym-coach-note" role="status">{t('gym.coach.photo.preparing')}</p>}
      {photo && <div className="gym-coach-photo-draft">
        <CoachPhoto accountId={accountId} thread={thread} photo={photo} draft />
        <div className="gym-coach-photo-actions">
          {photoUpload ? <>
            <progress aria-label={t('gym.coach.photo.upload')} value={photo.progress ?? 0} max={1} />
            <button type="button" className="gym-coach-retry" onClick={cancelUpload}>{t('gym.coach.photo.cancelUpload')}</button>
          </> : <>
            {photo.status === 'failed' && <>
              <p className="gym-coach-note" role="status">{t('gym.coach.photo.failed', { note: photo.note ?? '' })}</p>
              <button type="button" className="gym-coach-retry" onClick={() => uploadPhoto()}>{t('gym.coach.photo.retryUpload')}</button>
            </>}
            {!request && <button type="button" className="gym-coach-retry" onClick={removePhoto}>{t('gym.coach.photo.remove')}</button>}
          </>}
        </div>
      </div>}
      <div className="gym-coach-compose">
        <input ref={picker} className="gym-visually-hidden" type="file" accept="image/*" tabIndex={-1}
          aria-label={t('gym.coach.photo.choose')} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) selectPhoto(file);
          }} />
        <button type="button" className="gym-coach-add-photo" aria-label={t('gym.coach.photo.add')}
          disabled={Boolean(request || photo || photoBusy)} onClick={() => picker.current?.click()}><ImagePlus size={20} aria-hidden="true" /></button>
        <textarea className="gym-coach-input" value={draft} rows={2} maxLength={1000}
          placeholder={COACH_PLACEHOLDER} aria-label={COACH_PLACEHOLDER}
          readOnly={Boolean(request)} onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
              event.preventDefault();
              if (!generating && !photoUpload && !photoBusy) send();
            }
          }} />
        <button type="button" className="gym-coach-send"
          disabled={generating ? Boolean(stopBusy || stopRequested) : Boolean((!draft.trim() && !photo && !request) || photoUpload || photoBusy)}
          onClick={() => generating ? stop() : send()} aria-label={generating ? t('gym.coach.stopResponse') : request ? t('gym.coach.retry') : t('gym.coach.send')}>
          {generating ? <Square size={18} aria-hidden="true" /> : request ? t('gym.coach.retry') : t('gym.coach.send')}
        </button>
      </div>
    </>}
  </>;
}

export function WorkoutInProgress({ log }) {
  const [showWorkout, setShowWorkout] = useState(false);
  const mirror = useRef(null);
  const workout = coachWorkout(log.session, log.sets, log.catalog);
  const viewWorkout = () => {
    setShowWorkout(true);
    requestAnimationFrame(() => { mirror.current?.scrollIntoView({ block: 'start' }); mirror.current?.focus({ preventScroll: true }); });
  };
  return <div className={`gym-coach-workout${showWorkout ? ' is-expanded' : ''}`}>
    <section className="gym-coach-workout-card" aria-label={t('gym.coach.workoutInProgress')}>
      <p className="gym-coach-workout-kicker">{t('gym.coach.workoutInProgress')}</p>
      <p>{t('gym.coach.workoutOnPhone')}</p>
      <p className="gym-coach-workout-meta">{t('gym.coach.workoutMeta', { name: workout.name, started: <span>{workout.started}</span>, count: workout.count })}</p>
      <div className="gym-coach-workout-doors"><button type="button" onClick={viewWorkout}>{t('gym.coach.viewWorkout')}</button><a href={NOTES_HREF}>{t('gym.coach.notesDoor')}</a></div>
      <p className="gym-coach-workout-meta">{t('gym.coach.notesWhileTraining')}</p>
    </section>
    <section className="gym-coach-workout-mirror" ref={mirror} tabIndex={-1} aria-label={t('gym.coach.liveWorkout')}>
      <header><span>{t('gym.coach.workoutHead', { name: workout.name })}</span><span>{workout.progress}</span></header>
      {workout.groups.map((group) => <div className="gym-coach-mirror-movement" key={group.id}>
        <div className="gym-coach-mirror-heading"><div><h2>{group.name}</h2>{group.scheme && <p>{group.scheme}</p>}</div>
          {group.id !== workout.active && <span className="gym-coach-mirror-rail" aria-label={t('gym.coach.mirrorSets', { count: group.rows.length })}>{group.rows.map((row) => <i key={row.key} className={`is-${row.kind}`} />)}</span>}
        </div>
        {group.id === workout.active && <ul>{group.rows.map((row, index) => <li key={row.key} aria-label={row.spoken} className={`is-${row.kind}${row.kind === 'target' && group.rows[index - 1]?.kind !== 'target' ? ' is-next' : ''}`}><i aria-hidden="true" /><span>{row.label}</span></li>)}</ul>}
      </div>)}
      <p className="gym-coach-workout-meta">{t('gym.coach.mirrorNote')}</p>
    </section>
  </div>;
}

export function CoachMessage({ turn, log, accountId, thread, onRetry, onConfirm, confirmBusy, confirmNote, busy }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef(null);
  const hold = useRef(null);
  const origin = useRef(null);
  const box = useRef(null);
  const copyButton = useRef(null);
  const text = turn.text ?? '';
  const clearHold = () => { if (hold.current !== null) clearTimeout(hold.current); hold.current = null; };
  useEffect(() => () => { clearHold(); if (noticeTimer.current !== null) clearTimeout(noticeTimer.current); }, []);
  useEffect(() => {
    if (!open) return undefined;
    copyButton.current?.focus();
    const away = (event) => { if (!box.current?.contains(event.target)) setOpen(false); };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
      setNotice(t('gym.coach.messageCopied'));
      noticeTimer.current = setTimeout(() => { noticeTimer.current = null; setNotice(''); }, 2000);
      setOpen(false);
    } catch {
      setNotice(t('gym.coach.copyFailed'));
    }
  };
  const receipt = turn.receipt ?? turn;
  const read = readLine(receipt.read);
  const figureText = (value) => value?.split(/([+-]?\d+(?:\.\d+)?)/).map((part, index) => index % 2 ? <span className="gym-coach-figure" key={index}>{part}</span> : part);
  const readText = figureText(read);
  const steps = stepsLine(receipt.steps, { drafted: Boolean(turn.routineDrafts?.length) });
  return <li ref={box} className={`gym-coach-turn ${turn.from === 'lifter' ? 'is-lifter' : 'is-coach'}${open ? ' is-menu-open' : ''}`}>
    {(turn.attachments ?? []).map((photo) => <CoachPhoto key={photo.id} accountId={accountId} thread={thread} photo={photo} />)}
    {turn.from !== 'lifter' && read && (steps ? <details className="gym-coach-trace">
      <summary className="gym-coach-read"><span>{readText}</span>{' '}<span className="gym-coach-step-count">{t('gym.coach.stepCount', { count: receipt.steps?.length ?? 0, figure: <span className="gym-coach-figure">{receipt.steps?.length ?? 0}</span> })} <span aria-hidden="true">›</span></span></summary><p className="gym-coach-steps">{steps}</p>
    </details> : <p className="gym-coach-read">{readText}</p>)}
    {text && <>
      <p className="gym-coach-text" tabIndex={0}
        onContextMenu={(event) => { event.preventDefault(); setOpen(true); }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          clearHold();
          origin.current = { x: event.clientX, y: event.clientY };
          hold.current = setTimeout(() => { hold.current = null; setOpen(true); }, 550);
        }}
        onPointerMove={(event) => {
          if (origin.current && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) clearHold();
        }} onPointerUp={clearHold} onPointerCancel={clearHold} onPointerLeave={clearHold}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault(); setOpen(true);
          }
          if (event.key === 'Escape') setOpen(false);
        }}>{figureText(text)}</p>
      <button ref={copyButton} type="button" className="gym-coach-copy"
        aria-label={t('gym.coach.copyMessage', { from: turn.from === 'lifter' ? 'lifter' : 'coach' })} onClick={copy}
        onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); box.current?.querySelector('.gym-coach-text')?.focus(); } }}>{t('gym.coach.copy')}</button>
    </>}
    {turn.from !== 'lifter' && <>
      {(receipt.proposals ?? []).map((id) => <ProposalPanel key={id} id={id} log={log} inConversation />)}
      {(turn.routineDrafts ?? []).filter((draft) => draft.state === 'pending').map((draft) => {
        const key = `${turn.requestId}:${draft.operationId}`;
        const note = confirmNote?.key === key ? confirmNote : null;
        return <section key={draft.operationId} className="gym-coach-result gym-coach-routine-draft" aria-label={t('gym.coach.reviewDraft', { name: draft.name })}>
          <p>{t('gym.coach.reviewRoutine')}</p>
          <h2>{draft.name}</h2>
          <ul>{draft.entries.map((entry, index) => {
            const line = draftEntryLine(entry, log.catalog);
            return <li key={`${entry.exerciseId}-${index}`}><strong>{line.name}</strong><span>{line.detail}</span></li>;
          })}</ul>
          {note && <p className="gym-coach-note" role="status">{note.text}</p>}
          {!note?.closed && <Button variant="secondary" disabled={Boolean(busy || confirmBusy || !turn.requestId)}
            onClick={() => onConfirm?.(turn, draft)}>{confirmBusy === key ? t('gym.coach.saving') : t('gym.coach.saveRoutine')}</Button>}
        </section>;
      })}
      {(turn.results ?? []).filter((result) => result.kind === 'routine-created').map((result) =>
        <div key={result.operationId} className="gym-coach-result">
          <span>{t('gym.coach.routineCreated', { name: result.routineName ?? '' })}</span>
          <a href={routineHref(result.routineId)}>{t('gym.coach.openRoutine')}</a>
        </div>)}

      {turn.status === 'stopped' && <p className="gym-coach-note">{t('gym.coach.responseStopped')}</p>}
      {turn.status === 'failed' && <p className="gym-coach-note">{RESPONSE_INTERRUPTED}
        {turn.requestId && <button type="button" className="gym-coach-retry" disabled={busy} onClick={() => onRetry(turn)}>{t('gym.coach.retry')}</button>}
      </p>}
    </>}
    <span className="gym-coach-copy-notice" role="status">{notice}</span>
  </li>;
}
