import React, { useState } from 'react';
import { Input } from '../../design-system/index.js';
import { alsoReadsLabel, fmtKg } from './log.js';
import {
  fixDraftOf, fixOf, fixSubtitle, isSetNoteOverCap, keepsItsOwnNumbers, NO_RPE_LABEL, RPE_RUNGS,
  SET_KINDS, setNoteCountLabel, SET_NOTE_CAPTION, SET_NOTE_LABEL, setNoteRefusal, showsSetNoteCount,
  withReps, withWeight,
} from './fix.js';
import { Keypad } from './logger/Keypad.jsx';
import { LADDER_KEYS, ladderLabels } from './logger/ladder.js';

export function FixSheet({ set, movement, session, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState(() => fixDraftOf(set));
  const [typing, setTyping] = useState(null);
  // `LADDER_KEYS` and these labels pair by index.
  const rungs = ladderLabels(draft.weightKg);
  const keeps = keepsItsOwnNumbers(session);
  const alsoReads = alsoReadsLabel(draft.weightKg);
  // The store's own refusal for a long note is swallowed by the API, so this one is the lifter's.
  const refusal = setNoteRefusal(draft.note);

  return (
    <>
      <div className="gym-sheet-catch is-dimmed" role="presentation" onClick={onClose}>
        <div className="gym-sheet gym-fix" role="dialog" aria-label="Fix this set" onClick={(event) => event.stopPropagation()}>
          <div className="gym-fix-head">
            <span className="gym-fix-title">Fix this set</span>
            <span className="gym-fix-sub">{fixSubtitle(movement, set)}</span>
            <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">×</button>
          </div>

          <button type="button" className="gym-fix-weight" onClick={() => setTyping('weight')}>
            <span className="gym-fix-kg">{fmtKg(draft.weightKg)}</span>
            <span className="gym-fix-unit">kg</span>
          </button>
          {/* The field is kilograms; null when the account also reads kilograms. */}
          {alsoReads && <p className="gym-fix-reads">{alsoReads}</p>}

          <div className="gym-rungs">
            {LADDER_KEYS.map((rung, index) => (
              <button
                key={`${rung.direction}${rung.big}`}
                type="button"
                className={rung.weight === 'inner' ? 'gym-rung is-loud' : 'gym-rung'}
                onClick={() => setDraft((held) => withWeight(held, rung.direction, rung.big))}
              >
                {rungs[index]}
              </button>
            ))}
          </div>

          <div className="gym-fix-row">
            <span className="gym-fix-label">Reps</span>
            <button type="button" className="gym-fix-step" aria-label="One rep fewer" onClick={() => setDraft((held) => withReps(held, -1))}>−</button>
            <button type="button" className="gym-fix-value" onClick={() => setTyping('reps')}>{draft.reps}</button>
            <button type="button" className="gym-fix-step" aria-label="One rep more" onClick={() => setDraft((held) => withReps(held, 1))}>+</button>
          </div>

          <div className="gym-kinds">
            {SET_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`gym-kind is-${kind}${draft.kind === kind ? ' is-on' : ''}`}
                onClick={() => setDraft((held) => ({ ...held, kind }))}
              >
                {kind}
              </button>
            ))}
          </div>

          {/* Six to ten by halves, and the seat before them is no rating at all: a set the lifter
              never rated has to be reachable again after one was chosen by mistake. That seat says
              `Not rated` in its own face, so a screen reader names it from the same words a sighted
              lifter reads — the dash it used to wear was announced as nothing. */}
          <div className="gym-fix-rpe">
            <span className="gym-fix-label">RPE</span>
            <div className="gym-rpes">
              <button
                type="button"
                className={draft.rpe == null ? 'gym-rpe is-unrated is-on' : 'gym-rpe is-unrated'}
                aria-pressed={draft.rpe == null}
                onClick={() => setDraft((held) => ({ ...held, rpe: null }))}
              >
                {NO_RPE_LABEL}
              </button>
              {RPE_RUNGS.map((rung) => (
                <button
                  key={rung}
                  type="button"
                  className={draft.rpe === rung ? 'gym-rpe is-on' : 'gym-rpe'}
                  aria-pressed={draft.rpe === rung}
                  onClick={() => setDraft((held) => ({ ...held, rpe: rung }))}
                >
                  {rung}
                </button>
              ))}
            </div>
          </div>

          {/* The caption is load-bearing and not decoration: a set note is a RECORD the prompt reads
              as data, where a note is directive text Coach follows. Emptying the field clears the
              stored note; leaving it alone sends nothing. The counter goes alarm past the bound, the
              same state and the same class the room's other byte counters wear. */}
          <div className="gym-fix-note">
            <Input
              label={SET_NOTE_LABEL}
              value={draft.note}
              placeholder="felt heavy"
              error={refusal ?? undefined}
              onChange={(event) => setDraft((held) => ({ ...held, note: event.target.value }))}
              describedBy="gym-set-note-caption"
              trailing={showsSetNoteCount(draft.note) && (
                <span className={isSetNoteOverCap(draft.note) ? 'gym-name-count is-over' : 'gym-name-count'}>
                  {setNoteCountLabel(draft.note)}
                </span>
              )}
            />
            <p className="gym-fix-note-caption" id="gym-set-note-caption">{SET_NOTE_CAPTION}</p>
          </div>

          <button
            type="button"
            className={refusal ? 'gym-fix-save is-inert' : 'gym-fix-save'}
            onClick={() => { if (!refusal) onSave(fixOf(set, draft)); }}
          >
            Save the fix
          </button>

          <div className="gym-fix-foot">
            <button type="button" className="gym-fix-delete" onClick={onDelete}>Delete set</button>
            {keeps && <span className="gym-fix-keeps">{keeps}</span>}
          </div>
        </div>
      </div>
      {/* Keep the keypad outside the sheet; nested, a tap on it closes the sheet. */}
      {typing && (
        <Keypad
          key={typing}
          mode={typing}
          current={typing === 'weight' ? draft.weightKg : draft.reps}
          editing
          onCommit={(value) => {
            setDraft((held) => (typing === 'weight' ? { ...held, weightKg: value } : { ...held, reps: value }));
            setTyping(null);
          }}
          onCancel={() => setTyping(null)}
        />
      )}
    </>
  );
}
