import React, { useState } from 'react';
import { Button } from '../../design-system/index.js';
import { Back } from './Back.jsx';
import {
  DURATION_CHIPS, endsAhead, expandLines, fileBackfill, lineLabel, MID_WORKOUT_REFUSAL, overlapWith,
  saveLabel, saveNote, saveReport, startedAtOf, withLineAdded, withLineChanged, withLineRemoved,
  withMovementAdded, yesterdayOf,
} from './backfill.js';
import { dateLocalOf } from './bodyweight/bodyweight.js';
import { failureReason, gymApi } from './gymApi.js';
import { fmtKg, nameOfMovement, sessionHref } from './log.js';
import { mintId } from './mint.js';
import { Keypad } from './logger/Keypad.jsx';
import { MovementPicker } from './logger/MovementPicker.jsx';

const DEFAULT_MINUTES = 60;

export function Backfill({ log }) {
  const [form, setForm] = useState(() => ({ date: yesterdayOf(), hour: 17, minute: 30, minutes: DEFAULT_MINUTES, blocks: [] }));
  const [overlap, setOverlap] = useState(null);
  const [ahead, setAhead] = useState(null);
  const [refused, setRefused] = useState(false);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(null);
  const [saving, setSaving] = useState(false);

  const edit = (change) => {
    setForm((held) => ({ ...held, ...change }));
    setOverlap(null);
    setAhead(null);
    setRefused(false);
  };
  const blocks = (change) => edit({ blocks: change(form.blocks) });

  const startedAt = startedAtOf({ date: form.date, hour: form.hour, minute: form.minute });
  const durationMs = form.minutes * 60_000;

  const save = async () => {
    if (saving || form.blocks.length === 0) return;
    if (log.session) {
      setOverlap(null);
      setRefused(true);
      return;
    }
    // Against what the ACCOUNT holds: the page less the sessions the store has answered a delete
    // for. Nothing re-reads the page behind a settled session delete that the log's own reload
    // missed, so the raw page would refuse this workout in the name of a session that is not there
    // and offer a door onto `This session isn’t in your log.`
    const held = log.gone('session');
    const crossed = overlapWith({ startedAt, durationMs }, log.summaries.filter((summary) => !held.has(summary.id)));
    if (crossed) {
      setOverlap(crossed);
      return;
    }
    const runsPastNow = endsAhead({ startedAt, durationMs });
    if (runsPastNow) {
      setAhead(runsPastNow);
      return;
    }
    setSaving(true);
    const id = mintId('ses_');
    const sets = expandLines({ startedAt, durationMs, blocks: form.blocks, mint: mintId });
    try {
      await gymApi.startSession({ id, startedAt, joinOpenSession: false });
    } catch (error) {
      setSaving(false);
      if (error.sessionAlreadyOpen) setRefused(true);
      else log.say(`That workout didn’t reach the log — ${failureReason(error)}.`);
      return;
    }
    const filed = await fileBackfill({ api: gymApi, id, sets, finishedAt: startedAt + durationMs });
    const report = saveReport({ ...filed, startedAt });
    setSaving(false);
    log.reloadLog();
    log.say(report.text);
    if (!report.kept) window.location.hash = '#/gym/log';
  };

  return (
    <>
      <Back href="#/gym/log">The log</Back>
      <h1 className="gym-title">Add a past workout</h1>
      <p className="gym-quiet">For the session that never made it into the log.</p>

      <div className="gym-when">
        {/* Any day up to today; the field keeps the last real day it held rather than an empty one. */}
        <input
          className="gym-when-date"
          type="date"
          aria-label="Day"
          value={form.date}
          max={dateLocalOf(Date.now())}
          onChange={(event) => { if (event.target.value !== '') edit({ date: event.target.value }); }}
        />
        <span className="gym-when-word">at</span>
        <input
          className="gym-when-time"
          type="time"
          aria-label="Start time"
          value={`${String(form.hour).padStart(2, '0')}:${String(form.minute).padStart(2, '0')}`}
          onChange={(event) => {
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
              {/* Always kilograms, whatever unit the account reads in. */}
              <button
                type="button"
                className="gym-line-value"
                onClick={() => setTyping({ blockIndex, lineIndex, mode: 'weight' })}
              >
                {`${fmtKg(line.weightKg)} kg`}
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

      <Button full variant="secondary" onClick={() => { setQuery(''); setPicking(true); }}>
        Add a movement
      </Button>

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

      {ahead && (
        <section className="gym-overlap">
          <p className="gym-overlap-title">{ahead.title}</p>
          <p className="gym-overlap-body">{ahead.body}</p>
          <div className="gym-finish-foot">
            <button type="button" className="gym-overlap-fix" onClick={() => setAhead(null)}>Change the times</button>
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
          sessions={log.summaries}
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
