import React, { useRef } from 'react';

// Tabs that switch a view in place: a `tablist` of `tab`s, one selected, its arrows moving the selection. `variant`
// draws them as the segmented pill (`pill`) or as words over a hairline, the selected one underlined in brand (`line`).
// `label` names the list for a screen reader; with `id`, each tab is `${id}-${value}` and says it controls
// `${id}-${value}-panel`, which the caller gives its `tabpanel`. `TabRail.jsx` is the rail that switches a room.
export function Tabs({ tabs, value, onChange, variant = 'pill', label = undefined, id = undefined }) {
  const list = useRef(null);
  const line = variant === 'line';
  const choose = (event) => {
    const at = tabs.findIndex((tab) => tab.value === value);
    const by = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (by === undefined || at === -1) return;
    event.preventDefault();
    const next = tabs[(at + by + tabs.length) % tabs.length];
    onChange?.(next.value);
    list.current?.querySelectorAll('[role="tab"]')[tabs.indexOf(next)]?.focus();
  };
  return (
    <div ref={list} role="tablist" aria-label={label} onKeyDown={choose}
      style={line
        ? { display: 'flex', gap: 'var(--space-5)', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'var(--font-body)' }
        : { display: 'flex', gap: 4, padding: 4, background: 'var(--surface-sunken)', borderRadius: 'var(--radius-full)', width: 'fit-content', fontFamily: 'var(--font-body)' }}>
      {tabs.map((tab) => {
        const isActive = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={id === undefined ? undefined : `${id}-${tab.value}`}
            aria-controls={id === undefined ? undefined : `${id}-${tab.value}-panel`}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange?.(tab.value)}
            style={line ? {
              padding: '0 0 8px',
              marginBottom: -1,
              border: 'none',
              borderBottom: `2px solid ${isActive ? 'var(--color-brand)' : 'transparent'}`,
              background: 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-tertiary)',
              font: '700 14px/20px var(--font-body)',
              cursor: 'pointer',
            } : {
              padding: '8px 18px',
              borderRadius: 'var(--radius-full)',
              border: 'none',
              background: isActive ? 'var(--surface-card)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: 700,
              fontSize: 'var(--text-sm)',
              boxShadow: isActive ? 'var(--shadow-xs)' : 'none',
              cursor: 'pointer',
              transition: 'background var(--duration-base) var(--ease-soft), box-shadow var(--duration-base) var(--ease-soft)',
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
