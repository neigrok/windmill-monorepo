import React, { useState } from 'react';
import { alsoReadsLabel, fmtKg } from './log.js';
import { fixDraftOf, fixOf, fixSubtitle, keepsItsOwnNumbers, SET_KINDS, withReps, withWeight } from './fix.js';
import { Keypad } from './logger/Keypad.jsx';
import { LADDER_KEYS, ladderLabels } from './logger/ladder.js';

export function FixSheet({ set, movement, session, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState(() => fixDraftOf(set));
  const [typing, setTyping] = useState(null);
  // `LADDER_KEYS` and these labels pair by index.
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

          <button type="button" className="gym-fix-save" onClick={() => onSave(fixOf(set, draft))}>Save the fix</button>

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
