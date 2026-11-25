import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight as SwapIcon, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock3, Dumbbell, List, MessagesSquare, Minus, Pencil, Plus,
  Timer,
} from 'lucide-react';
import { Button, Menu, Sheet, Tabs } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { WorkoutCoach } from '../coach/CoachRoom.jsx';
import { WeightLadder } from '../domain/units.js';
import { failureReason } from '../errors.js';
import { fixFailure } from '../fix.js';
import { useGymApi, workoutStep } from '../gymRuntime.js';
import { t } from '../i18n/index.js';
import {
  clockOf, entryLabel, loadBasisLabel, movementOf, nameOfMovement, receiptHref, receiptIdOf, recordHref, ROUTINES_HREF, timeLabel,
} from '../log.js';
import { MovementPicker } from '../logger/MovementPicker.jsx';
import { useDomainRead } from '../useDomainRead.js';
import { KG } from '../units.js';
import { EditSets } from './EditSets.jsx';
import { PopOut } from './PopOut.jsx';
import { Receipt } from './Receipt.jsx';
import { clocksAt, spokenClock, typedNumber, workoutView } from './workout.js';
import '../planning/planning.css';
import './workout.css';

// The workout page (#/gym/workout): the account's open workout on this browser's copy, whichever device started it, and
// the receipt of one it just finished. Every change is the domain's action on the copy, one write each. Coach is open
// beside it while an account is settled (WD7); signed out, Coach is left out, not greyed.
export function WorkoutPage({ hash, log, signedIn = false }) {
  const receipt = receiptIdOf(hash);
  if (receipt) return <Receipt key={receipt} id={receipt} log={log} signedIn={signedIn} />;
  return <OpenWorkout log={log} signedIn={signedIn} />;
}

// The server's time, read again on every animation frame while the tab is shown and drawn once a second: a hidden tab's
// timers slow and stop, and a clock computed from instants is right the moment the page is shown again.
function useServerNow(api) {
  const [now, setNow] = useState(() => api?.now() ?? Date.now());
  useEffect(() => {
    if (!api) return undefined;
    let frame = null;
    const tick = () => {
      const at = api.now();
      setNow((held) => (Math.floor(held / 1000) === Math.floor(at / 1000) ? held : at));
      frame = window.requestAnimationFrame(tick);
    };
    const start = () => { if (frame === null && document.visibilityState === 'visible') frame = window.requestAnimationFrame(tick); };
    const stop = () => { if (frame !== null) window.cancelAnimationFrame(frame); frame = null; };
    const flipped = () => (document.visibilityState === 'visible' ? start() : stop());
    start();
    document.addEventListener('visibilitychange', flipped);
    return () => { stop(); document.removeEventListener('visibilitychange', flipped); };
  }, [api]);
  return now;
}

// Whether the page is drawn narrow, where the rack is pinned and an edit opens in a sheet; a desk edits in place.
const NARROW = '(max-width: 799px)';
function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(NARROW);
    if (!query) return undefined;
    const changed = () => setNarrow(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  return narrow;
}

// The rest tone, best effort: a short note through Web Audio when the lifter turned sound on. A browser lets a page
// sound only after a gesture, so Log set wakes the context the tone plays through.
const tone = { context: null };
function wakeTone() {
  try {
    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (!Context) return;
    tone.context ??= new Context();
    if (tone.context.state === 'suspended') tone.context.resume();
  } catch { /* a page that cannot sound stays quiet */ }
}
function playTone() {
  try {
    const context = tone.context;
    if (!context) return;
    const at = context.currentTime, note = context.createOscillator(), level = context.createGain();
    note.frequency.value = 880;
    level.gain.setValueAtTime(0.0001, at);
    level.gain.exponentialRampToValueAtTime(0.2, at + 0.01);
    level.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
    note.connect(level).connect(context.destination);
    note.start(at);
    note.stop(at + 0.3);
  } catch { /* a page that cannot sound stays quiet */ }
}

// The rows a tab draws are written once as the workout stands, and a second tab finds them settled. A settle that fails
// (the runtime reports it) is tried again after 1, 2, 4, 8 and 16 s and then every 30 s, and at once whenever the workout
// moves; true while one has failed and the rows still wait, so Log set can say why it is held.
const SETTLE_RETRY_CAP_MS = 30_000;
function useSettledRack(api, ready, view) {
  const key = view ? `${view.id}:${view.latestSetId}:${view.movements.length}` : null;
  const due = ready && view !== null && !view.settled;
  const [failed, setFailed] = useState({ key: null, times: 0 });
  const running = useRef(false);
  const times = failed.key === key ? failed.times : 0;
  const sessionId = view?.id ?? null;
  useEffect(() => {
    if (!due || running.current) return undefined;
    const timer = setTimeout(() => {
      running.current = true;
      api.settleRack(sessionId)
        .then(() => setFailed({ key: null, times: 0 }))
        .catch(() => setFailed({ key, times: times + 1 }))
        .finally(() => { running.current = false; });
    }, times === 0 ? 0 : Math.min(SETTLE_RETRY_CAP_MS, 1000 * 2 ** (times - 1)));
    return () => clearTimeout(timer);
  }, [api, due, key, times, sessionId, view]);
  return due && times > 0;
}

// The rest reached, once per rest (iOS 03.21): the tab the sync engine leads from, drawing the workout, tells it and sounds
// the tone at the instant the rest comes to its target. A browser has one leading tab at a time, and the engine hands the
// lead to a tab on screen whenever one is, so two tabs tell it once and a browser whose tabs are all hidden still tells it,
// as late as the browser slows a hidden tab's timers. A rest that came to its target before this tab drew it is not told.
function useRestTold(api, view) {
  const due = view && view.restSeconds !== null && view.lastSetAt !== null ? view.lastSetAt + view.restSeconds * 1000 : null;
  const setId = view?.latestSetId ?? null;
  const told = useRef(null);
  const alerts = useRef({ sound: false, haptic: false });
  alerts.current = { sound: Boolean(view?.sound), haptic: Boolean(view?.haptic) };
  useEffect(() => {
    if (!api || due === null || told.current === setId) return undefined;
    const wait = due - api.now();
    if (wait <= 0) return undefined;
    const timer = setTimeout(() => {
      if (!api.leads()) return;
      told.current = setId;
      workoutStep('gym_rest_target_reached', { screen: 'workout' });
      if (alerts.current.sound) playTone();
      if (alerts.current.haptic) navigator.vibrate?.(10);
    }, wait);
    return () => clearTimeout(timer);
  }, [api, due, setId]);
}

function OpenWorkout({ log, signedIn }) {
  const api = useGymApi();
  const narrow = useNarrow();
  const read = useDomainRead(workoutView);
  const view = read.data;
  const now = useServerNow(api);
  const [panel, setPanel] = useState(null);
  const [index, setIndex] = useState(false);
  // Coach over the workout (WD7.1): the rail's Coach tab on a desk, a sheet on a phone; closing it leaves the rack as it was.
  const [coach, setCoach] = useState(false);
  const [firstClosed, setFirstClosed] = useState(false);
  const leaving = useRef(false);
  const ready = Boolean(api?.ready) && read.phase === 'ready';
  const rackWaiting = useSettledRack(api, ready, view);
  useRestTold(api, view);

  // Leaving the page with the workout still open hides it: it keeps running, and the bar over the rail brings it back.
  const open = Boolean(view);
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => () => {
    if (openNow.current && !leaving.current) workoutStep('gym_hidden_workout', { action: 'hide' });
  }, []);

  const clocks = view ? clocksAt(view, now) : null;

  const select = useCallback(async (exerciseId) => {
    if (!view || exerciseId === view.movement?.exerciseId) return;
    try { await api.turnRack(view.id, { movement: exerciseId }); }
    catch (error) { log.say(error.sentence ?? t('gym.workout.rackUnchanged', { reason: failureReason(error) })); }
  }, [api, view, log]);
  const step = useCallback((by) => {
    if (!view) return;
    const at = view.movements.findIndex((each) => each.inHand);
    const target = view.movements[at + by];
    if (target) select(target.exerciseId);
  }, [view, select]);

  useEffect(() => {
    const keyed = (event) => {
      if (panel || index || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, dialog, [role="menu"], [role="dialog"]')) return;
      if (event.key === 'ArrowLeft') step(-1);
      if (event.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', keyed);
    return () => window.removeEventListener('keydown', keyed);
  }, [panel, index, step]);

  if (!ready) return <p className="gym-quiet">{t('gym.workout.opening')}</p>;
  if (!view) {
    return (
      <section className="gym-live is-closed">
        <Back href={ROUTINES_HREF}>{t('gym.workout.routines')}</Back>
        <p className="gym-quiet">{t('gym.workout.noneOpen')}</p>
      </section>
    );
  }

  const name = view.name ?? t('gym.workout.untitled');
  const finish = async () => {
    leaving.current = true;
    try {
      await api.finishWorkout(view.id);
      window.location.hash = receiptHref(view.id);
    } catch (error) {
      leaving.current = false;
      log.say(error.sentence ?? t('gym.workout.notFinished', { reason: failureReason(error) }));
    }
  };
  const revise = async (edits, base = view.plan) => {
    await api.reviseWorkout(view.id, base, edits);
    setPanel(null);
  };
  const add = async (exerciseId) => {
    try {
      if (view.plan === null) await api.turnRack(view.id, { adding: exerciseId });
      else await revise([{ kind: 'addMovement', exerciseId }]);
      setPanel(null);
    } catch (error) { log.say(error.sentence ?? t('gym.workout.notAdded', { reason: failureReason(error) })); }
  };
  const swap = async (exerciseId) => {
    const at = view.plan?.entries.findIndex((entry) => entry.exerciseId === panel.exerciseId) ?? -1;
    try { await revise([...panel.edits ?? [], { kind: 'swap', index: at, exerciseId }], panel.base ?? view.plan); }
    catch (error) { log.say(error.sentence ?? t('gym.workout.notSwapped', { reason: failureReason(error) })); }
  };
  const movementName = (exerciseId) => nameOfMovement(log.catalog, exerciseId);
  // An empty workout asks for its first movement (WD1.3); closed, it stays open and empty, Add movement its way on.
  const picking = panel?.kind === 'add' || panel?.kind === 'swap' || (view.movements.length === 0 && panel === null && !firstClosed);
  const pickerTitle = panel?.kind === 'swap' ? t('gym.workout.swapTitle', { movement: movementName(panel.exerciseId) }) : t('gym.workout.addMovement');
  const close = () => { setPanel(null); setFirstClosed(true); };
  // The movements and Add movement: the index beside the pane on a desk, a sheet on a phone.
  const movementList = (
    <>
      <ul className="gym-live-movements">
        {view.movements.map((movement) => (
          <li key={movement.exerciseId}>
            <button type="button" className={`gym-live-movement${movement.inHand ? ' is-current' : ''}`}
              aria-current={movement.inHand ? 'true' : undefined}
              onClick={() => { setIndex(false); setPanel(null); select(movement.exerciseId); }}>
              <span className="gym-live-movement-words">
                <span className="gym-live-movement-name">{movementName(movement.exerciseId)}</span>
                {movement.entry && <span className="gym-live-movement-scheme">{entryLabel(movement.entry)}</span>}
              </span>
              <SetRail ticks={movement.ticks} />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="gym-live-add" onClick={() => { setIndex(false); setPanel({ kind: 'add' }); }}>
        <Plus size={16} aria-hidden="true" /> {t('gym.workout.addMovement')}
      </button>
    </>
  );
  const thisWorkout = <p className="gym-live-tab"><span>{t('gym.workout.thisWorkout')}</span></p>;
  // On a desk the rail's Tabs switch This workout to Coach, whose panel stands beside the rack (WD7.1 · 1440).
  const side = coach ? 'coach' : 'workout';
  const rail = (
    <div className="gym-live-index">
      {signedIn ? <Tabs variant="line" id="gym-live-side" value={side} onChange={(chosen) => setCoach(chosen === 'coach')}
        tabs={[{ value: 'workout', label: t('gym.workout.thisWorkout') }, { value: 'coach', label: t('gym.coach.title') }]} /> : thisWorkout}
      <div className={`gym-live-side is-${side}`}
        {...(signedIn ? { role: 'tabpanel', id: `gym-live-side-${side}-panel`, 'aria-labelledby': `gym-live-side-${side}` } : {})}>
        {coach ? <WorkoutCoach log={log} /> : <nav className="gym-live-index-card" aria-label={t('gym.workout.thisWorkout')}>{movementList}</nav>}
      </div>
    </div>
  );
  // The picker, or Edit sets: in the task pane on a desk, a sheet on a phone.
  const panelBody = (
    <>
      {picking && (
        <PickerPanel log={log} title={pickerTitle} taken={view.movements.map((movement) => movement.exerciseId)}
          onPick={panel?.kind === 'swap' ? swap : add} onClose={close} />
      )}
      {panel?.kind === 'edit' && (
        <EditSets key={panel.exerciseId} view={view} exerciseId={panel.exerciseId} log={log} movementName={movementName}
          onRevise={revise} onSwap={(edits, base) => setPanel({ kind: 'swap', exerciseId: panel.exerciseId, edits, base })}
          onClose={() => setPanel(null)} />
      )}
    </>
  );
  // Pop out's Log set: the set the rack offers, as the rack would log it.
  const logOffered = async () => {
    if (!view.offer || !view.rack) return;
    loggedHere.add(view.offer);
    try { await api.logSet(view.id, { offer: view.offer, weightKg: view.rack.weightKg, reps: view.rack.reps }); }
    catch (error) { log.say(error.code === 'stale' ? t('gym.workout.stale') : error.sentence ?? t('gym.workout.notLogged', { reason: failureReason(error) })); }
  };

  return (
    <section className={`gym-live${panel || picking ? ' has-panel' : ''}`} aria-labelledby="gym-live-title">
      <span className="gym-live-back"><Back href={ROUTINES_HREF}>{t('gym.workout.routines')}</Back></span>
      <header className="gym-live-head">
        <span className="gym-live-tools">
          <a className="gym-live-tool" href={ROUTINES_HREF} aria-label={t('gym.workout.hide')}><ChevronDown size={18} aria-hidden="true" /></a>
          <button type="button" className="gym-live-tool" aria-label={t('gym.workout.thisWorkout')} aria-expanded={index}
            onClick={() => setIndex(true)}><ClipboardList size={18} aria-hidden="true" /></button>
          {signedIn && <button type="button" className="gym-live-tool" aria-label={t('gym.coach.title')} aria-expanded={coach}
            onClick={() => setCoach(true)}><MessagesSquare size={18} aria-hidden="true" /></button>}
        </span>
        <span className="gym-live-titles">
          <h1 id="gym-live-title" className="gym-title">{name}</h1>
          <span className="gym-live-started">{t('gym.workout.started', { time: timeLabel(view.startedAt) })}</span>
        </span>
        <span className="gym-live-actions">
          <PopOut view={view} name={name} movementName={movementName} catalog={log.catalog} onLog={logOffered}>
            <Clocks view={view} clocks={clocks} />
          </PopOut>
          <span className="gym-live-finish"><Button variant="secondary" size={narrow ? 'sm' : 'md'} onClick={finish}>{t('gym.workout.finish')}</Button></span>
        </span>
      </header>
      <div className="gym-live-split">
        {narrow ? index && (
          <Sheet label={t('gym.workout.thisWorkout')} onClose={() => setIndex(false)}><div className="gym-live-index-card">{thisWorkout}{movementList}</div></Sheet>
        ) : rail}
        {narrow && coach && (
          <Sheet label={t('gym.coach.title')} detent="large" onClose={() => setCoach(false)} className="gym-live-coach-sheet">
            <WorkoutCoach log={log} onClose={() => setCoach(false)} />
          </Sheet>
        )}
        <div className="gym-live-pane">
          {view.movement && (
            <InHand view={view} clocks={clocks} log={log} api={api} movementName={movementName} onStep={step} onSelect={select}
              onPanel={setPanel} waiting={rackWaiting} />
          )}
          {(panel || picking) && (narrow
            ? <Sheet label={panel?.kind === 'edit' ? t('gym.workout.editSets') : pickerTitle} onClose={close} className="gym-live-panel-sheet">{panelBody}</Sheet>
            : <div className="gym-live-panel">{panelBody}</div>)}
        </div>
      </div>
    </section>
  );
}

function PickerPanel({ log, title, taken, onPick, onClose }) {
  const [query, setQuery] = useState('');
  return <MovementPicker pane catalog={log.catalog} order={taken} sessions={log.summaries} query={query} onQuery={setQuery}
    onPick={onPick} onCreate={log.createMovement} onClose={onClose} title={title} />;
}

// One tick a set: landed, in hand or to come (Gym / Set tick).
function SetRail({ ticks }) {
  if (ticks.length === 0) return null;
  return <span className="gym-live-rail" aria-hidden="true">{ticks.map((tick, at) => <i key={at} className={`is-${tick}`} />)}</span>;
}

// The movement in hand: its head, which is its menu, the clocks, its ledger and the rack.
function InHand({ view, clocks, log, api, movementName, onStep, onSelect, onPanel, waiting }) {
  const movement = view.movement;
  const name = movementName(movement.exerciseId);
  const at = view.movements.indexOf(movement);
  const swipe = useRef(null);
  const swiped = {
    onPointerDown: (event) => { swipe.current = event.clientX; },
    onPointerUp: (event) => {
      if (swipe.current === null) return;
      const by = event.clientX - swipe.current;
      swipe.current = null;
      if (Math.abs(by) > 60) onStep(by < 0 ? 1 : -1);
    },
  };
  const items = [
    ...(movement.editable ? [
      { label: t('gym.workout.editSets'), icon: <List size={16} aria-hidden="true" />, run: () => onPanel({ kind: 'edit', exerciseId: movement.exerciseId }) },
      { label: t('gym.workout.swapMovement'), icon: <SwapIcon size={16} aria-hidden="true" />, run: () => onPanel({ kind: 'swap', exerciseId: movement.exerciseId }) },
    ] : []),
    { label: t('gym.workout.addMovement'), icon: <Plus size={16} aria-hidden="true" />, run: () => onPanel({ kind: 'add' }) },
    { label: t('gym.workout.editMovement'), icon: <Pencil size={16} aria-hidden="true" />, run: () => { window.location.hash = recordHref(movement.exerciseId); } },
  ];
  return (
    <div className="gym-live-hand">
      <div className="gym-live-movement-head" {...swiped}>
        <button type="button" className="gym-live-step" aria-label={t('gym.workout.previous')} disabled={at <= 0} onClick={() => onStep(-1)}>
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <Menu label={t('gym.workout.movementMenu', { movement: name })} items={items}
          trigger={<><Dumbbell size={18} aria-hidden="true" /><span className="gym-live-movement-title">{name}</span><ChevronDown size={16} aria-hidden="true" /></>} />
        <button type="button" className="gym-live-step" aria-label={t('gym.workout.nextMovement')} disabled={at >= view.movements.length - 1} onClick={() => onStep(1)}>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>
      {view.movements.length > 1 && (
        <span className="gym-live-dots">
          {view.movements.map((each, place) => (
            <button key={each.exerciseId} type="button" aria-current={each.inHand ? 'true' : undefined}
              aria-label={t('gym.workout.position', { movement: movementName(each.exerciseId), position: place + 1, total: view.movements.length })}
              onClick={() => onSelect(each.exerciseId)} />
          ))}
        </span>
      )}
      <Clocks view={view} clocks={clocks} />
      <Ledger view={view} log={log} api={api} name={name} swiped={swiped} />
      {view.next && (
        <button type="button" className="gym-live-next" onClick={() => onSelect(view.next.exerciseId)}>
          {t('gym.workout.next', { movement: movementName(view.next.exerciseId) })} <ChevronRight size={16} aria-hidden="true" />
        </button>
      )}
      <Rack view={view} log={log} api={api} exercise={movementOf(log.catalog, movement.exerciseId)} waiting={waiting} />
    </div>
  );
}

// The facts row (Gym / Workout / Clocks): the workout's clock leads; once a set lands, the rest's clock and its target.
function Clocks({ view, clocks }) {
  const target = view.restSeconds === null ? null : clockOf(view.restSeconds * 1000);
  return (
    <div className={`gym-live-clocks${clocks.reached ? ' is-reached' : ''}`}>
      <time className="gym-live-clock" aria-label={t('gym.workout.workoutClock', { duration: spokenClock(clocks.workoutMs) })}>
        <Clock3 size={16} aria-hidden="true" /><span aria-hidden="true">{clockOf(clocks.workoutMs)}</span>
      </time>
      {clocks.sinceMs !== null && (
        <time className="gym-live-since" aria-label={target === null ? t('gym.workout.sinceClock', { duration: spokenClock(clocks.sinceMs) })
          : t('gym.workout.sinceClockTarget', { duration: spokenClock(clocks.sinceMs), target: spokenClock(view.restSeconds * 1000) })}>
          <Timer size={16} aria-hidden="true" />
          <span className="gym-live-since-value" aria-hidden="true">{clockOf(clocks.sinceMs)}</span>
          {target !== null && <span className="gym-live-target" aria-hidden="true">{t('gym.workout.target', { target })}</span>}
        </time>
      )}
    </div>
  );
}

// The movement's sets (Gym / Workout / Ledger row): a logged row is a button that corrects it in place on a desk and in a
// sheet on a phone; a set that lands from elsewhere settles in brand-soft, one logged here lifts.
function Ledger({ view, log, api, name, swiped }) {
  const narrow = useNarrow();
  const [fixing, setFixing] = useState(null);
  const latest = useRef(view.latestSetId);
  const [landed, setLanded] = useState(null);
  useEffect(() => {
    if (view.latestSetId === latest.current) return undefined;
    latest.current = view.latestSetId;
    if (view.latestSetId === null) return undefined;
    setLanded({ id: view.latestSetId, here: loggedHere.has(view.latestSetId) });
    const timer = setTimeout(() => setLanded(null), 1200);
    return () => clearTimeout(timer);
  }, [view.latestSetId]);
  const fix = async (set, values) => {
    try {
      await api.fixSet(view.id, set.id, values);
      return null;
    } catch (error) { return fixFailure(error); }
  };
  const remove = (set) => {
    setFixing(null);
    log.holdDelete({ kind: 'set', id: set.id, refused: (error) => log.say(t('gym.workout.notDeleted', { reason: failureReason(error) })) });
  };
  const hidden = log.hidden('set');
  const rows = view.ledger.filter((row) => row.kind !== 'logged' || !hidden.has(row.set.id));
  return (
    <>
      <ol className="gym-live-ledger" {...swiped}>
        {rows.map((row) => {
          const arriving = landed && row.set?.id === landed.id ? (landed.here ? ' is-landed' : ' is-arrived') : '';
          if (row.kind === 'logged' && fixing?.id === row.set.id && !narrow) {
            return <li key={row.key} className="gym-live-row is-editing"><FixInPlace set={row.set} ordinal={row.ordinal} name={name}
              exercise={movementOf(log.catalog, view.movement.exerciseId)} onSave={fix} onDelete={remove} onClose={() => setFixing(null)} /></li>;
          }
          if (row.kind === 'logged') {
            return (
              <li key={row.key} className={`gym-live-row is-logged${arriving}`}>
                <button type="button" aria-label={t('gym.workout.loggedRow', { ordinal: row.ordinal, reading: row.reading })} onClick={() => setFixing(row.set)}>
                  <span className="gym-live-ordinal">{row.ordinal}</span>
                  <span className="gym-live-reading">{row.reading}</span>
                  <Check size={16} aria-hidden="true" />
                </button>
              </li>
            );
          }
          return (
            <li key={row.key} className={`gym-live-row is-${row.kind}`}
              aria-label={t('gym.workout.openRow', { kind: row.kind, ordinal: row.ordinal, reading: row.reading })}>
              <span className="gym-live-ordinal" aria-hidden="true">{row.ordinal}</span>
              <span className="gym-live-reading" aria-hidden="true">{row.reading}</span>
              {row.kind === 'current' && <i className="gym-live-in-hand" aria-hidden="true" />}
              {row.kind === 'open' && <Plus size={16} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      {fixing && narrow && <FixSheet set={fixing} name={name} ordinal={view.ledger.find((row) => row.set?.id === fixing.id)?.ordinal ?? 1}
        exercise={movementOf(log.catalog, view.movement.exerciseId)} onSave={fix} onDelete={remove} onClose={() => setFixing(null)} />}
    </>
  );
}

// The offers this tab logged, so the row a set lands in lifts when it was logged here and settles in brand-soft when it
// came from elsewhere.
const loggedHere = new Set();

const shownLoad = (weightKg) => String(WeightLadder.round(weightKg));

// Fix set on a desk (WD2.3): the row as two fields, load then reps, and ×. Enter or leaving the row saves, Escape puts it
// back; a refusal keeps what was typed and says why under the row.
function FixInPlace({ set, ordinal, name, exercise, onSave, onDelete, onClose }) {
  const [load, setLoad] = useState(shownLoad(set.weightKg));
  const [reps, setReps] = useState(String(set.reps));
  const [refusal, setRefusal] = useState(null);
  const row = useRef(null);
  const save = async () => {
    const weightKg = typedNumber(load), count = typedNumber(reps);
    if (weightKg === null || count === null) { setRefusal(t('gym.workout.checkSet')); return; }
    const refused = await onSave(set, { weightKg, reps: count });
    if (refused) { setRefusal(refused); row.current?.querySelector('input')?.focus(); return; }
    onClose();
  };
  return (
    <div ref={row} className="gym-live-fix" role="group" aria-label={t('gym.workout.fixRow', { ordinal, movement: name })}
      onBlur={(event) => { if (!row.current?.contains(event.relatedTarget)) save(); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); save(); }
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      }}>
      <span className="gym-live-ordinal">{ordinal}</span>
      <input className="gym-num" inputMode="decimal" autoFocus value={load} onChange={(event) => { setRefusal(null); setLoad(event.target.value); }}
        aria-label={t('gym.workout.loadIn', { basis: loadBasisLabel(exercise, set.weightKg, KG) })} aria-invalid={Boolean(refusal)}
        style={{ '--gym-number-chars': Math.max(2, load.length) }} onFocus={(event) => event.currentTarget.select()} />
      <span className="gym-number-times" aria-hidden="true">×</span>
      <input className="gym-num" inputMode="numeric" value={reps} onChange={(event) => { setRefusal(null); setReps(event.target.value); }}
        aria-label={t('gym.workout.reps')} style={{ '--gym-number-chars': Math.max(2, reps.length) }} onFocus={(event) => event.currentTarget.select()} />
      <button type="button" className="gym-live-fix-delete" aria-label={t('gym.workout.deleteSet')} onMouseDown={(event) => event.preventDefault()}
        onClick={() => onDelete(set)}>×</button>
      {refusal && <p className="gym-live-refusal" role="alert">{refusal}</p>}
    </div>
  );
}

// Fix set on a phone (WD2.3): a sheet with Cancel and Save in its head, the load over the reps, and Delete set last.
function FixSheet({ set, name, ordinal, exercise, onSave, onDelete, onClose }) {
  const [load, setLoad] = useState(shownLoad(set.weightKg));
  const [reps, setReps] = useState(set.reps);
  const [typedReps, setTypedReps] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const stepReps = (by) => {
    const from = typedReps === null ? reps : countOf(typedReps) ?? reps;
    setTypedReps(null);
    setReps(WeightLadder.bumpReps(from, by));
  };
  const save = async (event) => {
    event.preventDefault();
    const weightKg = typedNumber(load);
    const count = typedReps === null ? reps : countOf(typedReps);
    if (weightKg === null || count === null) { setRefusal(t('gym.workout.checkSet')); return; }
    const refused = await onSave(set, { weightKg, reps: count });
    if (refused) { setRefusal(refused); return; }
    onClose();
  };
  return (
    <Sheet label={t('gym.workout.fixTitle')} onClose={onClose} className="gym-live-sheet">
      <form className="gym-live-sheet-form" onSubmit={save}>
        <header className="gym-live-sheet-head">
          <button type="button" onClick={onClose}>{t('gym.common.cancel')}</button>
          <span><strong>{t('gym.workout.fixTitle')}</strong><small>{t('gym.workout.fixSubtitle', { ordinal, movement: name })}</small></span>
          <button type="submit" className="is-save">{t('gym.workout.save')}</button>
        </header>
        <label className="gym-live-sheet-load">
          <input inputMode="decimal" autoFocus value={load} onChange={(event) => { setRefusal(null); setLoad(event.target.value); }}
            aria-label={t('gym.workout.loadIn', { basis: loadBasisLabel(exercise, set.weightKg, KG) })} onFocus={(event) => event.currentTarget.select()} />
          <span aria-hidden="true">{loadBasisLabel(exercise, set.weightKg, KG)}</span>
        </label>
        <RepsStepper reps={reps} typed={typedReps} onType={setTypedReps} onReps={setReps} onStep={stepReps} />
        {refusal && <p className="gym-live-refusal" role="alert">{refusal}</p>}
        <button type="button" className="gym-live-sheet-delete" onClick={() => onDelete(set)}>{t('gym.workout.deleteSet')}</button>
      </form>
    </Sheet>
  );
}

const countOf = (text) => {
  const count = typedNumber(text);
  return count !== null && Number.isInteger(count) && count >= 1 ? count : null;
};

// The reps stepper: − and + step the count at once (`onStep`); what is typed stays the field's until it lets go.
function RepsStepper({ reps, typed, onType, onReps, onStep, onKeyDown }) {
  const shown = typed ?? String(reps);
  const land = () => {
    if (typed === null) return;
    const count = countOf(typed);
    onType(null);
    if (count !== null && count !== reps) onReps(count);
  };
  return (
    <span className="gym-live-reps">
      <button type="button" aria-label={t('gym.workout.fewerReps')} onMouseDown={(event) => event.preventDefault()} onClick={() => onStep(-1)}>
        <Minus size={18} aria-hidden="true" />
      </button>
      <label>
        <input type="number" inputMode="numeric" min="1" value={shown} aria-label={t('gym.workout.reps')} onKeyDown={onKeyDown}
          onChange={(event) => onType(event.target.value)} onBlur={land} />
        <span aria-hidden="true">{t('gym.workout.repsUnit', { count: countOf(shown) ?? reps })}</span>
      </label>
      <button type="button" aria-label={t('gym.workout.moreReps')} onMouseDown={(event) => event.preventDefault()} onClick={() => onStep(1)}>
        <Plus size={18} aria-hidden="true" />
      </button>
    </span>
  );
}

// The rack (Gym / Workout / Rack): a form whose submit is Log set. The load numeral is the field; what is typed stays the
// field's until it lets go, so a set landing from elsewhere never changes it under the lifter's fingers, and Log set logs
// what the field shows: pressing Log set keeps the field's focus, so what it holds is logged rather than first written to
// the rack. Enter, a phone keyboard's done key, lands what a field holds and lets it go without logging (iOS 03.23D.4):
// only Log set logs. The ladder and the stepper step the rack's row at once, every tab drawing it: from what is typed
// while something is, and otherwise from the row as it stands when the step is written, so two tabs stepping together
// both count. `waiting` says Log set is held while the rows this tab drew could not be written.
function Rack({ view, log, api, exercise, waiting }) {
  const [typed, setTyped] = useState(null);
  const [typedReps, setTypedReps] = useState(null);
  const [busy, setBusy] = useState(false);
  const rack = view.rack;
  const shown = typed ?? shownLoad(rack.weightKg);
  const basis = loadBasisLabel(exercise, rack.weightKg, KG);
  const turn = async (change) => {
    try { await api.turnRack(view.id, change); }
    catch (error) { log.say(error.sentence ?? t('gym.workout.rackUnchanged', { reason: failureReason(error) })); }
  };
  // What was typed stays drawn until the rack holds it, so the field never shows the old load in between.
  const land = () => {
    if (typed === null) return;
    const weightKg = typedNumber(typed);
    if (weightKg === null || weightKg === rack.weightKg) { setTyped(null); return; }
    turn({ weightKg }).finally(() => setTyped(null));
  };
  const stepLoad = (direction, big = false) => {
    const from = typed === null ? null : typedNumber(typed);
    setTyped(null);
    turn(from === null ? { stepLoad: { direction, big } } : { weightKg: WeightLadder.bump(from, direction, big) });
  };
  const stepReps = (direction) => {
    const from = typedReps === null ? null : countOf(typedReps);
    setTypedReps(null);
    turn(from === null ? { stepReps: direction } : { reps: WeightLadder.bumpReps(from, direction) });
  };
  const keyed = (event, step) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    step(event.key === 'ArrowUp' ? 1 : -1);
  };
  const logSet = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (busy || !view.offer) return;
    if (view.sound) wakeTone();
    const weightKg = typed === null ? rack.weightKg : typedNumber(typed);
    const reps = typedReps === null ? rack.reps : countOf(typedReps);
    if (weightKg === null || reps === null) { log.say(t('gym.workout.checkSet')); return; }
    setBusy(true);
    try {
      const offer = view.offer;
      loggedHere.add(offer);
      await api.logSet(view.id, { offer, weightKg, reps });
      setTyped(null);
      setTypedReps(null);
      if (form.contains(document.activeElement)) document.activeElement.blur();
    } catch (error) {
      log.say(error.code === 'stale' ? t('gym.workout.stale') : error.sentence ?? t('gym.workout.notLogged', { reason: failureReason(error) }));
    } finally { setBusy(false); }
  };
  return (
    <form className="gym-live-rack" onSubmit={logSet}
      onMouseDown={(event) => { if (event.target.closest?.('button[type="submit"]')) event.preventDefault(); }}>
      <label className="gym-live-load">
        <input inputMode="decimal" enterKeyHint="done" value={shown} aria-label={t('gym.workout.loadIn', { basis })}
          style={{ '--gym-load-chars': Math.max(1, shown.length) }}
          onFocus={(event) => { const input = event.currentTarget; window.requestAnimationFrame?.(() => { if (document.activeElement === input) input.select(); }); }}
          onChange={(event) => setTyped(event.target.value)} onBlur={land} onKeyDown={(event) => keyed(event, stepLoad)} />
        <span className="gym-live-basis" aria-hidden="true">{basis}</span>
      </label>
      <span className="gym-live-ladder">
        {WeightLadder.labels(rack.weightKg).map((label, at) => (
          <button key={at} type="button" aria-label={t('gym.workout.stepLoad', { step: label, basis })} onMouseDown={(event) => event.preventDefault()}
            onClick={() => stepLoad(at < 2 ? -1 : 1, at === 0 || at === 3)}>
            {label}
          </button>
        ))}
      </span>
      <RepsStepper reps={rack.reps} typed={typedReps} onType={setTypedReps} onReps={(reps) => turn({ reps })} onStep={stepReps}
        onKeyDown={(event) => keyed(event, stepReps)} />
      <Button type="submit" size="lg" full held={!view.offer || busy} ariaBusy={busy}>{t('gym.workout.logSet')}</Button>
      {waiting && <p className="gym-live-rack-waiting" role="status">{t('gym.workout.rackWaiting')}</p>}
    </form>
  );
}
