import React from 'react';

// One field, its label, and the one thing it refuses, drawn under it. `error` is a sentence the
// caller decided, never a state this component invents.
//
// The caption is the field's NAME and nothing else is: the refusal, the unit in `trailing` and any
// note the caller points at with `describedBy` are its DESCRIPTION, reached through
// `aria-describedby`. So the box and the refusal sit outside the `<label>`, which reaches the field
// by `htmlFor` — a label wrapped around all three would read `Weight kg Over 500 kg — check the
// number.` as the name of the field every time focus landed on it.
//
// The focus edge is `--field-focus-edge`, a role a room may answer for itself; the family's answer
// is the brand's own 400.
export function Input({
  label,
  placeholder,
  value,
  onChange,
  error,
  type = 'text',
  icon = null,
  autoFocus = false,
  inputMode = undefined,
  maxLength = undefined,
  ariaLabel = null,
  id = undefined,
  trailing = null,
  describedBy = null,
}) {
  const [focus, setFocus] = React.useState(false);
  const generated = React.useId();
  const fieldId = id ?? generated;
  const errorId = `${fieldId}-refusal`;
  const described = [error ? errorId : null, describedBy].filter((each) => each != null).join(' ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-body)' }}>
      {label && (
        <label htmlFor={fieldId} style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>
          {label}
        </label>
      )}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--surface-card)',
          border: `1.5px solid ${error ? 'var(--color-danger)' : focus ? 'var(--field-focus-edge)' : 'var(--border-default)'}`,
          boxShadow: focus ? 'var(--focus-ring)' : 'none',
          transition: 'box-shadow var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)',
        }}
      >
        {icon && <span style={{ width: 16, height: 16, color: 'var(--text-tertiary)' }}>{icon}</span>}
        <input
          id={fieldId}
          type={type}
          inputMode={inputMode}
          maxLength={maxLength}
          aria-label={ariaLabel ?? undefined}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={described === '' ? undefined : described}
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          autoFocus={autoFocus}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            border: 'none',
            outline: 'none',
            background: 'transparent',
            font: 'inherit',
            fontSize: 'var(--text-base)',
            color: 'var(--text-primary)',
            width: '100%',
          }}
        />
        {trailing}
      </span>
      {error && <span id={errorId} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-danger)' }}>{error}</span>}
    </div>
  );
}
