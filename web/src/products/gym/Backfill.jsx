// ADD A PAST WORKOUT — the one place in gym where a set is written from memory instead of from the
// bar. It is a door on the log and never a Start, and it admits to being a form: the unit of entry
// is the LINE (weight × reps × how many), because "3 × 8 at 82.5" is one fact a lifter remembers
// rather than three rows to fill in, and every value is typed on the training log's own keypad.
//
// The two refusals are not the same shape and must not read as one. Times that CROSS a session
// already in the log are a fact about the log, so the panel offers to open that session — one visit
// is one session, and the missing sets belong in it. A session already running is not a fault at
// all, so its panel carries the live dot on a neutral surface and never alarm ink; it is checked
// here before the request, and the wire still carries `joinOpenSession: false` so the store's
// refusal is the rule rather than this client's promise (backfill.js).
//
// AND THE DRAFT NEVER LEAVES THE SCREEN UNTIL THE WHOLE OF IT IS IN THE LOG. The save files every
// set or none, and anything short of all of them keeps the form standing with the workout intact —
// these sets were typed from memory and there is no second copy of them anywhere (backfill.js).
//
// G8's desk sentence — "Live training happens on your phone" — is true on this build at last: the
// web's own Start is gone (§11), so it is spoken where it earns its place, in the mid-workout
// refusal that names where the running session lives.

import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  dayChips, DURATION_CHIPS, expandLines, fileBackfill, lineLabel, MID_WORKOUT_REFUSAL, overlapWith,
  saveLabel, saveNote, saveReport, startedAtOf, withLineAdded, withLineChanged, withLineRemoved,
  withMovementAdded,
} from './backfill.js';
import { failureReason, gymApi } from './gymApi.js';
import { fmt, nameOfMovement, sessionHref } from './log.js';
import { mintId } from './mint.js';
import { Keypad } from './logger/Keypad.jsx';
import { MovementPicker } from './logger/MovementPicker.jsx';

const DEFAULT_DAYS = 1;
const DEFAULT_MINUTES = 60;

export function Backfill({ log }) {
  const [form, setForm] = useState({ days: DEFAULT_DAYS, hour: 17, minute: 30, minutes: DEFAULT_MINUTES, blocks: [] });
  const [overlap, setOverlap] = useState(null);
  const [refused, setRefused] = useState(false);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(null);
  const [saving, setSaving] = useState(false);

  // Any edit to the draft retires both refusals: each of them is an answer about times and sets that
  // have just changed, and a panel left standing would be answering a question nobody asked again.
  const edit = (change) => {
    setForm((held) => ({ ...held, ...change }));
    setOverlap(null);
    setRefused(false);
  };
  const blocks = (change) => edit({ blocks: change(form.blocks) });

  const startedAt = startedAtOf({ days: form.days, hour: form.hour, minute: form.minute });
  const durationMs = form.minutes * 60_000;

  const save = async () => {
    if (saving || form.blocks.length === 0) return;
    if (log.session) {
      setOverlap(null);
      setRefused(true);
      return;
    }
    const crossed = overlapWith({ startedAt, durationMs }, log.summaries);
    if (crossed) {
      setOverlap(crossed);
      return;
    }
    setSaving(true);
    const id = mintId('ses_');
    const sets = expandLines({ startedAt, durationMs, blocks: form.blocks, mint: mintId });
    try {
      await gymApi.startSession({ id, startedAt, joinOpenSession: false });
    } catch (error) {
      setSaving(false);
      // The store's own check, reached by a tab that did not know a workout had started. It speaks
      // the door's sentence and never a status, because nothing failed here either.
      if (error.sessionAlreadyOpen) setRefused(true);
      else log.say(`That workout didn’t reach the log — ${failureReason(error)}.`);
      return;
    }
    // Every set or none, and the draft stays under the hand until every one of them is in the log:
    // these sets were typed from memory and exist nowhere else, so leaving this screen is how they
    // are destroyed (backfill.js).
    const filed = await fileBackfill({ api: gymApi, id, sets, finishedAt: startedAt + durationMs });
    const report = saveReport({ ...filed, startedAt });
    setSaving(false);
    log.reloadLog();
    log.say(report.text);
    if (!report.kept) window.location.hash = '#/gym/log';
  };

  return (
    <>
      <a className="gym-back" href="#/gym/log">
        <ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> The log
      </a>
      <h1 className="gym-title">Add a past workout</h1>
      <p className="gym-quiet">For the session that never made it into the log.</p>

      <div className="gym-when">
        {dayChips().map((chip) => (
          <button
            key={chip.days}
            type="button"
            className={form.days === chip.days ? 'gym-chip is-on' : 'gym-chip'}
            onClick={() => edit({ days: chip.days })}
          >
            {chip.label}
          </button>
        ))}
        <span className="gym-when-word">at</span>
        <input
          className="gym-when-time"
          type="time"
          aria-label="Start time"
          value={`${String(form.hour).padStart(2, '0')}:${String(form.minute).padStart(2, '0')}`}
          onChange={(event) => {
            // A cleared field is not a time. The one it had stands until another one is typed.
            const [hour, minute] = event.target.value.split(':');
            if (hour !== undefined && minute !== undefined) edit({ hour: Number(hour), minute: Number(minute) });
          }}
        />
        <span className="gym-when-word">for</span>
        {DURATION_CHIPS.map((chip) => (
          <button
            key={chip.minutes}
            type="button"
            className={form.minutes === chip.minutes ? 'gym-chip is-on' : 'gym-chip'}
            onClick={() => edit({ minutes: chip.minutes })}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {form.blocks.map((block, blockIndex) => (
        <section className="gym-block" key={`${block.exerciseId}-${blockIndex}`}>
          <h2 className="gym-block-name">{nameOfMovement(log.catalog, block.exerciseId)}</h2>
          {block.lines.map((line, lineIndex) => (
            <div className="gym-line" key={`${line.weightKg}-${line.reps}-${lineIndex}`}>
              <button
                type="button"
                className="gym-line-value"
                onClick={() => setTyping({ blockIndex, lineIndex, mode: 'weight' })}
              >
                {fmt(line.weightKg)}
              </button>
              <button
                type="button"
                className="gym-line-value"
                onClick={() => setTyping({ blockIndex, lineIndex, mode: 'reps' })}
              >
                {`× ${line.reps}`}
              </button>
              <button
                type="button"
                className={line.kind === 'warmup' ? 'gym-line-kind is-warmup' : 'gym-line-kind'}
                onClick={() => blocks((held) => withLineChanged(held, blockIndex, lineIndex, {
                  kind: line.kind === 'warmup' ? 'working' : 'warmup',
                }))}
              >
                warmup
              </button>
              <span className="gym-line-count">
                <button
                  type="button"
                  className="gym-line-step"
                  aria-label="One set fewer"
                  onClick={() => blocks((held) => withLineChanged(held, blockIndex, lineIndex, { sets: line.sets - 1 }))}
                >
                  −
                </button>
                <span className="gym-line-sets">{`× ${line.sets}`}</span>
                <button
                  type="button"
                  className="gym-line-step"
                  aria-label="One set more"
                  onClick={() => blocks((held) => withLineChanged(held, blockIndex, lineIndex, { sets: line.sets + 1 }))}
                >
                  +
                </button>
              </span>
              <button
                type="button"
                className="gym-line-drop"
                aria-label={`Remove ${lineLabel(line)}`}
                onClick={() => blocks((held) => withLineRemoved(held, blockIndex, lineIndex))}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" className="gym-line-add" onClick={() => blocks((held) => withLineAdded(held, blockIndex))}>
            Add a line
          </button>
        </section>
      ))}

      <button type="button" className="gym-editor-add" onClick={() => { setQuery(''); setPicking(true); }}>
        Add a movement
      </button>

      {overlap && (
        <section className="gym-overlap">
          <p className="gym-overlap-title">{overlap.title}</p>
          <p className="gym-overlap-body">{overlap.body}</p>
          <div className="gym-finish-foot">
            <a className="gym-overlap-open" href={sessionHref(overlap.session.id)}>Open that session ›</a>
            <button type="button" className="gym-overlap-fix" onClick={() => setOverlap(null)}>Change the times</button>
          </div>
        </section>
      )}

      {refused && (
        <section className="gym-refusal">
          <p className="gym-refusal-title">
            <span className="gym-live-dot" aria-hidden="true" />
            {MID_WORKOUT_REFUSAL.title}
          </p>
          <p className="gym-refusal-body">{MID_WORKOUT_REFUSAL.body}</p>
          <button type="button" className="gym-refusal-close" onClick={() => setRefused(false)}>OK</button>
        </section>
      )}

      <div className="gym-save">
        <a className="gym-save-cancel" href="#/gym/log">Cancel</a>
        <button
          type="button"
          className={form.blocks.length === 0 || saving ? 'gym-save-do is-inert' : 'gym-save-do'}
          onClick={save}
        >
          {saveLabel(form.blocks)}
        </button>
      </div>
      <p className="gym-save-note">{saveNote(startedAt)}</p>

      {picking && (
        <MovementPicker
          catalog={log.catalog}
          query={query}
          onQuery={setQuery}
          onPick={(exerciseId) => { setPicking(false); blocks((held) => withMovementAdded(held, exerciseId)); }}
          onCreate={log.createMovement}
          onClose={() => setPicking(false)}
          title="Add a movement"
        />
      )}

      {typing && (
        <Keypad
          key={`${typing.blockIndex}-${typing.lineIndex}-${typing.mode}`}
          mode={typing.mode}
          current={typing.mode === 'weight'
            ? form.blocks[typing.blockIndex].lines[typing.lineIndex].weightKg
            : form.blocks[typing.blockIndex].lines[typing.lineIndex].reps}
          onCommit={(value) => {
            blocks((held) => withLineChanged(held, typing.blockIndex, typing.lineIndex, (
              typing.mode === 'weight' ? { weightKg: value } : { reps: value }
            )));
            setTyping(null);
          }}
          onCancel={() => setTyping(null)}
        />
      )}
    </>
  );
}
