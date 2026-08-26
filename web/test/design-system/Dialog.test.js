import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';

import { browserWith, findByClass, loadScreen, renderHook } from '../products/gym/harness.mjs';

const DIALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/design-system/feedback/Dialog.jsx');

test('scrolledToEnd — the end is reached within a couple of pixels, never only on the last one', async () => {
  const { scrolledToEnd } = await loadScreen('design-system/feedback/Dialog.jsx');
  assert.equal(scrolledToEnd({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 }), true, 'a body that fits');
  assert.equal(scrolledToEnd({ scrollTop: 0, scrollHeight: 401, clientHeight: 400 }), true, 'inside the slack');
  assert.equal(scrolledToEnd({ scrollTop: 0, scrollHeight: 900, clientHeight: 400 }), false);
  assert.equal(scrolledToEnd({ scrollTop: 499.5, scrollHeight: 900, clientHeight: 400 }), true, 'a fractional scrollTop still lands');
  assert.equal(scrolledToEnd({ scrollTop: 300, scrollHeight: 900, clientHeight: 400 }), false);
});

test('the scroll gate hands the footer `seen` false until the body has been seen, and true with no gate', async (t) => {
  browserWith();
  const { Dialog } = await loadScreen('design-system/feedback/Dialog.jsx');
  const footer = ({ seen }) => React.createElement('button', { className: 'apply', disabled: !seen }, 'Apply');

  const gated = renderHook(t, () => Dialog({ open: true, onClose: () => {}, gate: 'scrolled', footer, children: 'a long diff' }));
  assert.equal(findByClass(gated.tree, 'apply')[0].props.disabled, true, 'nothing measured, nothing seen');

  const open = renderHook(t, () => Dialog({ open: true, onClose: () => {}, footer, children: 'a short note' }));
  assert.equal(findByClass(open.tree, 'apply')[0].props.disabled, false);

  const plain = renderHook(t, () => Dialog({ open: true, onClose: () => {}, footer: React.createElement('button', { className: 'apply' }, 'Ok'), children: 'x' }));
  assert.equal(findByClass(plain.tree, 'apply').length, 1, 'a footer node still renders as it is');
});

test('the gate re-arms when the body grows past what was seen, and never when the reader scrolls back up', () => {
  const source = fs.readFileSync(DIALOG, 'utf8');
  assert.equal(source.includes('if (scrolledToEnd(body)) {'), true);
  assert.equal(source.includes('seenHeight.current = body.scrollHeight;'), true);
  assert.equal(source.includes('if (seenHeight.current != null && body.scrollHeight > seenHeight.current + 2) setSeen(false);'), true);
  assert.equal(source.includes("onScroll={gated ? measure : undefined}"), true);
  assert.equal(source.includes('new ResizeObserver(measure)'), true, 'a body that fills in later is measured again');
  // The footer stays outside the scrolling body, pinned.
  assert.ok(source.indexOf('overflowY: \'auto\'') < source.indexOf("typeof footer === 'function' ? footer({ seen }) : footer"));
});
