import { CoachNavigation } from './CoachNavigation.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { Menu } from '../../../design-system/index.js';
import { ImagePlus, Square } from 'lucide-react';
import { CoachPhoto } from './CoachPhoto.jsx';
import { gymApi } from '../gymApi.js';
import { COACH_HREF, NOTES_HREF, routineHref, THREADS_HREF } from '../log.js';
import { ProposalPanel } from '../Proposals.jsx';
import './coach.css';
import { DELETE_VERB } from './threads.js';
import { coachWorkout, COACH_PLACEHOLDER, COACH_TITLE, readLine, stepsLine } from './coach.js';
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
    if (conversation.busy || conversation.pending || conversation.photoBusy || conversation.photo?.status === 'uploading') {
      log.say('Stop the current response or cancel the upload before starting a new chat.');
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
        <nav className="gym-coach-doors" aria-label="Coach">
          <a className="gym-coach-threads-door" href={THREADS_HREF}>History</a>
          <Menu label="More Coach options" items={[
            { label: 'Notes', run: () => { window.location.hash = NOTES_HREF; } },
            { label: 'Connected log', run: () => { window.location.href = '/app/connect'; } },
            { label: 'Account', run: () => { window.location.hash = '#/settings'; } },
            ...(onDelete ? [{ label: DELETE_VERB, run: onDelete }] : []),
            ...(conversation.turns.length || initialThread || conversation.closed ? [{ label: 'New chat', run: newChat }] : []),
          ]} />
        </nav>
      </header>
      <p className="gym-coach-subtitle">Reads your log · proposes only</p>
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
          }}>{conversation.olderBusy ? 'Loading…' : 'Earlier messages'}</button>}
        {conversation.olderNote && <p className="gym-coach-note" role="status">{conversation.olderNote}</p>}
        <ol className="gym-coach-thread">
          {conversation.turns.map((turn, index) => <CoachMessage key={`${turn.position ?? turn.requestId ?? index}-${turn.from}`}
            turn={turn} log={log} accountId={accountId} thread={conversation.thread} onRetry={conversation.send} busy={Boolean(log.session) || conversation.busy || conversation.pending} />)}
        </ol>
      </div>
      {latest && <button type="button" className="gym-coach-latest" onClick={() => {
        follow.current = true; setLatest(false);
        if (reading.current) reading.current.scrollTop = reading.current.scrollHeight;
      }}>Jump to latest</button>}
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
  if (log.phase === 'loading' || phase === 'loading') return <p className="gym-quiet">Opening the conversation…</p>;
  if (log.session) return <WorkoutInProgress log={log} />;

  return <>
    {note && !(note === 'Response interrupted.' && conversation.turns.at(-1)?.status === 'failed') && <p className="gym-coach-note" role="status">{note}</p>}
    {stopRequested && <p className="gym-coach-note" role="status">Stopping…</p>}
    {closed === 'thread' && <button type="button" className="gym-coach-retry" onClick={onNewChat}>New chat</button>}
    {closed === 'account' && <a className="gym-coach-proposal-door" href="#/settings">Open account</a>}
    {!closed && <>
      {photoBusy && <p className="gym-coach-note" role="status">Preparing photo…</p>}
      {photo && <div className="gym-coach-photo-draft">
        <CoachPhoto accountId={accountId} thread={thread} photo={photo} draft />
        <div className="gym-coach-photo-actions">
          {photoUpload ? <>
            <progress aria-label="Photo upload" value={photo.progress ?? 0} max={1} />
            <button type="button" className="gym-coach-retry" onClick={cancelUpload}>Cancel upload</button>
          </> : <>
            {photo.status === 'failed' && <>
              <p className="gym-coach-note" role="status">Photo didn’t upload. {photo.note}</p>
              <button type="button" className="gym-coach-retry" onClick={() => uploadPhoto()}>Retry upload</button>
            </>}
            {!request && <button type="button" className="gym-coach-retry" onClick={removePhoto}>Remove photo</button>}
          </>}
        </div>
      </div>}
      <div className="gym-coach-compose">
        <input ref={picker} className="gym-visually-hidden" type="file" accept="image/*" tabIndex={-1}
          aria-label="Choose a photo" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) selectPhoto(file);
          }} />
        <button type="button" className="gym-coach-add-photo" aria-label="Add photo"
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
          onClick={() => generating ? stop() : send()} aria-label={generating ? 'Stop response' : request ? 'Retry' : 'Send'}>
          {generating ? <Square size={18} aria-hidden="true" /> : request ? 'Retry' : 'Send'}
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
    <section className="gym-coach-workout-card" aria-label="Workout in progress">
      <p className="gym-coach-workout-kicker">Workout in progress</p>
      <p>Your workout is on your phone. This room is here when it is over.</p>
      <p className="gym-coach-workout-meta">{workout.name} · started <span>{workout.started}</span> · {workout.count}</p>
      <div className="gym-coach-workout-doors"><button type="button" onClick={viewWorkout}>View workout</button><a href={NOTES_HREF}>Notes ›</a></div>
      <p className="gym-coach-workout-meta">Notes are yours to write while you train. Nothing here reads a log that is still being written.</p>
    </section>
    <section className="gym-coach-workout-mirror" ref={mirror} tabIndex={-1} aria-label="Live workout, read only">
      <header><span>{workout.name} · in progress</span><span>{workout.progress}</span></header>
      {workout.groups.map((group) => <div className="gym-coach-mirror-movement" key={group.id}>
        <div className="gym-coach-mirror-heading"><div><h2>{group.name}</h2>{group.scheme && <p>{group.scheme}</p>}</div>
          {group.id !== workout.active && <span className="gym-coach-mirror-rail" aria-label={`${group.rows.length} sets`}>{group.rows.map((row) => <i key={row.key} className={`is-${row.kind}`} />)}</span>}
        </div>
        {group.id === workout.active && <ul>{group.rows.map((row, index) => <li key={row.key} aria-label={row.spoken} className={`is-${row.kind}${row.kind === 'target' && group.rows[index - 1]?.kind !== 'target' ? ' is-next' : ''}`}><i aria-hidden="true" /><span>{row.label}</span></li>)}</ul>}
      </div>)}
      <p className="gym-coach-workout-meta">A mirror of your phone. Nothing here logs a set.</p>
    </section>
  </div>;
}

export function CoachMessage({ turn, log, accountId, thread, onRetry, busy }) {
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
      setNotice('Message copied.');
      noticeTimer.current = setTimeout(() => { noticeTimer.current = null; setNotice(''); }, 2000);
      setOpen(false);
    } catch {
      setNotice('Couldn’t copy. Select the message text and copy it.');
    }
  };
  const receipt = turn.receipt ?? turn;
  const read = readLine(receipt.read);
  const figureText = (value) => value?.split(/([+-]?\d+(?:\.\d+)?)/).map((part, index) => index % 2 ? <span className="gym-coach-figure" key={index}>{part}</span> : part);
  const readText = figureText(read);
  const steps = stepsLine(receipt.steps);
  return <li ref={box} className={`gym-coach-turn ${turn.from === 'lifter' ? 'is-lifter' : 'is-coach'}${open ? ' is-menu-open' : ''}`}>
    {(turn.attachments ?? []).map((photo) => <CoachPhoto key={photo.id} accountId={accountId} thread={thread} photo={photo} />)}
    {turn.from !== 'lifter' && read && (steps ? <details className="gym-coach-trace">
      <summary className="gym-coach-read"><span>{readText}</span>{' '}<span className="gym-coach-step-count"><span className="gym-coach-figure">{receipt.steps?.length ?? 0}</span> {receipt.steps?.length === 1 ? 'step' : 'steps'} <span aria-hidden="true">›</span></span></summary><p className="gym-coach-steps">{steps}</p>
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
        aria-label={`Copy ${turn.from === 'lifter' ? 'your' : 'Coach'} message`} onClick={copy}
        onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); box.current?.querySelector('.gym-coach-text')?.focus(); } }}>Copy</button>
    </>}
    {turn.from !== 'lifter' && <>
      {(receipt.proposals ?? []).map((id) => <ProposalPanel key={id} id={id} log={log} inConversation />)}
      {(turn.results ?? []).filter((result) => result.kind === 'routine-created').map((result) =>
        <div key={result.operationId} className="gym-coach-result">
          <span>Routine created · {result.routineName}</span>
          <a href={routineHref(result.routineId)}>Open routine</a>
        </div>)}

      {turn.status === 'stopped' && <p className="gym-coach-note">Response stopped.</p>}
      {turn.status === 'failed' && <p className="gym-coach-note">Response interrupted.
        {turn.requestId && <button type="button" className="gym-coach-retry" disabled={busy} onClick={() => onRetry(turn)}>Retry</button>}
      </p>}
    </>}
    <span className="gym-coach-copy-notice" role="status">{notice}</span>
  </li>;
}
