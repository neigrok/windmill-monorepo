// The usage room's whole surface, asserted as objects rather than as fragments — every number and
// every sentence the owner reads is built in usage.js, so this file is the room's test even though
// nothing here renders anything.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WINDOW_DAYS,
  cacheReadPercent,
  dayLabel,
  formatCount,
  formatMoney,
  formatPerCall,
  projectionNanos,
  usageView,
  windowsFor,
} from '../../../src/shell/usage/usage.js';

// A clean window: every call priced, every call attributed, three days of spend.
const CLEAN_SUMMARY = {
  costNanos: 12400000000,
  calls: 1204,
  unpricedCalls: 0,
  inputTokens: 400000,
  outputTokens: 50000,
  cacheReadTokens: 600000,
  cacheWriteTokens: 0,
  anonymousCostNanos: 0,
  unpricedModels: [],
  byProduct: [
    { product: 'journal', costNanos: 3000000000, calls: 300, unpricedCalls: 0 },
    { product: 'gym', costNanos: 2400000000, calls: 204, unpricedCalls: 0 },
    { product: 'roadmap', costNanos: 7000000000, calls: 700, unpricedCalls: 0 },
  ],
  daily: [
    { day: '2026-07-11', costNanos: 4000000000, calls: 400, unpricedCalls: 0 },
    { day: '2026-07-12', costNanos: 6000000000, calls: 600, unpricedCalls: 0 },
    { day: '2026-08-03', costNanos: 2400000000, calls: 204, unpricedCalls: 0 },
  ],
};

const CLEAN_SPENDERS = [
  { userId: 'u_1', email: 'ada@windmill.works', costNanos: 3400000000, calls: 304, unpricedCalls: 0, topProduct: 'gym' },
  { userId: 'u_2', email: 'grace@windmill.works', costNanos: 9000000000, calls: 900, unpricedCalls: 0, topProduct: 'roadmap' },
];

test('usageView — a clean window, whole', () => {
  const view = usageView({
    summary: CLEAN_SUMMARY,
    prior: { ...CLEAN_SUMMARY, costNanos: 8300000000 },
    spenders: CLEAN_SPENDERS,
  });

  assert.deepEqual(view, {
    header: {
      title: 'AI usage',
      window: 'Trailing 30 days',
      note: 'All figures USD, as billed by Anthropic.',
    },
    runRate: {
      headline: '$12.40',
      partial: false,
      projection: { label: 'projected 30 days at this rate', value: '$150.00' },
      delta: { direction: 'up', text: '+$4.10 vs the prior 30 days' },
      subline: '1,204 calls · $0.0103 per call · cache reads 60% of input tokens',
    },
    honesty: {
      tone: 'plain',
      lines: ['Every call in this window is priced, and every one of them is attributed to an account.'],
    },
    daily: {
      title: 'Spend per day',
      bars: [
        { key: '2026-07-11', value: 4000000000, label: 'Jul 11 — $4.00, 400 calls', partial: false },
        { key: '2026-07-12', value: 6000000000, label: 'Jul 12 — $6.00, 600 calls', partial: false },
        { key: '2026-08-03', value: 2400000000, label: 'Aug 3 — $2.40, 204 calls', partial: false },
      ],
      max: 6000000000,
      floorLabel: '$0',
      ceilingLabel: '$6.00',
      tone: 'var(--color-brand)',
    },
    products: {
      title: 'Spend by product',
      segments: [
        { key: 'roadmap', label: 'Roadmap', value: 7000000000, display: '$7.00', tone: 'var(--wm-usage-a)', badge: null },
        { key: 'journal', label: 'Journal', value: 3000000000, display: '$3.00', tone: 'var(--wm-usage-b)', badge: null },
        { key: 'gym', label: 'Gym', value: 2400000000, display: '$2.40', tone: 'var(--wm-usage-c)', badge: null },
      ],
      total: 12400000000,
      summary: 'Spend by product over the last 30 days: Roadmap $7.00, Journal $3.00, Gym $2.40.',
    },
    spenders: {
      title: 'Top spenders',
      rows: [
        { key: 'u_2', email: 'grace@windmill.works', cost: '$9.00', calls: '900', topProduct: 'Roadmap', badge: null },
        { key: 'u_1', email: 'ada@windmill.works', cost: '$3.40', calls: '304', topProduct: 'Gym', badge: null },
      ],
      caption: null,
    },
  });
});

// The window the meter exists for: a model shipped that the price table has never heard of, and
// spend that no account is behind. Three layers of the unpriced rule are visible in one object —
// the "≥" on the headline, the hatch flag on the day, and the badge on the product segment.
const DIRTY_SUMMARY = {
  costNanos: 1000000000,
  calls: 10,
  unpricedCalls: 3,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  anonymousCostNanos: 200000000,
  unpricedModels: ['claude-fable-1', 'claude-haiku-9'],
  byProduct: [{ product: 'roadmap', costNanos: 800000000, calls: 7, unpricedCalls: 3 }],
  daily: [{ day: '2026-08-03', costNanos: 1000000000, calls: 10, unpricedCalls: 3 }],
};

test('usageView — an unpriced, partly unattributed window, whole', () => {
  const view = usageView({ summary: DIRTY_SUMMARY, spenders: [] });

  assert.deepEqual(view.runRate, {
    headline: '≥$1.00',
    partial: true,
    // One day of data projects nothing: the only bucket present is the one still being spent into.
    projection: null,
    // No prior window was read, so there is no comparison — and none is invented.
    delta: null,
    subline: '10 calls · $0.1000 per call',
  });

  assert.deepEqual(view.honesty, {
    tone: 'warn',
    lines: [
      '3 calls of 10 carry no price — every figure on this page is a floor, and the gap is unknown.',
      'Not in the price table: claude-fable-1, claude-haiku-9',
      '$0.20 (20%) has no account behind it — the anonymous birth canvas, which is open to visitors by design.',
    ],
  });

  assert.deepEqual(view.daily.bars, [
    { key: '2026-08-03', value: 1000000000, label: 'Aug 3 — at least $1.00, 10 calls', partial: true },
  ]);

  assert.deepEqual(view.products, {
    title: 'Spend by product',
    segments: [
      {
        key: 'roadmap',
        label: 'Roadmap',
        value: 800000000,
        display: '$0.80',
        tone: 'var(--wm-usage-a)',
        badge: { text: '≥', title: '3 calls of 7 carry no price — this figure is a floor' },
      },
      {
        key: 'anonymous',
        label: 'Compose (no account)',
        value: 200000000,
        display: '$0.20',
        tone: 'var(--border-strong)',
        badge: null,
      },
    ],
    total: 1000000000,
    summary: 'Spend by product over the last 30 days: Roadmap $0.80, Compose (no account) $0.20.',
  });

  // Anonymous spend is never a row in a list of people. It is a caption under it.
  assert.deepEqual(view.spenders, {
    title: 'Top spenders',
    rows: [],
    caption: 'Plus $0.20 from anonymous compose, which has no account by design — the birth canvas is open to visitors.',
  });
});

test('usageView — spenders are ranked by cost and cut at ten, and an unknown product keeps its own name off the categorical palette', () => {
  const spenders = Array.from({ length: 12 }, (_, index) => ({
    userId: `u_${index}`,
    email: `person${index}@windmill.works`,
    costNanos: (index + 1) * 1000000000,
    calls: index + 1,
    unpricedCalls: 0,
    topProduct: 'atlas',
  }));
  const view = usageView({ summary: { ...CLEAN_SUMMARY, byProduct: [{ product: 'atlas', costNanos: 5000000000, calls: 5, unpricedCalls: 0 }] }, spenders });

  assert.deepEqual(view.spenders.rows.map((row) => row.key), [
    'u_11', 'u_10', 'u_9', 'u_8', 'u_7', 'u_6', 'u_5', 'u_4', 'u_3', 'u_2',
  ]);
  assert.deepEqual(view.spenders.rows[0], {
    key: 'u_11',
    email: 'person11@windmill.works',
    cost: '$12.00',
    calls: '12',
    topProduct: 'atlas',
    badge: null,
  });
  assert.deepEqual(view.products.segments, [
    { key: 'atlas', label: 'atlas', value: 5000000000, display: '$5.00', tone: 'var(--text-tertiary)', badge: null },
  ]);
});

test('formatMoney — a real cost never rounds to zero, and an absent price is never a zero', () => {
  assert.equal(formatMoney(12400000000), '$12.40');
  assert.equal(formatMoney(1000000000), '$1.00');
  assert.equal(formatMoney(340000000), '$0.34');
  assert.equal(formatMoney(10000000), '$0.01');
  assert.equal(formatMoney(9999999), '<$0.01');
  assert.equal(formatMoney(1), '<$0.01');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(null), '—');
  assert.equal(formatMoney(undefined), '—');
  assert.equal(formatMoney(NaN), '—');
  assert.equal(formatMoney(-1), '—');
});

test('formatPerCall — four places, because a compose is fractions of a cent', () => {
  assert.equal(formatPerCall(12400000000, 1204), '$0.0103');
  assert.equal(formatPerCall(1000000000, 10), '$0.1000');
  assert.equal(formatPerCall(1000, 100), '<$0.0001');
  assert.equal(formatPerCall(0, 10), '$0.0000');
  assert.equal(formatPerCall(1000000000, 0), null);
  assert.equal(formatPerCall(null, 10), '—');
});

test('formatCount — grouped the same way for every reader', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1204), '1,204');
  assert.equal(formatCount(1000000), '1,000,000');
});

test('dayLabel — read off the string, so a day is never labelled a day early', () => {
  assert.equal(dayLabel('2026-08-03'), 'Aug 3');
  assert.equal(dayLabel('2026-01-01'), 'Jan 1');
  assert.equal(dayLabel('2026-12-31'), 'Dec 31');
});

test('projectionNanos — the rate comes off the complete days only', () => {
  assert.equal(projectionNanos([
    { day: '2026-08-01', costNanos: 1000000000 },
    { day: '2026-08-02', costNanos: 3000000000 },
    { day: '2026-08-03', costNanos: 100000000 },
  ]), 60000000000);
  assert.equal(projectionNanos([{ day: '2026-08-03', costNanos: 1000000000 }]), null);
  assert.equal(projectionNanos([]), null);
});

test('cacheReadPercent — measured against every token that went in', () => {
  assert.equal(cacheReadPercent({ inputTokens: 400000, cacheReadTokens: 600000, cacheWriteTokens: 0 }), 60);
  assert.equal(cacheReadPercent({ inputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 200 }), 25);
  assert.equal(cacheReadPercent({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
});

test('windowsFor — two equal windows that meet exactly, from one instant', () => {
  const now = 1786000000000;
  const day = 86400000;
  assert.deepEqual(windowsFor(now), {
    current: { fromMs: now - WINDOW_DAYS * day, toMs: now },
    prior: { fromMs: now - WINDOW_DAYS * day * 2, toMs: now - WINDOW_DAYS * day },
  });
});

test('a level window says so, and a fall is signed with a real minus', () => {
  const level = usageView({ summary: CLEAN_SUMMARY, prior: CLEAN_SUMMARY, spenders: [] });
  assert.deepEqual(level.runRate.delta, { direction: 'flat', text: 'level with the prior 30 days' });

  const fell = usageView({ summary: CLEAN_SUMMARY, prior: { ...CLEAN_SUMMARY, costNanos: 20000000000 }, spenders: [] });
  assert.deepEqual(fell.runRate.delta, { direction: 'down', text: '−$7.60 vs the prior 30 days' });
});

// The chart's axis is the WINDOW, not the rows the server happened to return. Two busy days drawn
// alone land at the left edge of a thirty-day chart and read as "it happened early and stopped" —
// the exact reverse of the truth when the spend was yesterday. A silent day is a real observation.
test('daily bars span the whole window, so a quiet day is drawn as a quiet day and not as absence', () => {
  const toMs = Date.UTC(2026, 7, 9, 12, 0, 0);
  const fromMs = toMs - 29 * 24 * 60 * 60 * 1000;
  const view = usageView({
    summary: {
      costNanos: 500000000, calls: 2, unpricedCalls: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      anonymousCostNanos: 0, unpricedModels: [], byProduct: [],
      daily: [{ day: '2026-08-08', costNanos: 500000000, calls: 2, unpricedCalls: 0 }],
    },
    window: { fromMs, toMs },
  });

  assert.equal(view.daily.bars.length, 30);
  assert.equal(view.daily.bars[0].key, '2026-07-11');
  assert.equal(view.daily.bars.at(-1).key, '2026-08-09');

  const spent = view.daily.bars.filter((bar) => bar.value > 0);
  assert.equal(spent.length, 1);
  assert.equal(spent[0].key, '2026-08-08');
  // Second from the end: the day that spent is where it actually happened, not at the left edge.
  assert.equal(view.daily.bars.at(-2).key, '2026-08-08');

  const quiet = view.daily.bars.at(-1);
  assert.equal(quiet.value, 0);
  assert.equal(quiet.partial, false);
  assert.equal(quiet.label, 'Aug 9 — $0.00, 0 calls');
});
