import React from 'react';

// Name the field through htmlFor; associate units and refusals through aria-describedby.
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
