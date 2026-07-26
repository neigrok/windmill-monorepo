// The one crash net (observability): a render/lifecycle error anywhere below is caught here
// so it becomes a recoverable screen with a Reload — never the blank white page an uncaught
// throw leaves behind (which is invisible in prod). componentDidCatch beacons the crash so a
// broken screen is queryable, not silent. Global (non-React) errors are reported from main.jsx.

import React from 'react';
import { reportError } from '../../telemetry/beacon.js';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false };
  }

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error) {
    reportError(error, 'render');
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return <CrashFallback />;
  }
}

function CrashFallback() {
  return (
    <div style={wrap} role="alert">
      <div style={mark}>Windmill</div>
      <p style={line}>Something went wrong on this screen.</p>
      <button type="button" style={button} onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}

const wrap = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--space-4)',
  background: 'var(--surface-canvas)',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-body)',
  textAlign: 'center',
  padding: 'var(--space-6)',
};
const mark = {
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  fontSize: 'var(--text-xl)',
  letterSpacing: 'var(--tracking-wide)',
  color: 'var(--text-tertiary)',
};
const line = { margin: 0, fontSize: 'var(--text-base)' };
const button = {
  minHeight: 44,
  padding: '0 var(--space-5)',
  borderRadius: 'var(--radius-full)',
  border: 'none',
  background: 'var(--color-brand)',
  color: 'var(--text-on-accent)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  cursor: 'pointer',
};

export default ErrorBoundary;
