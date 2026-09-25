import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { failureReason, gymApi } from '../gymApi.js';
import {
  BACKFILL_HREF, backfillHref, FREE_SESSION, FROM_PICK, FROM_ROUTINE_MENU, isFinished, lastTrainedDayLabel, movementOf, nameOfMovement,
  NEW_ROUTINE_ID, NO_ROUTINE, routineHref, routineSizeLabel, ROUTINES_HREF, sessionHref, shortDayLabel,
} from '../log.js';
import { MovementPicker } from '../logger/MovementPicker.jsx';
import { mintId } from '../mint.js';
import { SESSION_DELETED } from '../review.js';
import { useGymRead } from '../useGymRead.js';
import { UNDO_LABEL } from '../withheld.js';
import {
  alreadySavedLine, collapses, discardedLine, draftFromRoutine, freeDraft, importOf, inTheLogLine, isOverLimit,
  isReady, movementLine, movementSkippedLine, savedLabel, saveLabel, SET_LIMIT_LINE, sourceCaption, targetLine,
  valueLabel, withMovementAdded, withMovementAt, withMovementRemoved, withSetAdded, withSetRemoved, withValueSet,
} from './draft.js';
import { EditableNumber } from './EditableNumber.jsx';
import {
  busySpans, chosenSlot, crossedRefusal, DAY_CHIPS, dayChipOf, dayNameOf, DEFAULT_MINUTES, defaultSlot,
  DURATION_CHIPS, refusalOf, slotNote, TIME_NEEDED, todayOf, yesterdayOf,
} from './slot.js';

const LOG_BACK = { href: '#/gym/log', label: 'The log' };
const PICK_BACK = { href: BACKFILL_HREF, label: 'Past workout' };
const ROUTINES_BACK = { href: ROUTINES_HREF, label: 'Routines' };

// A row's two numbers: the cell each is typed into, and the set field it writes.
const CELLS = [
  { field: 'load', key: 'weightKg', spoken: 'load in kg' },
  { field: 'reps', key: 'reps', spoken: 'reps' },
];

// The beats: `Saved` stands before the session opens, a removed row collapses, carried numerals lift in turn.
const SAVED_MS = 900;
const LEAVE_MS = 180;
const LIFT_STAGGER_MS = 40;

// `Saved` keeps the button's own fill: it is a readout of what landed, not a Save that is waiting.
function saveClass(inert, landed) {
  if (landed) return 'gym-save-do is-saved';
  if (inert) return 'gym-save-do is-inert';
  return 'gym-save-do';
}

// `target` is what the hash names after `#/gym/backfill`: nothing for the routine pick, `free` for
// a workout with no routine, a routine's id for its filled form. `from` is where the form was opened.
export function Backfill({ target, from = FROM_PICK, log }) {
  if (target === null) return <RoutinePick log={log} />;
  if (target === FREE_SESSION) return <PastWorkout opening={freeDraft()} back={PICK_BACK} log={log} />;
  return <RoutineWorkout id={target} back={from === FROM_ROUTINE_MENU ? ROUTINES_BACK : PICK_BACK} log={log} />;
}

function RoutinePick({ log }) {
  const view = useGymRead(() => gymApi.routines(), []);
  const hidden = log.hidden('routine');

  if (view.phase === 'loading') return <ScreenNote back={LOG_BACK}>Opening your routines…</ScreenNote>;
  if (view.phase === 'failed') return <ReadFailed back={LOG_BACK} onRetry={view.retry}>The routines didn’t load.</ReadFailed>;

  const program = view.data
    .filter((routine) => !hidden.has(routine.id))
    .sort((left, right) => left.position - right.position);
  if (program.length === 0) return <PastWorkout opening={freeDraft()} back={LOG_BACK} log={log} noRoutines />;
  return (
    <>
      <header className="gym-past-top">
        <Back href={LOG_BACK.href}>{LOG_BACK.label}</Back>
        <h1 className="gym-title">Add a past workout</h1>
      </header>
      <ul className="gym-index">
        {program.map((routine) => (
          <li key={routine.id}>
            <a className="gym-index-row" href={backfillHref(routine.id)}>
              <span className="gym-index-head">
                <span className="gym-index-name">{routine.name}</span>
                <span className="gym-index-when">{lastTrainedDayLabel(routine)}</span>
              </span>
              <span className="gym-index-facts">{routineSizeLabel(routine)}</span>
            </a>
          </li>
        ))}
      </ul>
      <a className="gym-index-free" href={backfillHref(FREE_SESSION)}>+ Free session</a>
    </>
  );
}

// Two reads, then the rack's prefill: the routine names its movements, and each movement's last time
// is read in parallel before one pure pass fills every set. A last time that did not answer leaves
// that movement to its target, and claims nothing about its history.
function RoutineWorkout({ id, back, log }) {
  const view = useGymRead(async () => {
    const routine = await gymApi.routine(id);
    if (!routine) return null;
    const movements = [...new Set(routine.entries.map((entry) => entry.exerciseId))];
    const replies = await Promise.all(movements.map((exerciseId) => gymApi.lastTime(exerciseId).catch(() => null)));
    return draftFromRoutine(routine, new Map(movements.map((exerciseId, at) => [exerciseId, replies[at]])));
  }, [id]);

  if (view.phase === 'loading') return <ScreenNote back={back}>Opening the routine…</ScreenNote>;
  if (view.phase === 'absent') return <ScreenNote back={back}>This routine isn’t in your program.</ScreenNote>;
  if (view.phase === 'failed') return <ReadFailed back={back} onRetry={view.retry}>The routine didn’t load.</ReadFailed>;
  return <PastWorkout opening={view.data} back={back} log={log} />;
}

function ScreenNote({ back, children }) {
  return (
    <>
      <Back href={back.href}>{back.label}</Back>
      <p className="gym-quiet">{children}</p>
    </>
  );
}

function ReadFailed({ back, onRetry, children }) {
  return (
    <>
      <Back href={back.href}>{back.label}</Back>
      <p className="gym-read-failed">
        {children}
        <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
      </p>
    </>
  );
}

function PastWorkout({ opening, back, log, noRoutines = false }) {
  // One clock for the life of the form, so the same form always builds the same request.
  const [now] = useState(() => Date.now());
  const [sessionId] = useState(() => mintId('ses_'));
  const [draft, setDraft] = useState(opening);
  const [day, setDay] = useState(() => todayOf(now));
  // The lifter's own start and length, once `Change time` is opened; the default slot until then.
  const [clock, setClock] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [focus, setFocus] = useState(opening.movements[0]?.key ?? null);
  const [edited, setEdited] = useState(() => new Set());
  const [lift, setLift] = useState(null);
  const [leaving, setLeaving] = useState(() => new Set());
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  // The session the store holds for this form: its span is the one the note reads while `Saved` stands.
  const [landed, setLanded] = useState(null);
  // The session the store said these times cross: the log moved under the form.
  const [raced, setRaced] = useState(null);
  const dayField = useRef(null);
  const startField = useRef(null);
  const savedTimer = useRef(null);

  // A skipped movement's Undo has nowhere to go once the form is gone, and neither has its `Saved`.
  const { dropWithheld } = log;
  useEffect(() => () => {
    dropWithheld('entry');
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, [dropWithheld]);

  const settled = log.gone('session');
  const sessions = log.summaries.filter((summary) => !settled.has(summary.id));
  const running = log.session ?? sessions.find((summary) => !isFinished(summary)) ?? null;
  const fallback = defaultSlot({ day, now, sessions, open: running });
  // No default fits the day: the time row stands open, waiting for a start.
  const opened = clock ?? (fallback ? null : { hour: null, minute: null, minutes: DEFAULT_MINUTES });
  const chosen = opened?.hour != null ? chosenSlot({ day, ...opened, now }) : null;
  const slot = landed ?? (opened ? chosen : fallback);
  const refusal = raced
    ? crossedRefusal(raced, now)
    : !landed && chosen && refusalOf({ slot: chosen, busy: busySpans({ sessions, open: running, now }), now });
  const inert = !isReady(draft) || !slot || Boolean(refusal) || saving || Boolean(landed);
  const focused = draft.movements.find((movement) => movement.key === focus) ?? draft.movements[0] ?? null;
  const dayChip = dayChipOf(day, now);

  // A movement the lifter has worked in stays open, even once its sets come to agree.
  const keepOpen = (key) => setExpanded((held) => new Set(held).add(key));

  const changeDay = (next) => {
    setRaced(null);
    setDay(next);
  };
  const changeClock = (change) => {
    setRaced(null);
    setClock({ ...opened, ...change });
  };
  const openClock = () => {
    if (!opened) {
      const start = new Date(slot.startedAt);
      changeClock({ hour: start.getHours(), minute: start.getMinutes(), minutes: DEFAULT_MINUTES });
    }
    window.requestAnimationFrame?.(() => startField.current?.focus());
  };
  const openDayField = () => {
    const field = dayField.current;
    try {
      field.showPicker();
    } catch {
      field?.focus();
    }
  };

  const write = (key, setKey, field, value) => {
    const { draft: next, carried } = withValueSet(draft, key, setKey, field, value);
    setDraft(next);
    setEdited((held) => new Set(held).add(key));
    keepOpen(key);
    if (carried.length > 0) setLift((held) => ({ key, field, carried, stamp: (held?.stamp ?? 0) + 1 }));
  };

  // The row collapses its height before it leaves; without motion it leaves at once.
  const removeSet = (key, setKey) => {
    keepOpen(key);
    const still = !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) {
      setDraft((held) => withSetRemoved(held, key, setKey));
      return;
    }
    setLeaving((held) => new Set(held).add(setKey));
    setTimeout(() => {
      setDraft((held) => withSetRemoved(held, key, setKey));
      setLeaving((held) => {
        const next = new Set(held);
        next.delete(setKey);
        return next;
      });
    }, LEAVE_MS);
  };

  // Withheld like a routine line: it leaves at once, and the transient is the way back.
  const skip = (movement) => {
    const index = draft.movements.indexOf(movement);
    setDraft((held) => withMovementRemoved(held, movement.key));
    log.withhold({
      kind: 'entry',
      id: mintId('drop_'),
      line: movementSkippedLine(nameOfMovement(log.catalog, movement.exerciseId)),
      undo: () => setDraft((held) => withMovementAt(held, index, movement)),
    });
  };

  const addMovement = async (exerciseId) => {
    setPicking(false);
    const reply = await gymApi.lastTime(exerciseId).catch(() => null);
    setDraft((held) => withMovementAdded(held, exerciseId, reply));
    setFocus(`m${draft.minted}`);
  };

  const discard = (id) => {
    log.withhold({
      kind: 'session',
      id,
      line: SESSION_DELETED,
      send: async () => {
        await gymApi.discardSession(id);
        await log.reloadLog();
      },
      refused: (error) => log.say(`That session wasn’t discarded — ${failureReason(error)}.`),
    });
    window.location.hash = '#/gym/log';
  };

  // The id is this form's for good. A save whose answer was lost and is pressed again sends the same
  // bytes, which the store answers as a replay; one sent after an edit meets the id already spent,
  // and the session the store holds under it is what landed.
  const send = async (request) => {
    try {
      const stored = await gymApi.importSession(request);
      return { session: stored.session, already: false };
    } catch (error) {
      if (!error.sessionIdTaken && !error.sessionDeleted) return { error };
      const held = await gymApi.session(request.id).catch(() => null);
      if (held?.session) return { session: held.session, already: true };
      return { error };
    }
  };

  const save = async () => {
    if (inert) return;
    setSaving(true);
    const { session, already, error } = await send(importOf({ id: sessionId, slot, draft }));
    setSaving(false);
    if (error) {
      if (error.overlapping) setRaced(error.overlapping);
      else if (error.sessionDeleted) log.say(discardedLine());
      else log.say(`That workout didn’t reach the log — ${failureReason(error)}.`);
      return;
    }
    setLanded({ startedAt: session.startedAt, finishedAt: session.finishedAt });
    log.reloadLog();
    const name = draft.name ?? NO_ROUTINE;
    const form = window.location.hash;
    savedTimer.current = setTimeout(() => {
      if (window.location.hash === form) window.location.hash = `${sessionHref(sessionId)}?from=${encodeURIComponent('#/gym/log')}`;
      log.say(already ? alreadySavedLine(name) : inTheLogLine(name), {
        action: { label: UNDO_LABEL, run: () => discard(sessionId) },
      });
    }, SAVED_MS);
  };

  const clockValue = opened?.hour != null
    ? `${String(opened.hour).padStart(2, '0')}:${String(opened.minute).padStart(2, '0')}`
    : '';

  return (
    <>
      <header className="gym-past-top">
        <Back href={back.href}>{back.label}</Back>
        <h1 className="gym-title">{draft.name ?? NO_ROUTINE}</h1>
      </header>
      <div className="gym-past">
        <div className="gym-past-form">
          <div className="gym-past-when">
            <div className="gym-past-days">
              {['today', 'yesterday'].map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className={dayChip === chip ? 'gym-chip is-on' : 'gym-chip'}
                  aria-pressed={dayChip === chip}
                  onClick={() => changeDay(chip === 'today' ? todayOf(now) : yesterdayOf(now))}
                >
                  {DAY_CHIPS[chip]}
                </button>
              ))}
              <button
                type="button"
                className={dayChip === 'other' ? 'gym-chip is-on' : 'gym-chip'}
                aria-pressed={dayChip === 'other'}
                onClick={openDayField}
              >
                {dayChip === 'other' ? dayNameOf(day, now) : DAY_CHIPS.other}
              </button>
              <input
                ref={dayField}
                className="gym-past-day-field"
                type="date"
                tabIndex={-1}
                aria-label="Other day"
                value={day}
                max={todayOf(now)}
                onChange={(event) => {
                  const picked = event.target.value;
                  if (picked !== '' && picked <= todayOf(now)) changeDay(picked);
                }}
              />
              {!opened && <button type="button" className="gym-past-link" onClick={openClock}>Change time</button>}
            </div>
            {opened && (
              <div className="gym-past-clock">
                <input
                  ref={startField}
                  className="gym-past-start"
                  type="time"
                  aria-label="Start time"
                  autoFocus={!clock}
                  value={clockValue}
                  onChange={(event) => {
                    const [hour, minute] = event.target.value.split(':');
                    if (hour !== undefined && minute !== undefined) changeClock({ hour: Number(hour), minute: Number(minute) });
                  }}
                />
                <span className="gym-past-for">for</span>
                <span className="gym-past-duration" role="group" aria-label="Duration">{DURATION_CHIPS.map((chip) => (
                  <button
                    key={chip.minutes}
                    type="button"
                    className={opened.minutes === chip.minutes ? 'gym-chip is-on' : 'gym-chip'}
                    aria-pressed={opened.minutes === chip.minutes}
                    onClick={() => changeClock({ minutes: chip.minutes })}
                  >
                    {chip.label}
                  </button>
                ))}</span>
              </div>
            )}
          </div>

          {draft.movements.length > 0 && (
            <p className="gym-past-units" aria-hidden="true">kg <span className="gym-past-times">×</span> reps</p>
          )}
          {draft.movements.map((movement) => (
            <Movement
              key={movement.key}
              movement={movement}
              name={nameOfMovement(log.catalog, movement.exerciseId)}
              stepKg={movementOf(log.catalog, movement.exerciseId)?.stepKg ?? null}
              focused={focused?.key === movement.key}
              open={!collapses(movement) || expanded.has(movement.key)}
              lift={lift?.key === movement.key ? lift : null}
              leaving={leaving}
              onFocus={() => setFocus(movement.key)}
              onOpen={() => {
                setFocus(movement.key);
                keepOpen(movement.key);
              }}
              onWrite={(setKey, field, value) => write(movement.key, setKey, field, value)}
              onAddSet={() => {
                setDraft((held) => withSetAdded(held, movement.key));
                keepOpen(movement.key);
              }}
              onRemoveSet={(setKey) => removeSet(movement.key, setKey)}
              onSkip={() => skip(movement)}
            />
          ))}
          <button
            type="button"
            className={draft.routineId ? 'gym-past-add is-movement' : 'gym-past-add is-movement is-bar'}
            onClick={() => { setQuery(''); setPicking(true); }}
          >
            + Add movement
          </button>

          {refusal && (
            <section className="gym-past-refusal" role="alert">
              <p className="gym-past-refusal-title">{refusal.title}</p>
              <p className="gym-past-refusal-body">{refusal.body}</p>
              <div className="gym-past-refusal-acts">
                {refusal.session && (
                  <a className="gym-past-refusal-open" href={sessionHref(refusal.session.id)}>Open that session ›</a>
                )}
                <button type="button" className="gym-past-refusal-fix" onClick={openClock}>Change time</button>
              </div>
            </section>
          )}

          <div className="gym-save">
            <p className="gym-save-note">{slot ? slotNote(slot, now) : TIME_NEEDED}</p>
            <button
              type="button"
              className={saveClass(inert, landed)}
              aria-disabled={inert}
              onClick={save}
            >
              {landed ? savedLabel(draft) : saveLabel(draft)}
            </button>
          </div>
          {isOverLimit(draft) && <p className="gym-past-limit">{SET_LIMIT_LINE}</p>}
        </div>

        <aside className="gym-past-side">
          {noRoutines && (
            <section className="gym-past-card">
              <h2 className="gym-past-card-title">No routines yet</h2>
              <p className="gym-past-card-line">Build one and this form arrives filled in.</p>
              <Button variant="secondary" href={routineHref(NEW_ROUTINE_ID)}>Build a routine</Button>
            </section>
          )}
          {focused && (
            <Source
              movement={focused}
              name={nameOfMovement(log.catalog, focused.exerciseId)}
              edited={edited.has(focused.key)}
            />
          )}
        </aside>
      </div>

      {picking && (
        <MovementPicker
          catalog={log.catalog}
          sessions={log.summaries}
          query={query}
          onQuery={setQuery}
          onPick={addMovement}
          onCreate={log.createMovement}
          onClose={() => setPicking(false)}
          title="Add movement"
        />
      )}
    </>
  );
}

function Movement({ movement, name, stepKg, focused, open, lift, leaving, onFocus, onOpen, onWrite, onAddSet, onRemoveSet, onSkip }) {
  return (
    <section className={focused ? 'gym-past-movement is-focused' : 'gym-past-movement'}>
      <div className="gym-past-line">
        <button type="button" className="gym-past-name" aria-expanded={open} onClick={onOpen}>
          <span className="gym-past-movement-name">{name}</span>
          <span className="gym-past-scheme">{movementLine(movement)}</span>
        </button>
        {!open && (
          <span className="gym-past-rail" aria-hidden="true">
            {movement.sets.map((set) => <span key={set.key} className="gym-past-rail-tick" />)}
          </span>
        )}
        <button type="button" className="gym-past-drop" aria-label={`Skip ${name}`} onClick={onSkip}>×</button>
      </div>
      {open && (
        <>
          <ul className="gym-past-sets">
            {movement.sets.map((set, index) => (
              <li key={set.key} className={leaving.has(set.key) ? 'gym-past-set is-leaving' : 'gym-past-set'}>
                <span className="gym-past-tick" aria-hidden="true" />
                {CELLS.map((cell, at) => (
                  <React.Fragment key={cell.field}>
                    {at === 1 && <span className="gym-past-times" aria-hidden="true">×</span>}
                    <EditableNumber
                      value={set[cell.key]}
                      field={cell.field}
                      label={`${name}, set ${index + 1}, ${cell.spoken}`}
                      stepKg={stepKg}
                      lift={lift?.field === cell.key && lift.carried.includes(set.key)
                        ? { stamp: lift.stamp, delay: lift.carried.indexOf(set.key) * LIFT_STAGGER_MS }
                        : null}
                      onFocus={onFocus}
                      onCommit={(value) => onWrite(set.key, cell.key, value)}
                    />
                  </React.Fragment>
                ))}
                <button
                  type="button"
                  className="gym-past-set-drop"
                  aria-label={`Remove set ${index + 1} of ${name}`}
                  onClick={() => onRemoveSet(set.key)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="gym-past-add" onClick={onAddSet}>+ Add set</button>
        </>
      )}
    </section>
  );
}

// Where the focused movement's numbers came from: its target, its last time, and one caption.
function Source({ movement, name, edited }) {
  return (
    <section className="gym-past-card gym-past-source">
      <h2 className="gym-past-card-title">{name}</h2>
      {movement.target && (
        <p className="gym-past-target">
          <span>Target</span>
          <span className="gym-past-mono">{targetLine(movement)}</span>
        </p>
      )}
      {movement.lastTime && (
        <>
          <p className="gym-past-last">{`Last time · ${shortDayLabel(movement.lastTime.at)}`}</p>
          <ul className="gym-past-lifted">
            {movement.lastTime.sets.map((set, index) => (
              <li key={index}>
                {valueLabel(set.weightKg, 'load')}
                <span className="gym-past-times"> × </span>
                {set.reps}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="gym-past-caption">{sourceCaption(movement, edited)}</p>
    </section>
  );
}
