import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../jsxLoader.mjs', import.meta.url);
const { ErrorBoundary } = await import('../../src/design-system/feedback/ErrorBoundary.jsx');

function crashed(props) {
  const boundary = new ErrorBoundary(props);
  boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('boom'));
  return boundary;
}

test('ErrorBoundary — an owner’s onCrash takes the report and its fallback replaces the crash screen, even when it is nothing', () => {
  const reported = [];
  const boundary = crashed({ fallback: null, onCrash: (error) => reported.push(error.message), children: 'board' });
  boundary.componentDidCatch(new Error('boom'));
  assert.deepEqual(reported, ['boom']);
  assert.equal(boundary.render(), null);
});

test('ErrorBoundary — without a fallback it renders the crash screen, and before a crash its children', () => {
  assert.equal(crashed({ children: 'board' }).render().type.name, 'CrashFallback');
  assert.equal(new ErrorBoundary({ children: 'board' }).render(), 'board');
});
