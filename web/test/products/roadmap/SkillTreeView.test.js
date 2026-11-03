import test from 'node:test';
import assert from 'node:assert/strict';
import { closuresIn } from './sourceClosures.js';

const host = await closuresIn('SkillTreeView.jsx');

test('the creation verb opens its composer for the owner on either view', () => {
  for (const [active, owner] of [[true, false], [true, true], [false, false], [false, true]]) {
    const calls = [];
    const open = host.callback('newStepFromBoard', {
      document: { activeElement: null },
      boardActive: active,
      owner,
      setBoardComposer: (draft) => calls.push(['composer', { ...draft }]),
      track: (name, props) => calls.push(['event', name, { ...props }]),
    });
    open('verbs');
    assert.deepEqual(calls, owner ? [
      ['composer', { door: 'verbs', view: active ? 'board' : 'tree', opener: null }],
      ['event', 'roadmap_board_create', { step: 'open', door: 'verbs', view: active ? 'board' : 'graph' }],
    ] : []);
  }
});

test('Graph-toast Undo uses its captured visible origin, otherwise the pressed view switch', () => {
  for (const kind of ['connected', 'removed', 'covered', 'body', 'nonfocusable']) {
    const calls = [];
    const body = { isConnected: true, closest: () => null, focus: () => calls.push('body') };
    const document = { body, activeElement: body };
    const origin = kind === 'body' ? body : {
      isConnected: kind !== 'removed',
      closest: () => kind === 'covered' ? {} : null,
      focus: () => {
        calls.push('origin');
        if (kind !== 'nonfocusable') document.activeElement = origin;
      },
    };
    const undo = host.callback('undoGraphToast', {
      document,
      toast: { focusTarget: origin, action: { run: () => calls.push('undo') } },
      runToastAction: (shown) => {
        shown.action.run();
        calls.push('dismiss');
      },
      requestAnimationFrame: (callback) => callback(),
      identityRef: { current: { querySelector: (selector) => {
        assert.equal(selector, '.st-board-switch-option[aria-pressed="true"]');
        return { focus: () => calls.push('pressed') };
      } } },
    });
    undo();
    const focus = { connected: ['origin'], nonfocusable: ['origin', 'pressed'] }[kind] ?? ['pressed'];
    assert.deepEqual(calls, ['undo', 'dismiss', ...focus]);
  }
});

test('a toast action that opened something keeps focus there', () => {
  const calls = [];
  const dialog = {};
  const body = {};
  const undo = host.callback('undoGraphToast', {
    document: { body, activeElement: dialog },
    toast: { action: { run: () => calls.push('share') } },
    runToastAction: (shown) => shown.action.run(),
    requestAnimationFrame: (callback) => callback(),
    identityRef: { current: { querySelector: () => assert.fail('focus stays with what the action opened') } },
  });
  undo();
  assert.deepEqual(calls, ['share']);
});

test('Graph reveal waits on the selected step, while a repeated selection reveals immediately', () => {
  for (const selected of ['course', 'wind']) {
    const calls = [];
    const graphRevealRef = { current: null };
    const jump = host.callback('revealOnGraph', {
      selectedIdRef: { current: selected }, framing: { graphRevealRef },
      sceneRef: { current: { revealNode: (id) => calls.push(['reveal', id]) } },
      setSelectedId: (id) => calls.push(['select', id]),
    });
    jump('wind');
    assert.deepEqual(calls, selected !== 'wind' ? [['select', 'wind']] : [['reveal', 'wind'], ['select', 'wind']]);
    assert.equal(graphRevealRef.current, selected !== 'wind' ? 'wind' : null);
  }
});

test('host invalidates only receipt-backed Undo, preserving progress and held-delete toasts', () => {
  for (const [act, receipt] of [['create', true], ['recolor', true], ['complete', false], ['delete', false]]) {
    const calls = [];
    const dismiss = host.property('dismissInvalidatedToast', {
      dismissToastIf: (leaves) => { if (leaves({ act, action: { receipt } })) calls.push('dismiss'); },
    });
    dismiss();
    assert.deepEqual(calls, receipt ? ['dismiss'] : []);
  }
});
