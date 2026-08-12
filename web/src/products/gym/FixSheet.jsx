// FIX THIS SET (§G18) — a sheet over the session, and the desk's answer to the thing somebody
// actually sits down at a laptop to do: correct last Tuesday. The session stays visible behind it,
// dimmed, with the row being fixed marked, because the number being corrected only means anything
// beside the ones around it.
//
// The weight moves on the ladder the loggers move it on (logger/ladder.js) and is typed on the
// keypad every other number in this product is typed on — the pad has carried the "editing a
// logged set" title since the wave that built it, waiting for this screen to be the caller.
//
// NOTHING HERE PROMISES RECOVERY. There is no trash, no thirty days and no destination in settings:
// what is deleted leaves the log. The one take-back is the five seconds the toast is up, and it is
// real because the write is withheld for exactly that long rather than sent and regretted (Log.jsx).

import React, { useState } from 'react';
import { alsoReadsLabel, fmtKg } from './log.js';
import { fixDraftOf, fixOf, fixSubtitle, keepsItsOwnNumbers, SET_KINDS, withReps, withWeight } from './fix.js';
import { Keypad } from './logger/Keypad.jsx';
import { LADDER_KEYS, ladderLabels } from './logger/ladder.js';

export function FixSheet({ set, movement, session, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState(() => fixDraftOf(set));
  const [typing, setTyping] = useState(null);
  // Both are DOM order and the pairing is by index — the module states it once and this is the one
  // place that relies on it, so the labels and the keys are read together rather than re-derived.
  const rungs = ladderLabels(draft.weightKg);
  const keeps = keepsItsOwnNumbers(session);
  const alsoReads = alsoReadsLabel(draft.weightKg);

  return (
    <>
      <div className="gym-sheet-catch is-dimmed" role="presentation" onClick={onClose}>
        <div className="gym-sheet gym-fix" role="dialog" aria-label="Fix this set" onClick={(event) => event.stopPropagation()}>
          <div className="gym-fix-head">
            <span className="gym-fix-title">Fix this set</span>
            <span className="gym-fix-sub">{fixSubtitle(movement, set)}</span>
            {/* The design draws no way out but Save, which a phone answers with a swipe down and a
                desk cannot. A draft dropped by an accidental click on the scrim would be a silent
                revert — the one thing the keypad beside this sheet exists to refuse — so the exit
                is a control a lifter can aim at. */}
            <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">×</button>
          </div>

          <button type="button" className="gym-fix-weight" onClick={() => setTyping('weight')}>
            <span className="gym-fix-kg">{fmtKg(draft.weightKg)}</span>
            <span className="gym-fix-unit">kg</span>
          </button>
          {/* THE SAME WEIGHT, THE WAY THE SESSION BEHIND THIS SHEET READS IT. The number here is a
              kilogram FIELD — what is typed lands in the log as it stands — while the row being
              corrected shows the account's own reading two inches behind it, dimmed but legible. In
              pounds those are two numerals for one set, and a lifter has no way to know that. Null
              in kilograms, where they are the same number. */}
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

          <button type="button" className="gym-fix-save" onClick={() => onSave(fixOf(set, draft))}>Save the fix</button>

          <div className="gym-fix-foot">
            <button type="button" className="gym-fix-delete" onClick={onDelete}>Delete set</button>
            {keeps && <span className="gym-fix-keeps">{keeps}</span>}
          </div>
        </div>
      </div>
      {/* Beside the sheet and never inside it, exactly as the routine editor's target sheet has it:
          the keypad brings its own tap-to-commit surface, and nested inside this one a tap on it
          would close the sheet under the number it had just set. */}
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
