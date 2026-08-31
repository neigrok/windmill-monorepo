import React, { useEffect, useRef, useState } from 'react';

// The overflow a routine carries, drawn on its row and nowhere else: what a lifter does TO a routine
// rather than in it. It holds Duplicate and Delete — one home each, and this is it. Delete is here
// because the gate 13-gestures.md put in front of it is met: it is withheld, and the room's window
// is the only thing that ever sends it.
//
// It closes on the act, on Escape, and on a pointer landing anywhere outside it, so a menu can never
// be left open behind the screen that opened it.
export function Overflow({ label, items }) {
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
    <span className="gym-overflow" ref={box}>
      <button
        type="button"
        className="gym-overflow-open"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((held) => !held)}
      >
        ⋯
      </button>
      {open && (
        <span className="gym-overflow-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="gym-overflow-item"
              onClick={() => { setOpen(false); item.run(); }}
            >
              {item.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
