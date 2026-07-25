// The progress card (brief #20) is pure — model + score + what lit since the last share, in;
// SVG string, out. These pin the frame it shares with the unfurl card (2400×1260, one element
// per node, the score readout, the watermark), the two things that make it a DIFFERENT picture
// (the ghosted tree behind full-colour new steps, and the "Update #N" series counter), and the
// copy — which says "since I last shared" and never "this week", because with no per-node
// timestamps anywhere in the system a weekly framing would be a decorative lie.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProgressCardSvg } from '../../../src/skilltree/share/progressCard.js';

const NODES = [
  { id: 'root', x: 0, y: 0, emphasis: 1, state: 'complete', color: 'olive' },
  { id: 'a', x: 160, y: 90, emphasis: 0, state: 'complete', color: 'olive' },
  { id: 'b', x: -160, y: 90, emphasis: 0, state: 'complete', color: 'olive' },
  { id: 'c', x: 300, y: 200, emphasis: 0, state: 'available', color: 'gold' },
];

const MODEL = {
  nodes: NODES,
  edges: [
    { from: 'root', to: 'a', kind: 'branch' },
    { from: 'root', to: 'b', kind: 'branch' },
    { from: 'a', to: 'c', kind: 'branch' },
  ],
  bounds: { minX: -160, minY: 0, maxX: 300, maxY: 200 },
};

function cardWith(lit, extra = {}) {
  return buildProgressCardSvg({
    model: MODEL,
    title: 'Learn to sail',
    done: 3,
    total: 4,
    dominantKind: 'olive',
    lit: new Set(lit),
    update: 4,
    ...extra,
  });
}

test('the card is the postcard the unfurl card is: 2400×1260, score, title, watermark, one element per node', () => {
  const svg = cardWith(['a', 'b']);

  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('width="2400" height="1260"'));
  assert.ok(svg.includes('>3/4</text>'));
  assert.ok(svg.includes('Learn to sail'));
  assert.ok(svg.includes('Made with <tspan'));
  assert.ok(svg.includes('>Windmill</tspan>'));
  assert.equal((svg.match(/class="wm-node"/g) || []).length, NODES.length);
});

test('the headline counts what lit since the last share, and says exactly that', () => {
  assert.ok(cardWith(['a', 'b', 'c']).includes('>3 steps since I last shared</text>'));
  assert.ok(cardWith(['a']).includes('>1 step since I last shared</text>'));
});

test('the headline never claims a week — no clock word appears on the card', () => {
  const svg = cardWith(['a', 'b']);
  assert.ok(!svg.includes('this week'));
  assert.ok(!svg.includes('today'));
});

test('the series counter rides the strip as a mono chip', () => {
  assert.ok(cardWith(['a'], { update: 1 }).includes('>Update #1</text>'));
  assert.ok(cardWith(['a'], { update: 12 }).includes('>Update #12</text>'));
});

test('the settled tree is ghosted and only the newly-lit steps burn', () => {
  const svg = cardWith(['a', 'b']);
  assert.equal((svg.match(/<g class="wm-node" opacity="0\.28">/g) || []).length, 2); // root and c
  assert.equal((svg.match(/<g class="wm-node">/g) || []).length, 2);                 // a and b
});

test('the dominant kind tints the rule, the dot, the panel border and the chip', () => {
  const svg = cardWith(['a']);
  assert.ok(svg.includes('#7D8C43'));           // olive base — rule + headline dot
  assert.ok(svg.includes('fill="#D2DAA5"'));    // olive soft — the Update chip
  assert.ok(svg.includes('stroke="#D2DAA5"'));  // olive soft — panel border
  assert.ok(svg.includes('fill="#BC6C42"'));    // terracotta — the Windmill wordmark, always
});

test('a title too wide for the gap between the score bar and the chip is ellipsized', () => {
  const long = 'A roadmap title so absurdly long that it could never fit between the score bar and the update chip without being cut short';
  const svg = cardWith(['a'], { title: long });
  assert.ok(svg.includes('…'));
  assert.ok(!svg.includes(long));
});

test('nothing lit since the last share is refused, never dressed up as a post', () => {
  assert.throws(() => cardWith([]), /at least one step lit/);
  assert.throws(() => buildProgressCardSvg({ model: MODEL, title: 'x', done: 1, total: 4, dominantKind: 'olive', update: 2 }), /at least one step lit/);
});
