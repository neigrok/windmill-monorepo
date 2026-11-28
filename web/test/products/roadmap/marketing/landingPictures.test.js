import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// `node --test` speaks no JSX, so the shared loader compiles the pictures on the way in.
register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ForkTree, HeroTree, PathCards, StepPanel, UnlockStages } = await import('../../../../src/products/roadmap/marketing/LandingPictures.jsx');

const drawn = (Picture, stage) => renderToStaticMarkup(React.createElement(Picture, { stage }));
const trees = (markup) => markup.split('<div class="rmTree"').slice(1);
const arrivalOf = (tree) => /^ data-arrival="(\w+)"/.exec(tree)?.[1] ?? null;
const open = (tree) => (tree.match(/class="nd nd-avail/g) ?? []).length;

test('the tree pictures pulse their open steps when the pointer arrives: seven on the wide hero, three on the narrow and on the fork', () => {
  const pictures = [[HeroTree, 'wide'], [HeroTree, 'narrow'], [ForkTree, 'wide'], [ForkTree, 'narrow']].map(([Picture, stage]) => trees(drawn(Picture, stage)));
  assert.deepEqual(pictures.map((each) => each.map((tree) => [arrivalOf(tree), open(tree)])), [[['frontier', 7]], [['frontier', 3]], [['frontier', 3]], [['frontier', 3]]]);
});

test('the unlock plays on the finished beat alone: the beat before it plays nothing', () => {
  const [before, after] = trees(drawn(UnlockStages, 'wide'));
  assert.deepEqual([arrivalOf(before), arrivalOf(after)], [null, 'unlock']);
  assert.deepEqual([before, after].map((tree) => (tree.match(/rmTree-travel|is-opened/g) ?? []).length), [0, 4]);
  assert.equal(trees(drawn(UnlockStages, 'narrow'))[1], after);
});

test('the unlock times its travels by each branch\'s length, wakes each opened step at 85% of its travel and pulses both after the later wake', () => {
  const [, after] = trees(drawn(UnlockStages, 'wide'));
  const lit = [...after.matchAll(/<path class="rmTree-edge is-lit" d="([^"]+)">/g)].map(([, d]) => d);
  const travels = [...after.matchAll(/<g class="rmTree-travel" style="--length:([\d.]+)px;--travel-at:(\d+)ms;--travel:(\d+)ms"><path class="rmTree-tail" d="([^"]+)"><\/path><path class="rmTree-head" d="\4">/g)]
    .map(([, length, at, travel, d]) => ({ length: Number(length), at: Number(at), travel: Number(travel), d }));
  assert.deepEqual(travels.map(({ d, at }) => [d, at]), lit.map((d) => [d, 280]));
  for (const { length, travel, d } of travels) {
    const [x1, y1, bend, , , , x2, y2] = d.match(/[\d.]+/g).map(Number);
    assert.ok(length >= Math.hypot(x2 - x1, y2 - y1) && length <= (bend - x1) + Math.abs(y2 - y1) + (x2 - bend), `${length}px for a branch from ${x1},${y1} to ${x2},${y2}`);
    assert.equal(travel, Math.round(Math.min(420, Math.max(180, (length / 540) * 1000))));
  }

  const opened = [...after.matchAll(/<div class="nd nd-avail is-opened" style="left:(\d+)px;top:(\d+)px;[^"]*--wake-at:(\d+)ms;--pulse-at:(\d+)ms"><\/div><div class="ndlabel"[^>]*>([^<]+)</g)]
    .map(([, x, y, wakeAt, pulseAt, name]) => ({ name, end: `${x},${y}`, wakeAt: Number(wakeAt), pulseAt: Number(pulseAt) }));
  const travelTo = (end) => travels.find(({ d }) => d.endsWith(` ${end}`)).travel;
  assert.deepEqual(opened.map(({ name }) => name), ['Sail trim', 'Points of sail']);
  assert.deepEqual(opened.map(({ end, wakeAt }) => wakeAt - Math.round(280 + 0.85 * travelTo(end))), [0, 0]);
  const pulseAt = Math.max(...opened.map(({ wakeAt }) => wakeAt)) + 480;
  assert.deepEqual(opened.map((step) => step.pulseAt), [pulseAt, pulseAt]);
  assert.ok(pulseAt > 1000 && pulseAt < 1100, `the pulse starts ${pulseAt}ms in`);
  assert.match(after, /<div class="nd nd-done" style="left:84px;top:98px;/);
});

test('no landing picture holds a control, a tab stop or a link', () => {
  const stages = [[HeroTree, ['narrow', 'wide']], [UnlockStages, ['narrow', 'wide']], [PathCards, ['narrow', 'wide']], [StepPanel, ['panel']], [ForkTree, ['narrow', 'wide']]];
  for (const [Picture, names] of stages) {
    for (const stage of names) assert.doesNotMatch(drawn(Picture, stage), /<(a|button|input|details|summary)[ >]|tabindex|href=/i, `${Picture.name} at ${stage}`);
  }
});
