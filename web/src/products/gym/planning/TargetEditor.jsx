import React, { useEffect, useId, useRef, useState } from 'react';
import { Button, Icon } from '../../../design-system/index.js';
import { alsoReadsLabel, schemeAgrees } from '../log.js';
import {
  ADD_SET, commitLabel, EVERY_SET, FILL, headOf, isOpenFields, ladderOf, LAST_TIME_PLACEHOLDER,
  MATCH_SET_ONE, MAX_PLACEHOLDER, OPEN_LINE, RAMP_UP, rampDisabled, SET_BY_SET,
  targetEntryOf, targetFieldsOf, targetRefusal, withHead, withMatchedToFirst, withRampUp,
  withRow, withRowAdded, withRowRemoved, withSignFlipped,
} from '../routines.js';

export function TargetEditor({ movement, place, panePlace = place, entry, equipment, neverLogged, onSet, onClose, onDraft = null, pane = false }) {
  const [fields, setFields] = useState(() => targetFieldsOf(entry));
  const initial = useRef(fields).current;
  const originalRows = ladderOf(initial);
  const originalHead = headOf(initial);
  const ids = useId();
  const change = (next) => {
    setFields(next);
    onDraft?.(targetRefusal(next) ? null : targetEntryOf(entry, next));
  };
  const refusal = targetRefusal(fields);
  const open = isOpenFields(fields);
  const head = headOf(fields);
  const ladder = ladderOf(fields);
  // Nothing is derived from a refused field: while one stands, the button says only what it is.
  const held = refusal ? null : targetEntryOf(entry, fields);
  // The pounds reading is honest only for a scheme with one load to read.
  const alsoReads = held?.sets && schemeAgrees(held.sets) ? alsoReadsLabel(held.sets[0].weightKg ?? null) : null;
  // `±` is drawn only where a negative load means something: band assistance on a bodyweight movement.
  const signed = equipment === 'bodyweight';
  const rowRefusal = (index, field) => (refusal?.row === index && refusal.field === field ? refusal.message : undefined);
  const rowId = (index, field) => `${ids}-row-${index}-${field}`;
  // Enter walks the same column down the ladder, so a ramp is typed top to bottom without a mouse.
  const nextDown = (index, field) => (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    globalThis.document?.getElementById?.(rowId(index + 1, field))?.focus();
  };
  const sign = (flip) => (
    <button type="button" className="gym-target-sign" aria-label="Flip the sign — band-assisted" onClick={flip}>
      ±
    </button>
  );

  return (
    <div className={pane ? "gym-target-pane" : "gym-sheet-catch"} role="presentation" onClick={pane ? undefined : onClose}>
      <div className={pane ? "gym-target" : "gym-sheet gym-target"} role={pane ? "region" : "dialog"} aria-label={`Target · ${movement}`} onClick={(event) => event.stopPropagation()}>
        <div className="gym-sheet-head">
          <span className="gym-target-movement">{movement}</span>
          <span className="gym-target-place"><span className="gym-target-sheet-place">{place}</span>{pane && <span className="gym-target-pane-place">{panePlace}</span>}</span>
          <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={12} />
          </button>
        </div>
        {neverLogged && <p className="gym-target-never">Never logged — these are your numbers.</p>}

        {!refusal && isOpenFields(fields) && <p className="gym-open-line">{OPEN_LINE}</p>}

        <section className="gym-sheet-section">
          <div className="gym-sheet-section-head">
            <h3 className="gym-sheet-section-title">{EVERY_SET}</h3>
          </div>
          <div className="gym-target-fields">
            <fieldset className="gym-target-head" disabled={open}>
              <EditableNumber
                label="Reps"
                value={head.reps.value}
                placeholder={head.reps.placeholder}
                inputMode="numeric"
                onChange={(event) => change(withHead(fields, 'reps', event.target.value))}
              />
              <EditableNumber
                label="Weight · kg"
                value={head.weight.value}
                placeholder={head.weight.placeholder}
                inputMode="decimal"
                onChange={(event) => change(withHead(fields, 'weight', event.target.value))}
                trailing={signed && sign(() => change(withSignFlipped(fields)))}
              />
            </fieldset>
          </div>
        </section>

        <section className="gym-sheet-section">
            <div className="gym-sheet-section-head">
              <h3 className="gym-sheet-section-title">{SET_BY_SET}</h3>
              <FillMenu
                items={[
                  { label: RAMP_UP, description: 'Interpolate set 1 to set n', disabled: rampDisabled(fields), run: () => change(withRampUp(fields)) },
                  { label: MATCH_SET_ONE, description: 'Write set 1 into every row', disabled: false, run: () => change(withMatchedToFirst(fields)) },
                ]}
              />
            </div>
            <ul className="gym-ladder">
              {ladder.map((row, index) => (
                <li className="gym-ladder-row" key={index}>
                  <span className="gym-ladder-tick" aria-hidden="true" />

                  <span className="gym-ladder-field" onKeyDown={nextDown(index, 'reps')}>
                    <EditableNumber
                      id={rowId(index, 'reps')}
                      ariaLabel={`Set ${index + 1} reps`}
                      value={row.reps}
                      changed={row.reps !== originalRows[index]?.reps || Boolean(head.reps.value && head.reps.value !== originalHead.reps.value)}
                      placeholder={MAX_PLACEHOLDER}
                      inputMode="numeric"
                      error={rowRefusal(index, 'reps')}
                      onChange={(event) => change(withRow(fields, index, 'reps', event.target.value))}
                    />
                  </span>
                  <span className="gym-ladder-field is-load" onKeyDown={nextDown(index, 'weight')}>
                    <EditableNumber
                      id={rowId(index, 'weight')}
                      ariaLabel={`Set ${index + 1} load`}
                      value={row.weight}
                      changed={row.weight !== originalRows[index]?.weight || Boolean(head.weight.value && head.weight.value !== originalHead.weight.value)}
                      placeholder={LAST_TIME_PLACEHOLDER}
                      inputMode="decimal"
                      error={rowRefusal(index, 'weight')}
                      onChange={(event) => change(withRow(fields, index, 'weight', event.target.value))}
                      trailing={signed && sign(() => change(withSignFlipped(fields, index)))}
                    />
                  </span>
                  <button
                    type="button"
                    className="gym-ladder-drop"
                    aria-label={`Delete set ${index + 1}`}
                    onClick={() => change(withRowRemoved(fields, index))}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </li>
              ))}
              <li className="gym-ladder-row is-add">
                <button type="button" className="gym-ladder-add" onClick={() => change(withRowAdded(fields))}>
                  {ADD_SET}
                </button>
                {refusal?.field === 'add' && <span className="gym-ladder-refusal">{refusal.message}</span>}
              </li>
            </ul>
          </section>


        {alsoReads && <p className="gym-target-reads">{alsoReads}</p>}

        <div className="gym-target-done"><Button full disabled={held == null} onClick={() => onSet(held)}>
          {held == null ? 'Set' : commitLabel(held)}
        </Button></div>
      </div>
    </div>
  );
}

function FillMenu({ items }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (!box.current?.contains(event.target)) setOpen(false); };
    const key = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <span className="wm-menu gym-fill" ref={box}>
      <button
        type="button"
        className="gym-fill-open"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((held) => !held)}
      >
        {FILL}
      </button>
      {open && (
        <span className="wm-menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="wm-menu-item"
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.run(); }}
            >
              <span>{item.label}</span>
              <span className="gym-fill-description">{item.description}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}


function EditableNumber({ id, label, ariaLabel, value, placeholder, inputMode, error, onChange, trailing, changed = false }) {
  const generated = useId();
  const inputId = id ?? generated;
  return <div className={`gym-plan-number${changed ? ' is-changed' : ''}`} style={{ '--gym-number-chars': Math.max(2, String(value || placeholder || '').length) }}>
    {label && <label htmlFor={inputId}>{label}</label>}
    <div className="gym-plan-number-field">
      <input id={inputId} aria-label={ariaLabel} value={value} placeholder={placeholder}
        inputMode={inputMode} onChange={onChange} aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined} />
      {trailing}
    </div>
    {error && <p id={`${inputId}-error`} role="alert">{error}</p>}
  </div>;
}
