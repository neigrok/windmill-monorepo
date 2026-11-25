import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

// One choice of a short list: a button showing the current option and, while open, its listbox below it. Enter, Space or
// ↓ opens it on the current option; ↑ and ↓ move, Enter or Space chooses, and Escape, Tab or a pointer landing outside
// closes it, the focus staying on the button throughout. `compact` is a settings row's: no label, the value in mono, and
// the listbox under the button's right edge with a check by the current option; `labelledBy` then names it from the row.
// Opening it, or moving with the arrows, scrolls the option it lands on into view. Styled by `.wm-select-*` in
// styles/global.css.
export function Select({ label, value, onChange, options, compact = false, labelledBy }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef(null);
  const steered = useRef(false);
  const shownFirst = useRef(value);
  const id = useId();
  const chosen = Math.max(0, options.findIndex((option) => option.value === value));
  const current = options[chosen];

  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (!box.current?.contains(event.target)) setOpen(false); };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => {
    if (!open || !steered.current) return;
    steered.current = false;
    document.getElementById?.(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);

  const steer = (index) => { steered.current = true; setActive(index); };
  const show = () => { steer(chosen); setOpen(true); };
  const choose = (option) => {
    setOpen(false);
    if (option.value !== value) onChange?.(option.value);
  };
  const keyDown = (event) => {
    if (!open) {
      if (!['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      show();
      return;
    }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (!['Escape', 'Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') setOpen(false);
    else if (event.key === 'ArrowDown') steer(Math.min(options.length - 1, active + 1));
    else if (event.key === 'ArrowUp') steer(Math.max(0, active - 1));
    else choose(options[active]);
  };

  return (
    <div className={compact ? 'wm-select is-compact' : 'wm-select'} ref={box}>
      {label && !compact && <span className="wm-select-label" id={`${id}-label`}>{label}</span>}
      <button
        type="button"
        role="combobox"
        className="wm-select-open"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-labelledby={labelledBy ?? (label && !compact ? `${id}-label` : undefined)}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={keyDown}
      >
        <span key={current?.value} className={current?.value === shownFirst.current ? 'wm-select-value' : 'wm-select-value is-new'}>
          {current?.label}
        </span>
        {compact ? <ChevronDown size={16} aria-hidden="true" className="wm-select-chevron" />
          : <span aria-hidden="true" className="wm-select-chevron">▾</span>}
      </button>
      {open && (
        <div className="wm-select-list" role="listbox" id={`${id}-list`}>
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === chosen}
              className={`wm-select-option${index === chosen ? ' is-current' : ''}${index === active ? ' is-active' : ''}`}
              onPointerDown={(event) => event.preventDefault()}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              <span className="wm-select-option-label">{option.label}</span>
              {compact && index === chosen && <Check size={16} aria-hidden="true" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
