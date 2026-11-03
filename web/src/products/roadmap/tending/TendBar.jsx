import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../../design-system';
import { useDialogFocus } from '../../../design-system/feedback/Dialog.jsx';
import { coverBeneath, useComposerViewport } from '../board/composerFocus.js';
import { ASK_AI_PLACEHOLDER, ROADMAP_VERBS } from '../board/copy.js';

export function TendBar({
  presentation,
  topInset = 0,
  placeholder = ASK_AI_PLACEHOLDER.wide,
  examples = [],
  working,
  onSubmit,
  onDismiss,
  portalTarget,
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  const docked = presentation === 'docked';
  const formRef = useRef(null);
  const layerRef = useRef(null);
  const viewport = useComposerViewport(docked);

  useEffect(() => coverBeneath(layerRef.current), []);
  const dialogFocus = useDialogFocus({ open: true, cardRef: formRef, onClose: onDismiss, preserveOutsideFocus: true });

  useEffect(() => {
    if (!working) inputRef.current?.focus();
  }, [working]);

  const submit = (event) => {
    event.preventDefault();
    const prompt = value.trim();
    if (!prompt || working) return;
    onSubmit(prompt);
    setValue('');
    if (docked) onDismiss?.();
  };

  const starters = !working && !value && examples.length > 0 && (
    <div style={exampleRow}>
      {examples.map((example) => (
        <button key={example} type="button" style={exampleChip}
          onClick={() => {
            setValue(example);
            inputRef.current?.focus();
          }}>
          {example}
        </button>
      ))}
    </div>
  );

  const bar = (
    <form
      ref={formRef}
      role="dialog"
      aria-modal
      aria-label={ROADMAP_VERBS.askAI}
      tabIndex={-1}
      onSubmit={submit}
      onKeyDown={dialogFocus}
      style={formStyles[presentation]}
    >
      {starters}
      <div style={shell}>
        <span style={mark}><Icon name="sparkles" size={17} /></span>
        {working ? (
          <div style={thinking}><span style={dot} />Updating roadmap…</div>
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
        <button type="submit" aria-label="Ask AI" disabled={working || !value.trim()} style={{ ...send, opacity: !working && value.trim() ? 1 : 0.35 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </form>
  );

  const overlayStyle = {
    ...scrim,
    paddingTop: docked ? 0 : topInset,
    alignItems: docked ? 'flex-end' : 'flex-start',
    paddingBottom: docked ? 12 : 0,
    ...viewport.style,
  };
  const dismissScrim = (event) => {
    if (event.target === event.currentTarget) onDismiss?.();
  };
  return createPortal(
    <div ref={layerRef} className="st-tend-overlay" data-presentation={presentation} style={overlayStyle} onClick={dismissScrim}>{bar}</div>,
    portalTarget,
  );
}

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
const scrim = {
  position: 'fixed', inset: 0, zIndex: 30, display: 'flex', justifyContent: 'center', boxSizing: 'border-box',
  background: 'var(--surface-overlay)', pointerEvents: 'auto',
};
const formStyles = {
  overlay: { width: 'min(560px, calc(100vw - 48px))' },
  docked: { width: 'calc(100% - 24px)' },
};
const exampleRow = { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 };
const exampleChip = {
  display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 12px',
  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-full)',
  background: 'var(--surface-card)', boxShadow: 'var(--shadow-sm)',
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', fontWeight: 600,
  color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
};
