// The set logger — one value at a time, at arm's length, in a room where you cannot hear the tone
// and your hands are chalked. Only the today list is elastic; the big weight, the ladder, the reps
// and the 64px primary action never move as sets accumulate, so the thumb learns one geometry and
// keeps it for the whole session.
//
// The screen never congratulates and never warns: "set 4 of 3" is drawn in exactly the same ink as
// "set 3 of 5", an overrun rest counts up in the room's own hue, and the only alarm ink belongs
// to a write that actually failed.

import React, { useState } from 'react';
import { clockOf, fmt, NO_ROUTINE, sessionMovementMeta, timeLabel, workingSetsOf } from '../log.js';
import { LADDER_KEYS, ladderLabels } from './ladder.js';
import { counterLine, planEntryFor, prefillCard } from './prefill.js';
import { Keypad } from './Keypad.jsx';
import { MovementPicker } from './MovementPicker.jsx';

export function Logger({ live }) {
  const {
    session, routine, catalog, order, exIdx, exercise, sets, todaySets, workingToday, planEntry,
    lastTime, lastTimeFailed, weight, reps, rest, undo, stalled, offline, elapsed, deviation,
    chooseMovement, createMovement, jumpTo, stepWeight, stepReps, setWeight, setReps, logSet,
    undoLast, resetRest, saveDeviation, dismissDeviation, finish, finishing,
  } = live;

  const [typing, setTyping] = useState(null);
  const [jump, setJump] = useState(false);
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  // THE NEXT SET'S KIND, armed and then spent. A ramp-up logged as working becomes the mark to beat
  // and the number the next set carries forward, so the logger has to be able to say a set was a
  // warmup — and the chip that says it is backfill's own, not a second affordance for one word.
  // It disarms on the set it armed and on no other, which is why `logSet` answers whether one
  // happened: a lifter told the session is closing has not spent the gesture.
  const [warmup, setWarmup] = useState(false);

  const labels = ladderLabels(weight);
  const counter = counterLine({ workingSetsToday: workingToday, planEntry });
  const card = prefillCard({ lastTime, planEntry, routine, readFailed: lastTimeFailed === true });
  // The STRIP is the offline state (canon #10); the per-row "on this device" note is any queued
  // set. Keying the strip off `stalled` too would flash it for the whole undo hold after every
  // set on a healthy connection — every set is briefly pending, on purpose.
  const onDevice = offline ? sets.filter((set) => set.queued) : [];

  const openPicker = () => {
    setJump(false);
    setQuery('');
    setPicker(true);
  };

  return (
    <div className="gym-stage">
      <header className="gym-bar">
        <span className="gym-live-dot" aria-hidden="true" />
        <span className="gym-bar-routine">{routine ?? NO_ROUTINE}</span>
        <span className="gym-bar-clock">{clockOf(elapsed)}</span>
        <button type="button" className="gym-finish" onClick={finish}>Finish</button>
      </header>

      {onDevice.length > 0 && (
        <p className="gym-unsynced">
          {onDevice.length === 1 ? '1 set is' : `${onDevice.length} sets are`} saved on this device only.
          {' No signal down here — they flush when you’re back up.'}
        </p>
      )}

      {!exercise && (
        <section className="gym-adhoc">
          <h1 className="gym-adhoc-title">{routine ?? NO_ROUTINE}</h1>
          <p className="gym-adhoc-line">No routine, no plan snapshot. Pick what you are about to lift.</p>
          <button type="button" className="gym-adhoc-choose" onClick={openPicker}>Choose a movement</button>
        </section>
      )}

      {exercise && (
        <>
          <div className="gym-exercise-head">
            <div className="gym-exercise-title">
              <h1 className="gym-movement">{exercise.name}</h1>
              <p className="gym-counter">
                {counter.count}
                <span className="gym-counter-tail">{counter.tail}</span>
              </p>
            </div>
            <button type="button" className="gym-jump" onClick={() => setJump(true)} aria-label="This session">›</button>
          </div>

          <button type="button" className="gym-prefill" onClick={() => setTyping('weight')}>
            <span className="gym-prefill-title">{card.title}</span>
            <span className="gym-prefill-body">{card.body}</span>
          </button>

          <TodayList sets={todaySets} offline={offline} stalled={stalled} />

          <div className="gym-weight">
            <button type="button" className="gym-readout" onClick={() => setTyping('weight')}>
              <span className="gym-weight-number">{fmt(weight)}</span>
              <span className="gym-weight-unit">kg</span>
            </button>
            <div className="gym-ladder">
              {LADDER_KEYS.map((key, index) => (
                <button
                  key={`${key.direction}${key.big}`}
                  type="button"
                  className={key.weight === 'inner' ? 'gym-step is-inner' : 'gym-step'}
                  onClick={() => stepWeight(key.direction, key.big)}
                >
                  {labels[index]}
                </button>
              ))}
            </div>
          </div>

          <div className="gym-reps">
            <button type="button" className="gym-rep-step" onClick={() => stepReps(-1)} aria-label="One rep fewer">−</button>
            <button type="button" className="gym-rep-readout" onClick={() => setTyping('reps')}>
              <span className="gym-reps-number">{reps}</span>
              <span className="gym-reps-label">reps</span>
            </button>
            <button type="button" className="gym-rep-step" onClick={() => stepReps(1)} aria-label="One rep more">+</button>
          </div>

          {rest && (
            <div className={rest.overrun ? 'gym-rest is-over' : 'gym-rest'}>
              <span className="gym-rest-label">{rest.label}</span>
              <span className="gym-rest-time">{rest.time}</span>
              <button type="button" className="gym-rest-reset" onClick={resetRest}>reset</button>
            </div>
          )}

          {/* Backfill's own chip, and it sits on its own line rather than inside the reps row: the
              big weight, the ladder, the reps and the 64px primary action keep one geometry for the
              whole session, and a control appearing between them would move the thumb. */}
          <div className="gym-kind">
            <button
              type="button"
              className={warmup ? 'gym-line-kind is-warmup' : 'gym-line-kind'}
              aria-pressed={warmup}
              onClick={() => setWarmup(!warmup)}
            >
              warmup
            </button>
          </div>

          <div className="gym-primary">
            {/* The hook refuses a set once Finish is in flight; the button has to say so before the
                tap, or the surface looks live and answers with a refusal the lifter didn't earn.
                It also says which KIND it is about to write, because the chip is small and the
                write is not: a warmup counts toward no target, no record and no carry-forward. */}
            <button
              type="button"
              className="gym-log-set"
              onClick={() => { if (logSet(warmup ? 'warmup' : 'working')) setWarmup(false); }}
              disabled={finishing}
            >
              {`Log ${warmup ? 'warmup' : 'set'}  ·  ${fmt(weight)} × ${reps}`}
            </button>
          </div>
        </>
      )}

      {undo && (
        <div className="gym-undo">
          <span className="gym-undo-text">{`Logged ${fmt(undo.weightKg)} × ${undo.reps}`}</span>
          <button type="button" className="gym-undo-button" onClick={undoLast}>Undo</button>
        </div>
      )}

      {jump && (
        <JumpSheet
          order={order}
          exIdx={exIdx}
          catalog={catalog}
          sets={sets}
          session={session}
          onJump={(index) => { setJump(false); jumpTo(index); }}
          onAdd={openPicker}
          onClose={() => setJump(false)}
        />
      )}

      {picker && (
        <MovementPicker
          catalog={catalog}
          order={order}
          query={query}
          onQuery={setQuery}
          onPick={(id) => { setPicker(false); chooseMovement(id); }}
          onCreate={createMovement}
          onClose={() => setPicker(false)}
        />
      )}

      {/* Two answers and no third: the sheet has no scrim to tap through and no close button,
          because dismissing it without answering would leave the lifter's own question hanging over
          a program they are mid-way through training. Both answers cost nothing — the session
          already has the weight either way. */}
      {deviation && (
        <div className="gym-sheet-catch" role="presentation">
          <div className="gym-sheet gym-deviation" role="dialog" aria-label={deviation.title}>
            <h2 className="gym-deviation-title">{deviation.title}</h2>
            <p className="gym-deviation-body">{deviation.body}</p>
            <button type="button" className="gym-deviation-save" onClick={saveDeviation}>{deviation.save}</button>
            <button type="button" className="gym-deviation-keep" onClick={dismissDeviation}>{deviation.keep}</button>
          </div>
        </div>
      )}

      {typing && (
        <Keypad
          key={typing}
          mode={typing}
          current={typing === 'weight' ? weight : reps}
          onCommit={(value) => {
            if (typing === 'weight') setWeight(value);
            else setReps(value);
            setTyping(null);
          }}
          onCancel={() => setTyping(null)}
        />
      )}
    </div>
  );
}

// This movement's sets in the order performed, with real wall-clock times — not "2 minutes ago".
// Warmups carry a w and never advance the counter; a set still on this device says so plainly.
function TodayList({ sets, offline, stalled }) {
  let ordinal = 0;
  return (
    <ol className="gym-today">
      {sets.length === 0 && <li className="gym-today-empty">Nothing logged for this movement yet.</li>}
      {sets.map((set) => {
        const warmup = set.kind === 'warmup';
        if (!warmup) ordinal += 1;
        const held = set.queued && (offline || stalled.has(set.id));
        return (
          <li key={set.id} className={warmup ? 'gym-today-row is-warmup' : 'gym-today-row'}>
            <span className="gym-today-index">{warmup ? 'w' : ordinal}</span>
            <span className="gym-today-value">{`${fmt(set.weightKg)} × ${set.reps}`}</span>
            <span className="gym-today-note">{warmup ? 'warmup' : (held ? 'on this device' : '')}</span>
            <span className="gym-today-time">{timeLabel(set.completedAt)}</span>
          </li>
        );
      })}
    </ol>
  );
}

// THE SESSION LIST, which is also where the next movement gets appended (canon screen 2): adding one
// is a rest-time action taken from the list of what has been done so far, not a setup task done
// before the first set. Moving on is the lifter's decision, never the app's — nothing advances when
// a plan's set count is reached, and nothing advances when a rest lands.
function JumpSheet({ order, exIdx, catalog, sets, session, onJump, onAdd, onClose }) {
  const names = new Map(catalog.map((each) => [each.id, each.name]));
  return (
    <div className="gym-sheet-catch" role="presentation" onClick={onClose}>
      <div className="gym-sheet" role="dialog" aria-label="This session" onClick={(event) => event.stopPropagation()}>
        <div className="gym-sheet-head">
          <span className="gym-sheet-title">This session</span>
          <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {order.map((id, index) => {
          const done = workingSetsOf(sets, id).length;
          const planned = planEntryFor(session, id)?.sets ?? null;
          return (
            <button
              key={id}
              type="button"
              className={index === exIdx ? 'gym-sheet-row is-current' : 'gym-sheet-row'}
              onClick={() => onJump(index)}
            >
              <span className="gym-sheet-name">{names.get(id) ?? id}</span>
              <span className="gym-sheet-meta">{sessionMovementMeta({ done, planned })}</span>
            </button>
          );
        })}
        <button type="button" className="gym-sheet-add" onClick={onAdd}>+ Add next movement</button>
      </div>
    </div>
  );
}
