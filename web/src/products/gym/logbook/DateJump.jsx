import React, { useEffect, useRef, useState } from 'react';

export function DateJump({ year, month, months, onChange, failure = false, onRetry }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const popup = useRef(null);
  const layer = useRef(null);
  const available = [...new Set(months.map((entry) => Number(entry.month.slice(0, 4))))].sort((a, b) => b - a);
  const shownYear = year ?? available[0];
  const shownMonths = months.filter((entry) => Number(entry.month.slice(0, 4)) === shownYear);
  const label = month ? `${new Date(year, month - 1, 1).toLocaleDateString('en', { month: 'short' })} ${year}` : year ?? 'All dates';
  useEffect(() => {
    if (!open) return;
    const close = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    const dialog = layer.current;
    if (window.matchMedia?.('(max-width: 800px)').matches && dialog?.showModal) dialog.showModal();
    else if (dialog?.show) dialog.show();
    else dialog?.setAttribute('open', '');
    popup.current?.querySelector('button')?.focus();
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('pointerdown', close); if (dialog?.open) dialog.close?.(); };
  }, [open]);
  return <div className="gym-date-jump" ref={root} onKeyDown={(event) => {
    if (event.key === 'Escape') { setOpen(false); root.current?.querySelector('.gym-date-trigger')?.focus(); }
    if (event.key !== 'Tab' || !open) return;
    const buttons = [...(popup.current?.querySelectorAll('button') ?? [])];
    const next = event.shiftKey ? buttons.at(-1) : buttons[0];
    if (event.target === (event.shiftKey ? buttons[0] : buttons.at(-1))) { event.preventDefault(); next?.focus(); }
  }}>
    <span className="gym-history-filter"><button type="button" className="gym-date-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>{year && <button type="button" aria-label="Clear date filter" onClick={() => onChange({ year: null, month: null })}>×</button>}</span>
    {open && <dialog ref={layer} className="gym-date-layer" aria-label="Jump to date" onCancel={(event) => { event.preventDefault(); setOpen(false); }}><button type="button" className="gym-date-scrim" aria-label="Close date jump" tabIndex={-1} onClick={() => setOpen(false)} /><div ref={popup} className="gym-date-popover">
      <span className="gym-date-handle" aria-hidden="true" /><h2>Jump to date</h2>{failure && <p>Dates didn’t load. <button type="button" onClick={onRetry}>Retry</button></p>}
      <div className="gym-date-choices">{available.map((value) => <button key={value} type="button" aria-pressed={shownYear === value} onClick={() => onChange({ year: value, month: null })}>{value}</button>)}</div>
      {shownYear && <p>{shownYear} · {shownMonths.reduce((total, entry) => total + entry.sessions, 0)} workouts</p>}
      <div className="gym-date-choices">{shownMonths.map((entry) => {
        const value = Number(entry.month.slice(5, 7));
        return <button key={entry.month} type="button" aria-pressed={month === value} onClick={() => { onChange({ year: shownYear, month: value }); setOpen(false); }}>{new Date(shownYear, value - 1, 1).toLocaleDateString('en', { month: 'long' })}</button>;
      })}</div>
      {!months.length && <p>No dates in this history yet.</p>}
    </div></dialog>}
  </div>;
}
