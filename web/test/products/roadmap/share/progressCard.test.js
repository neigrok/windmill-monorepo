// The progress card (brief #20, reconciled to canon) is pure — model + score + what lit this
// period, in; SVG string, out. These pin what makes it a card in a SERIES rather than a second
// unfurl: a frame that does not move as the tree fills, ink that shows the route taken, a hue
// taken from the new work so two consecutive posts differ by construction, the stamp-led strip,
// and the ledger that makes the series visible.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProgressCardSvg } from '../../../../src/products/roadmap/share/progressCard.js';

// One plan, worked to whatever point a test needs. Node ids are the order they complete in, so
// `treeAt(6)` and `treeAt(11)` are the same tree two periods apart.
const PLAN = [
  { id: 'root', x: 0, y: 0, emphasis: 1, color: 'olive' },
  { id: 'n1', x: 160, y: 90, emphasis: 0, color: 'olive' },
  { id: 'n2', x: -160, y: 90, emphasis: 0, color: 'olive' },
  { id: 'n3', x: 320, y: 180, emphasis: 0, color: 'gold' },
  { id: 'n4', x: -320, y: 180, emphasis: 0, color: 'gold' },
  { id: 'n5', x: 480, y: 270, emphasis: 0, color: 'sky' },
  { id: 'n6', x: -480, y: 270, emphasis: 0, color: 'sky' },
  { id: 'n7', x: 160, y: 360, emphasis: 0, color: 'plum' },
  { id: 'n8', x: -160, y: 360, emphasis: 0, color: 'plum' },
  { id: 'n9', x: 320, y: 450, emphasis: 0, color: 'brick' },
  { id: 'n10', x: -320, y: 450, emphasis: 0, color: 'brick' },
  { id: 'n11', x: 0, y: 540, emphasis: 0, color: 'terracotta' },
];

const LINKS = [
  ['root', 'n1'], ['root', 'n2'], ['n1', 'n3'], ['n2', 'n4'], ['n3', 'n5'], ['n4', 'n6'],
  ['n1', 'n7'], ['n2', 'n8'], ['n7', 'n9'], ['n8', 'n10'], ['n9', 'n11'],
];

function treeAt(doneCount, plan = PLAN) {
  const nodes = plan.map((node, i) => ({ ...node, state: i < doneCount ? 'complete' : i === doneCount ? 'available' : 'locked' }));
  const xs = plan.map((node) => node.x);
  const ys = plan.map((node) => node.y);
  return {
    nodes,
    edges: LINKS.filter(([from, to]) => plan.some((n) => n.id === from) && plan.some((n) => n.id === to))
      .map(([from, to]) => ({ from, to, kind: 'branch' })),
    bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
  };
}

function cardOf(extra = {}) {
  return buildProgressCardSvg({
    model: treeAt(6),
    title: 'Learn to sail',
    done: 6,
    total: 12,
    lit: new Set(['n3', 'n4', 'n5']),
    period: 'Update #4',
    ...extra,
  });
}

// The world window the portrait is fitted into — the card's frame, and the thing that must not
// move from one period to the next.
function frameOf(svg) {
  return svg.match(/viewBox="([^"]+)" preserveAspectRatio/)[1];
}

test('the card is the postcard the unfurl card is: 2400×1260, score, title, watermark, one element per node', () => {
  const svg = cardOf();

  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('width="2400" height="1260"'));
  assert.ok(svg.includes('>6/12</text>'));
  assert.ok(svg.includes('>Learn to sail</text>'));
  assert.ok(svg.includes('Made with <tspan'));
  assert.ok(svg.includes('>Windmill</tspan>'));
  assert.equal((svg.match(/class="wm-node"/g) || []).length, PLAN.length);
});

test('the frame does not move as the tree fills — week 4 sits exactly where week 3 sat', () => {
  const week3 = cardOf({ model: treeAt(6), done: 6 });
  const week4 = cardOf({ model: treeAt(11), done: 11, lit: new Set(['n6', 'n7', 'n8', 'n9', 'n10']) });

  assert.equal(frameOf(week3), frameOf(week4));
  // …and it is the box the whole plan occupies, measured as if every step were lit.
  assert.equal(frameOf(week3), '-659.11 -167.21 1318.22 854.33');
  // Nothing about progress reaches the frame: an untouched tree frames the same as a finished one.
  assert.equal(frameOf(cardOf({ model: treeAt(0), done: 0 })), frameOf(cardOf({ model: treeAt(12), done: 12 })));
});

test('the frame DOES re-fit when the plan itself changes, which is the only thing that should move it', () => {
  const planted = cardOf({ model: treeAt(6, [...PLAN, { id: 'n12', x: 900, y: 700, emphasis: 0, color: 'olive' }]) });
  assert.notEqual(frameOf(planted), frameOf(cardOf()));
});

test('the ink shows the route: the edge into each new step is that step’s kind at full alpha', () => {
  const svg = cardOf({ lit: new Set(['n3']) });

  // n1 → n3 is the route home for the one step that lit; it is drawn in n3's gold, thicker.
  assert.ok(svg.includes('stroke="#C4972F" stroke-width="2.18" stroke-linecap="round" opacity="1"'));
  // Everything settled recedes: lit branches to bark at 34%, dormant ones thin at 50%.
  assert.ok(svg.includes('stroke="#9C6B44" stroke-width="1.96" stroke-linecap="round" opacity="0.34"'));
  assert.ok(svg.includes('stroke="#D3C2A0" stroke-width="1.4" stroke-linecap="round" opacity="0.5"'));
  // The halo is what "new" looks like, so exactly one node wears one.
  assert.equal((svg.match(/filter="url\(#wm-glow-\d+\)"/g) || []).length, 1);
});

test('the hue is the dominant kind among the NEW steps, not the tree’s', () => {
  // The tree is olive-heavy, but this period was gold: gold must rule the card.
  const gold = cardOf({ lit: new Set(['n3', 'n4']) });
  assert.ok(gold.includes(`<rect x="0" y="0" width="2400" height="12" fill="#C4972F"/>`)); // the rule
  assert.ok(gold.includes('stroke="#EEDA9E"'));                                            // the panel border
  assert.ok(gold.includes('fill="#EEDA9E"'));                                              // the stamp
  assert.ok(gold.includes('fill="rgba(196,151,47,.16)"'));                                 // the period chip

  // The next period is sky, and the two cards are different pictures without anyone deciding so.
  const sky = cardOf({ lit: new Set(['n5', 'n6']) });
  assert.ok(sky.includes(`<rect x="0" y="0" width="2400" height="12" fill="#5F8494"/>`));

  // A tie falls to terracotta — ShareStats' rule, unchanged, one place in the system.
  const tie = cardOf({ lit: new Set(['n3', 'n5']) });
  assert.ok(tie.includes(`<rect x="0" y="0" width="2400" height="12" fill="#BC6C42"/>`));
});

test('the strip is stamp-led: the delta leads, the period chip and the title follow', () => {
  const svg = cardOf({ lit: new Set(['n3', 'n4', 'n5']) });

  assert.ok(svg.includes('<rect x="92" y="1064" width="152" height="152" rx="40"'));       // the stamp
  assert.ok(svg.includes('font-size="68" fill="#C4972F">+3</text>'));                        // its numeral
  assert.ok(svg.includes('>Update #4</text>'));                                             // the period chip
  assert.ok(svg.includes('>steps done</text>'));                                            // row 2's label
  assert.ok(svg.includes('font-size="54"'));                                                // the title, a rung below #12's
  assert.ok(svg.includes('height="964"'));                                                  // the panel, one line shorter
});

test('the card never claims a period it cannot know — the chip says only what it is handed', () => {
  const svg = cardOf({ period: 'Week 3' });
  assert.ok(svg.includes('>Week 3</text>'));
  assert.ok(!svg.includes('Update'));
  // No label at all still builds a card; the strip simply starts with the title.
  assert.ok(cardOf({ period: '' }).includes('>Learn to sail</text>'));
});

test('a carried-over card says so on the score line, so two periods never read as one', () => {
  const carried = cardOf({ period: 'Week 5', since: 'week 3' });
  assert.ok(carried.includes('>steps done · since week 3</text>'));
  // Nothing skipped, nothing said — the ordinary card's label is untouched.
  assert.ok(cardOf().includes('>steps done</text>'));
});

test('the ledger is the series made visible: one tick per period, the current one in the hue', () => {
  const alone = cardOf({ lit: new Set(['n3']) });
  assert.equal((alone.match(/rx="6" fill=/g) || []).length, 1);
  assert.ok(alone.includes('<rect x="2296" y="1108" width="12" height="20" rx="6" fill="#C4972F"/>'));

  // Five periods behind this one: six ticks, the last in the hue and the rest warm neutral.
  const series = cardOf({ lit: new Set(['n3']), ledger: [2, 0, 4, 1, 3] });
  const ticks = [...series.matchAll(/<rect x="(\d+)" y="(\d+)" width="12" height="(\d+)" rx="6" fill="([^"]+)"\/>/g)]
    .map((m) => `${m[1]} ${m[3]} ${m[4]}`);
  assert.deepEqual(ticks, [
    '2186 28 #E5D9C0',   // 2 steps
    '2208 12 #E5D9C0',   // a quiet period is a floor tick — shown, never scolded
    '2230 44 #E5D9C0',   // 4 steps
    '2252 20 #E5D9C0',   // 1 step
    '2274 36 #E5D9C0',   // 3 steps
    '2296 20 #C4972F',   // this period, in the period's hue
  ]);
});

test('the ledger keeps a six-period window, caps a huge period, and switches off whole', () => {
  const long = cardOf({ lit: new Set(['n3']), ledger: [1, 1, 1, 1, 1, 1, 1, 9] });
  const ticks = [...long.matchAll(/rx="6" fill="([^"]+)"/g)];
  assert.equal(ticks.length, 6);
  assert.ok(long.includes('height="60"'));                     // the 9-step period, capped at 30·k
  assert.equal(cardOf({ lit: new Set(['n3']), ledger: null }).match(/rx="6" fill=/g), null);
});

test('a title too wide for the gap between the chip and the ledger is ellipsized', () => {
  const long = 'A roadmap title so absurdly long that it could never fit between the period chip and the ledger without being cut short by a good few words';
  const svg = cardOf({ title: long });
  assert.ok(svg.includes('…'));
  assert.ok(!svg.includes(long));
});

test('nothing lit this period is refused, never dressed up as a post', () => {
  assert.throws(() => cardOf({ lit: new Set() }), /at least one step lit/);
  assert.throws(() => buildProgressCardSvg({ model: treeAt(6), title: 'x', done: 6, total: 12, period: 'Update #2' }), /at least one step lit/);
});
