import React, { useEffect, useRef, useState } from 'react';

// An overflow menu: one opener and the short list of acts it holds, the opener ⋯ unless `trigger` draws it, as a
// heading that is also a menu does. `label` names the opener for a screen reader; each item is `{ label, run }`, with an
// `icon` drawn before its words and `tone: 'danger'` for a destructive act. It closes on the act, on Escape, and on a
// pointer landing anywhere outside it, so a menu can never be left open behind the screen that opened it. Styled by
// `.wm-menu-*` in styles/global.css off the shared roles, so it resolves into any room.
export function Menu({ label, items, trigger = null }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (!box.current?.contains(event.target)) setOpen(false); };
    const key = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <span className="wm-menu" ref={box}>
      <button
        type="button"
        className={trigger ? 'wm-menu-open is-labelled' : 'wm-menu-open'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((held) => !held)}
      >
        {trigger ?? '⋯'}
      </button>
      {open && (
        <span className="wm-menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.tone === 'danger' ? 'wm-menu-item is-danger' : 'wm-menu-item'}
              onClick={() => { setOpen(false); item.run(); }}
            >
              {item.icon ?? null}
              {item.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
