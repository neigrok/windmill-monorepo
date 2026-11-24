import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, BookOpen, ChevronRight, CircleCheck, History as HistoryIcon, ImageOff, ImagePlus, Plus, Smartphone, Square, WifiOff } from 'lucide-react';
import { Button, Dialog, Menu, useMediaQuery } from '../../../design-system/index.js';
import { Id } from '../../../platform/domain-kit/entities.js';
import { useSyncEngine } from '../../../platform/sync/react.js';
import { CoachThread } from '../domain/coach/conversation.js';
import { Note } from '../domain/notes.js';
import { t } from '../i18n/index.js';
import { COACH_HREF, NEW_ROUTINE_ID, NOTES_HREF, routineHref, shortDayLabel, THREADS_HREF, threadHref, timeLabel } from '../log.js';
import { useDomainRead } from '../useDomainRead.js';
import { COACH_TITLE, coachWorkout } from './coach.js';
import { coachTurnsOf } from './coachTurns.js';
import { conversationView } from './conversations.js';
import { CoachProposalCard } from './CoachProposal.jsx';
import { dayWords, deleteConversation, HistoryList, useHistoryRows } from './History.jsx';
import { pictureSource, prepareCoachPicture } from './pictures.js';
import './coach.css';

const CONNECT_HREF = '/app/connect';

// The page's Coach and what it says now; Coach starts as the room first opens.
export function useCoachTurns() {
  const engine = useSyncEngine();
  const turns = useMemo(() => (engine ? coachTurnsOf(engine) : null), [engine]);
  const listen = useMemo(() => turns?.listen ?? (() => () => {}), [turns]);
  const snapshot = useSyncExternalStore(listen, () => turns?.getSnapshot() ?? null, () => null);
  // Coach starts for the seat in hand, and again for each seat that replaces it while the room is open.
  useEffect(() => { turns?.start(); }, [turns, snapshot?.seat]);
  return { turns, snapshot };
}


// Coach's tab while no account is settled (WD8.3): what Coach does and the shell's sign-in, a door rather than a room. On
// a narrow screen it stands in the reach band above the tab bar, its Sign in as wide as the column; wider, at the head of
// the reading column.
export function CoachDoor({ onSignIn }) {
  const narrow = useMediaQuery('(max-width: 800px)');
  return (
    <section className="gym-coach-door">
      <h1 className="gym-title">{COACH_TITLE}</h1>
      <p className="gym-coach-door-line">{t('gym.coach.door.line')}</p>
      <Button size={narrow ? 'lg' : 'md'} full={narrow} onClick={onSignIn}>{t('gym.coach.door.signIn')}</Button>
    </section>
  );
}

// The Coach room (08W): one conversation, or a fresh chat when `threadId` is null, with History beside it on a wide
// screen. Coach stays closed while a workout is open.
export function CoachRoom({ log, threadId = null }) {
  const { turns, snapshot } = useCoachTurns();
  const { rows, ready } = useHistoryRows(log);
  const notes = useDomainRead((read) => read.repository(Note).all('drawn').length, []);
  const running = snapshot?.turn ?? null;
  const view = useDomainRead((read) => (threadId ? conversationView(read, threadId, running?.coach ?? null) : null), [threadId, running]);
  const off = snapshot?.refusal?.state === 'off';
  const workout = log.phase !== 'ready' || Boolean(log.session);
  // A turn taken back with the conversation it opened leaves that conversation's address for the fresh chat.
  const withdrawn = snapshot?.withdrawn;
  useEffect(() => {
    if (withdrawn && withdrawn.thread === null && withdrawn.from.record === threadId) window.location.hash = COACH_HREF;
  }, [withdrawn, threadId]);

  return (
    <div className={`gym-coach-room${off ? ' is-off' : ''}`}>
      <section className={`gym-coach${workout ? ' is-workout' : ''}`}>
        <header className="gym-coach-head">
          <h1 className="gym-title">{t('gym.coach.title')}</h1>
          {!off && <nav className="gym-coach-doors" aria-label={t('gym.coach.doors')}>
            <a className="gym-coach-history-door" href={THREADS_HREF} aria-label={t('gym.coach.history.open')}><HistoryIcon size={22} aria-hidden="true" /></a>
            <Menu label={t('gym.coach.moreOptions')} items={[
              { label: t('gym.coach.notes'), run: () => { window.location.hash = NOTES_HREF; } },
              { label: t('gym.coach.connectedLog'), run: () => { window.location.href = CONNECT_HREF; } },
              { label: t('gym.coach.account'), run: () => { window.location.hash = '#/settings'; } },
              { label: t('gym.coach.newChat'), run: () => { window.location.hash = COACH_HREF; } },
              ...(threadId ? [{ label: t('gym.coach.history.delete'), run: () => deleteConversation(log, turns, threadId, true) }] : []),
            ]} />
          </nav>}
        </header>
        <p className="gym-coach-subtitle">{t('gym.coach.subtitle')}</p>
        {workout ? <WorkoutInProgress log={log} />
          : off ? <p className="gym-coach-off">{t('gym.coach.access.off')}</p>
            : <Conversation turns={turns} snapshot={snapshot} view={view} threadId={threadId} movements={log.catalog} greet={!threadId && ready && rows.length === 0} />}
      </section>
      {!off && <aside className="gym-coach-rail">
        <HistoryList rows={rows} current={threadId} onDelete={(id) => deleteConversation(log, turns, id, id === threadId)} ready={ready} />
        <nav className="gym-coach-rail-doors" aria-label={t('gym.coach.nav.label')}>
          <a href={NOTES_HREF}><span><strong>{t('gym.coach.notes')}</strong>{notes.data == null ? t('gym.coach.nav.notesHint') : t('gym.coach.nav.notesCount', { count: notes.data })}</span><ChevronRight size={18} aria-hidden="true" /></a>
          <a href={CONNECT_HREF}><span><strong>{t('gym.coach.connectedLog')}</strong>{t('gym.coach.nav.connectTools')}</span><ChevronRight size={18} aria-hidden="true" /></a>
        </nav>
      </aside>}
    </div>
  );
}

function Conversation({ turns, snapshot, view, threadId, greet, movements }) {
  const reading = useRef(null);
  const resend = useRef(null);
  const messages = view.data?.messages ?? [];
  const last = messages.at(-1);
  // The newest words stay in sight: the room scrolls with the gym's page, so the page's scroller follows them.
  useEffect(() => {
    const scroller = reading.current?.closest('.gym-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages.length, last?.text, snapshot?.live?.text, snapshot?.refusal, snapshot?.fault]);
  return <>
    <div className="gym-coach-reading" ref={reading}>
      {greet && <Greeting turns={turns} />}
      {threadId && view.phase === 'ready' && view.data === null && <p className="gym-quiet">{t('gym.threads.absent')}</p>}
      <ol className="gym-coach-thread" role="log">
        {messages.map((message, index) => {
          const stamp = index === 0 || message.at - messages[index - 1].at > 3_600_000;
          return <React.Fragment key={message.id}>
            {stamp && message.role === 'lifter' && <li className="gym-coach-stamp">{t('gym.coach.when', { day: dayWords(message.at), time: timeLabel(message.at) })}</li>}
            {message.role === 'lifter' ? <LifterMessage message={message} />
              : <CoachAnswer message={message} live={snapshot?.live?.message.record === message.id ? snapshot.live.text : null}
                stopping={snapshot?.stopping && snapshot?.turn?.coach.record === message.id} catalog={turns?.catalog} movements={movements} />}
          </React.Fragment>;
        })}
      </ol>
    </div>
    <div className="gym-coach-bottom">
      <Notice snapshot={snapshot} onRetry={() => resend.current?.()} />
      <Composer turns={turns} snapshot={snapshot} threadId={threadId} resend={resend} />
    </div>
  </>;
}

// Coach's greeting, which belongs to onboarding: it shows while the person has no conversation at all (08W.24).
function Greeting({ turns }) {
  const picker = useRef(null);
  const offers = [
    t('gym.coach.greeting.build', { lead: <strong>{t('gym.coach.greeting.buildName')}</strong> }),
    t('gym.coach.greeting.goals', { lead: <strong>{t('gym.coach.greeting.goalsName')}</strong> }),
    t('gym.coach.greeting.notes', { lead: <strong>{t('gym.coach.greeting.notesName')}</strong> }),
    t('gym.coach.greeting.changes', { lead: <strong>{t('gym.coach.greeting.changesName')}</strong> }),
  ];
  return <section className="gym-coach-greeting" aria-label={t('gym.coach.greeting.lead')}>
    <p>{t('gym.coach.greeting.lead')}</p>
    {offers.map((offer, index) => <p key={index}>{offer}</p>)}
    <div className="gym-coach-greeting-doors">
      <input ref={picker} className="gym-visually-hidden" type="file" accept="image/*" tabIndex={-1} aria-label={t('gym.coach.photo.choose')}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file || !turns) return;
          try { await sendPicture(turns, file, null); }
          catch (error) { turns.pictureFailed(error); }
        }} />
      <button type="button" className="gym-coach-pill" onClick={() => picker.current?.click()}><ImagePlus size={18} aria-hidden="true" />{t('gym.coach.greeting.addScreenshot')}</button>
      <a className="gym-coach-pill" href={routineHref(NEW_ROUTINE_ID)}><Plus size={18} aria-hidden="true" />{t('gym.coach.greeting.buildMyOwn')}</a>
    </div>
  </section>;
}

async function sendPicture(turns, file, threadId) {
  const picture = await prepareCoachPicture(file);
  turns.tells.picture('attached');
  const turn = await turns.send({ question: '', picture, thread: threadId ? new Id(threadId, CoachThread) : null });
  if (turn && !threadId) window.location.hash = threadHref(turn.thread.record);
}

function LifterMessage({ message }) {
  return <li className="gym-coach-turn is-lifter">
    {message.pictures.map((picture) => picture.copy
      ? <img key={picture.id} className="gym-coach-picture" src={pictureSource(picture.copy)} width={picture.copy.width} height={picture.copy.height} alt="" />
      : <span key={picture.id} className="gym-coach-picture-elsewhere" aria-hidden="true"><ImageOff size={20} /><Smartphone size={18} /></span>)}
    {message.text && <p className="gym-coach-bubble">{message.text}</p>}
  </li>;
}

const END_LINES = {
  declined: () => t('gym.coach.end.declined'),
  failed: () => t('gym.coach.end.failed'),
  stopped: () => t('gym.coach.end.stopped'),
  interrupted: () => t('gym.coach.end.interrupted'),
};

function CoachAnswer({ message, live, stopping, catalog, movements }) {
  const [reading, setReading] = useState(false);
  const text = live ?? message.text;
  const end = message.state === 'completed' ? (message.truncated ? t('gym.coach.end.cutShort') : null) : END_LINES[message.state]?.() ?? null;
  if (message.answering === 'elsewhere') {
    return <li className="gym-coach-turn is-coach">
      {text && <p className="gym-coach-text">{text}</p>}
      <p className="gym-coach-elsewhere"><Smartphone size={16} aria-hidden="true" />{t('gym.coach.answeringElsewhere')}<span className="gym-coach-dots" aria-hidden="true"><i /><i /><i /></span></p>
    </li>;
  }
  const steps = message.steps.filter((step) => step.ok).map((step) => catalog?.ability(step.name)?.phrase).filter(Boolean);
  return <li className="gym-coach-turn is-coach">
    {text && <p className="gym-coach-text">{text}</p>}
    {message.routines.length > 0 && <ul className="gym-coach-made" aria-label={t('gym.coach.routine.madeLabel')}>
      {message.routines.map((routine) => <li key={routine.id}><a href={routineHref(routine.id)}>
        <CircleCheck size={20} aria-hidden="true" className="gym-coach-made-check" />
        <span><strong>{routine.name}</strong>{t('gym.coach.routine.created', { count: routine.movements })}</span>
        <ArrowUpRight size={18} aria-hidden="true" />
      </a></li>)}
    </ul>}
    {message.workoutProposals.map((proposal) => <div key={proposal.id} className="gym-coach-workout-proposal">
      <Smartphone size={20} aria-hidden="true" />
      <span><strong>{t('gym.coach.workoutProposal.title')}</strong>{t('gym.coach.workoutProposal.count', { count: proposal.changes })}</span>
    </div>)}
    {end && <p className="gym-coach-end">{end}</p>}
    {message.answering === 'here'
      ? <p className="gym-coach-steps">{stopping ? t('gym.coach.stopping') : [...new Set(steps)].join(' · ')}</p>
      : message.read && <button type="button" className="gym-coach-receipt-door" onClick={() => setReading(true)}>
        <BookOpen size={16} aria-hidden="true" />{receiptWords(message.read)}<ChevronRight size={16} aria-hidden="true" />
      </button>}
    {message.proposals.map((id) => <CoachProposalCard key={id} id={id} movements={movements} />)}
    {reading && <WhatCoachRead message={message} catalog={catalog} onClose={() => setReading(false)} />}
  </li>;
}

export function receiptWords(read) {
  if (read.totalsOnly) return t('gym.coach.receipt.history');
  if (!read.sessions && !read.sets && !read.weeks) return t('gym.coach.receipt.nothing');
  if (read.thisWorkout) return t('gym.coach.receipt.thisWorkout', { weeks: read.weeks });
  return t('gym.coach.receipt.read', { sessions: read.sessions, weeks: read.weeks });
}

// What Coach read (08W.5): one row for each call of the answer, in order, as the catalog names it.
function WhatCoachRead({ message, catalog, onClose }) {
  return <Dialog open onClose={onClose} title={t('gym.coach.read.title')} className="gym-coach-read-dialog" width={480} padding="20px">
    <p className="gym-coach-read-lead">{t('gym.coach.read.lead')}</p>
    <ul className="gym-coach-read-rows">
      {message.steps.filter((step) => step.ok).map((step, index) => {
        const phrase = catalog?.ability(step.name)?.phrase ?? step.name;
        const workouts = step.read.sessions > 0;
        return <li key={index}>
          <BookOpen size={20} aria-hidden="true" />
          <span>
            <strong>{workouts ? t('gym.coach.read.workouts', { count: step.read.sessions }) : phrase.charAt(0).toUpperCase() + phrase.slice(1)}</strong>
            {step.read.weeks > 0 && <span>{step.weeks.length > 0
              ? t('gym.coach.read.span', { weeks: t('gym.coach.read.weeks', { count: step.read.weeks }),
                from: shortDayLabel(Math.min(...step.weeks)), to: shortDayLabel(Math.max(...step.weeks) + 6 * 86_400_000) })
              : t('gym.coach.read.weeks', { count: step.read.weeks })}</span>}
          </span>
        </li>;
      })}
    </ul>
    <p className="gym-coach-read-lead">{t('gym.coach.read.once')}</p>
  </Dialog>;
}

// What stands between the person and a question (Coach engine §7), said once above the composer.
function Notice({ snapshot, onRetry }) {
  if (!snapshot) return null;
  const { refusal, fault } = snapshot;
  const day = (ms) => shortDayLabel(ms);
  if (fault) {
    const words = { 'no-answer': t('gym.coach.noAnswer'), unsaved: t('gym.coach.access.unsaved'), 'account-changing': t('gym.coach.confirmingAccount'),
      picture: t('gym.coach.photo.unsupported') }[fault];
    return <div className="gym-coach-notice" role="status"><p>{words}</p></div>;
  }
  if (!refusal) return null;
  const again = <button type="button" className="gym-coach-notice-act" onClick={onRetry}>{t('gym.coach.access.tryAgain')}</button>;
  switch (refusal.state) {
    case 'busy': return <div className="gym-coach-notice" role="status"><p>{t('gym.coach.access.busy')}</p></div>;
    case 'too-long': return <div className="gym-coach-notice" role="status"><p>{t('gym.coach.tooLong')}</p></div>;
    case 'allowance': return <div className="gym-coach-notice" role="status"><p>{t('gym.coach.access.allowance')}</p>
      {refusal.resetsAt && <p className="gym-coach-notice-detail">{t('gym.coach.access.useAgain', { day: day(refusal.resetsAt), time: timeLabel(refusal.resetsAt) })}</p>}</div>;
    case 'capacity': return <div className="gym-coach-notice" role="status">
      <p>{refusal.period === 'day' ? t('gym.coach.access.day') : refusal.resetsAt ? t('gym.coach.access.monthBack', { day: day(refusal.resetsAt) }) : t('gym.coach.access.month')}</p>
      {refusal.period === 'day' && refusal.resetsAt && <p className="gym-coach-notice-detail">{t('gym.coach.access.useAgain', { day: day(refusal.resetsAt), time: timeLabel(refusal.resetsAt) })}</p>}
      <a className="gym-coach-notice-act" href={CONNECT_HREF}>{t('gym.coach.access.ownAgent')}</a></div>;
    case 'offline': return <div className="gym-coach-notice" role="status"><WifiOff size={20} aria-hidden="true" /><p>{t('gym.coach.access.offline')}</p>{again}</div>;
    case 'update': return <div className="gym-coach-notice" role="status"><p>{t('gym.coach.access.update')}</p>
      <button type="button" className="gym-coach-notice-act" onClick={() => window.location.reload()}>{t('gym.coach.access.updateVerb')}</button></div>;
    case 'sign-in': return <div className="gym-coach-notice" role="status"><p>{t('gym.coach.access.signIn')}</p>
      <a className="gym-coach-notice-act" href="#/auth">{t('gym.coach.access.signInVerb')}</a></div>;
    default: return <div className="gym-coach-notice" role="status"><p>{t('gym.coach.noAnswer')}</p>{again}</div>;
  }
}

function Composer({ turns, snapshot, threadId, resend }) {
  const picker = useRef(null);
  const [picture, setPicture] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const draft = snapshot?.draft ?? '';
  const withdrawn = snapshot?.withdrawn;
  useEffect(() => { if (withdrawn?.picture) setPicture(withdrawn.picture); }, [withdrawn]);
  const answeringHere = Boolean(snapshot?.turn);
  const closed = ['allowance', 'capacity', 'update', 'sign-in'].includes(snapshot?.refusal?.state);
  const send = async () => {
    if (!turns || answeringHere || closed || (!draft.trim() && !picture)) return;
    const sent = picture;
    setPicture(null);
    const turn = await turns.send({ question: draft.trim(), picture: sent, thread: threadId ? new Id(threadId, CoachThread) : null });
    if (!turn) { setPicture(sent); return; }
    if (!threadId) window.location.hash = threadHref(turn.thread.record);
  };
  resend.current = send;

  return <>
    {picture && <div className="gym-coach-picture-draft">
      <img className="gym-coach-picture" src={pictureSource(picture.original)} alt={t('gym.coach.photo.readyAlt')} />
      <button type="button" className="gym-coach-picture-remove" onClick={() => setPicture(null)}>{t('gym.coach.photo.remove')}</button>
    </div>}
    <div className={`gym-coach-compose${closed ? ' is-closed' : ''}`}>
      <input ref={picker} className="gym-visually-hidden" type="file" accept="image/*" tabIndex={-1} aria-label={t('gym.coach.photo.choose')}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setPreparing(true);
          try {
            setPicture(await prepareCoachPicture(file));
            turns?.tells.picture('attached');
          } catch (error) { turns?.pictureFailed(error); }
          finally { setPreparing(false); }
        }} />
      <button type="button" className="gym-coach-add-photo" aria-label={t('gym.coach.photo.add')} disabled={closed || preparing || Boolean(picture)}
        onClick={() => picker.current?.click()}><ImagePlus size={20} aria-hidden="true" /></button>
      <textarea className="gym-coach-input" value={draft} rows={1} placeholder={t('gym.coach.placeholder')} aria-label={t('gym.coach.placeholder')}
        disabled={closed} onChange={(event) => turns?.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) { event.preventDefault(); send(); }
        }} />
      {answeringHere
        ? <button type="button" className="gym-coach-stop" aria-label={t('gym.coach.stopResponse')} disabled={snapshot.stopping}
          onClick={() => turns.stop()}><Square size={14} aria-hidden="true" fill="currentColor" /></button>
        : <button type="button" className="gym-coach-send" disabled={closed || preparing || (!draft.trim() && !picture)} onClick={send}>{t('gym.coach.send')}</button>}
    </div>
  </>;
}

export function WorkoutInProgress({ log }) {
  const [showWorkout, setShowWorkout] = useState(false);
  const mirror = useRef(null);
  if (log.phase !== 'ready' || !log.session) return <p className="gym-quiet">{t('gym.coach.openingConversation')}</p>;
  const workout = coachWorkout(log.session, log.sets, log.catalog);
  const viewWorkout = () => {
    setShowWorkout(true);
    requestAnimationFrame(() => { mirror.current?.scrollIntoView({ block: 'start' }); mirror.current?.focus({ preventScroll: true }); });
  };
  return <div className={`gym-coach-workout${showWorkout ? ' is-expanded' : ''}`}>
    <section className="gym-coach-workout-card" aria-label={t('gym.coach.workoutInProgress')}>
      <p className="gym-coach-workout-kicker">{t('gym.coach.workoutInProgress')}</p>
      <p>{t('gym.coach.afterWorkout')}</p>
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
