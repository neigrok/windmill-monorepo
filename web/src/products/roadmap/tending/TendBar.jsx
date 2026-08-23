import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../design-system';

export function TendBar({ variant = 'phone', placeholder = 'Tell the tree what to change…', examples = [], working, onSubmit, onDismiss }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  const desktop = variant === 'desktop';

  // Desktop takes focus on open; the phone bar must not raise the keyboard until tapped.
  useEffect(() => {
    if (desktop && !working) inputRef.current?.focus();
  }, [desktop, working]);

  const submit = (event) => {
    event.preventDefault();
    const prompt = value.trim();
    if (!prompt || working) return;
    onSubmit(prompt);
    setValue('');
  };

  const starters = !working && !value && examples.length > 0 && (
    <div style={exampleRow}>
      {examples.map((example) => (
        <button key={example} type="button" style={exampleChip}
          onClick={() => { setValue(example); inputRef.current?.focus(); }}>
          {example}
        </button>
      ))}
    </div>
  );

  const bar = (
    <form
      onSubmit={submit}
      onKeyDown={(event) => { if (event.key === 'Escape') onDismiss?.(); }}
      style={desktop ? deskForm : phoneForm}
    >
      {starters}
      <div style={shell}>
        <span style={mark}><Icon name="sparkles" size={17} /></span>
        {working ? (
          <div style={thinking}><span style={dot} />Tending your tree…</div>
        ) : (
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            maxLength={2000}
            enterKeyHint="send"
            aria-label="Tell the tree what to change"
            style={field}
          />
        )}
        <button type="submit" aria-label="Tend" disabled={working || !value.trim()} style={{ ...send, opacity: !working && value.trim() ? 1 : 0.35 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </form>
  );

  if (!desktop) return bar;
  return (
    <div style={scrim} onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss?.(); }}>
      {bar}
    </div>
  );
}

export default TendBar;

const shell = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
  height: 52, padding: '0 8px 0 14px', boxSizing: 'border-box',
  background: 'var(--surface-card)', border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-full)', boxShadow: 'var(--shadow-lg)',
};
const mark = { flex: 'none', display: 'inline-flex', color: 'var(--color-brand)' };
const field = {
  flex: 1, minWidth: 0, height: '100%', border: 'none', outline: 'none', background: 'transparent',
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-base)', color: 'var(--text-primary)',
};
const thinking = {
  flex: 1, display: 'inline-flex', alignItems: 'center', gap: 9,
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-secondary)',
};
const dot = {
  width: 9, height: 9, borderRadius: 'var(--radius-full)', background: 'var(--kind-gold, #C99A2E)',
  boxShadow: '0 0 0 0 rgba(201,154,46,.5)', animation: 'wmTendBreathe 1400ms var(--ease-soft, ease-in-out) infinite',
};
const send = {
  flex: 'none', width: 38, height: 38, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', borderRadius: 'var(--radius-full)', background: 'var(--color-brand)', color: 'var(--text-on-accent)',
  cursor: 'pointer', transition: 'opacity var(--duration-fast) var(--ease-standard)',
};
const phoneForm = { width: '100%' }; // the lane places it
const scrim = {
  position: 'absolute', inset: 0, zIndex: 30, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  paddingTop: '18vh', background: 'rgba(33,27,19,.14)', pointerEvents: 'auto',
};
const deskForm = { width: 'min(560px, calc(100vw - 48px))' };
const exampleRow = { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 };
const exampleChip = {
  display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 12px',
  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-full)',
  background: 'var(--surface-card)', boxShadow: 'var(--shadow-sm)',
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', fontWeight: 600,
  color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
};
