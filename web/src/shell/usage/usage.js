// THE USAGE ROOM, AS RULES — what two founders read on a Monday to answer one question: did our
// vendor spend change, and if it did, was it usage or was it us. No React and no fetch in here, the
// same way settings/format.js and gym's stats.js hold their surface's whole vocabulary: the screen
// draws what this returns and decides nothing, so every number and every sentence on that screen is
// readable in a test without a browser.
//
// MONEY IS INTEGER NANO-DOLLARS ALL THE WAY IN, and is divided exactly ONCE, at the display step.
// A plain JS number is safe here and NOBODY SHOULD ADD A BigInt DEFENSIVELY: Number.MAX_SAFE_INTEGER
// is 9.007e15 nanos, which is $9,007,199 of vendor spend in one window — three orders of magnitude
// past anything this company will bill before the unit is revisited. Every sum below is a sum of
// integers, so it is exact; the only float that ever exists is the one the formatter makes.
//
// AND THE FORMATTING IS DONE BY HAND, not by Intl with style:'currency'. Intl renders the same
// amount as "$12.40", "US$12.40" or "12,40 $US" depending on who is reading, and the header states
// the currency once for everybody. Nothing here ever converts a currency; the wire is what Anthropic
// billed, in dollars, and it stays that.

export const WINDOW_DAYS = 30;
export const TOP_SPENDERS = 10;

const NANOS_PER_DOLLAR = 1000000000;
const NANOS_PER_CENT = 10000000;
const NANOS_PER_TENTH_CENT = 100000; // $0.0001 — the floor of the per-call figure
const DAY_MS = 86400000;

// THE CATEGORICAL ASSIGNMENT, DECIDED ONCE, HERE. Which product wears which hue is a fact about the
// data and not about a chart, so it is not re-decided in a component and never cycled: a product
// added later takes the next unclaimed slot or folds into "Other", and it never gets a generated
// hue, which under colour-blindness is indistinguishable from one already on screen.
//
// The three were chosen by running the design system's own ramps through the CVD validator rather
// than by taste — terracotta·plum·sky separate (ΔE 13.9 deuteranopia, 17.5 normal on the cream
// canvas; 15.9 / 16.2 on the night one), and the obvious-looking terracotta·olive·gold family does
// not: olive against terracotta is ΔE 1.1 under deuteranopia, which is one colour drawn twice. The
// house palette is a deliberately narrow warm family, so the legend below every bar carries identity
// in words as well — colour is never the only channel here.
//
// The tones are CSS VARIABLE STRINGS, never colour values: the room's sheet re-points each one for
// the night skin, so JS never holds a colour and cannot get a theme wrong.
const PRODUCTS = [
  { id: 'roadmap', label: 'Roadmap', tone: 'var(--wm-usage-a)' },
  { id: 'journal', label: 'Journal', tone: 'var(--wm-usage-b)' },
  { id: 'gym', label: 'Gym', tone: 'var(--wm-usage-c)' },
];

// Anonymous compose is deliberately OUTSIDE the categorical palette, in the neutral grey the room
// draws its borders from. It is not one of the accounts, and it should read as not-one-of-them
// before anyone gets as far as the label.
const ANONYMOUS = { id: 'anonymous', label: 'Compose (no account)', tone: 'var(--border-strong)' };
const OTHER = { id: 'other', label: 'Other', tone: 'var(--text-tertiary)' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The two windows the page reads, both derived from one instant so they cannot overlap or leave a
// gap between them. `to` is exclusive of nothing and inclusive of nothing in particular — the server
// buckets against the same now() that stamped the rows, and these are only the bounds it is asked for.
export function windowsFor(nowMs) {
  const span = WINDOW_DAYS * DAY_MS;
  return {
    current: { fromMs: nowMs - span, toMs: nowMs },
    prior: { fromMs: nowMs - span * 2, toMs: nowMs - span },
  };
}

// Nanos → the money on screen. `<$0.01` rather than `$0.00` is the whole point of this function: a
// real cost rounded to zero is this page lying in miniature, and the calls it would lie about — a
// cache read on Haiku — are exactly the high-volume ones the meter exists to catch. An absent price
// is an em dash and never a zero, because "we did not price this" and "this cost nothing" are
// different facts and only one of them is good news.
export function formatMoney(nanos) {
  if (nanos == null || !Number.isFinite(nanos)) return '—';
  // A negative total is unrepresentable — costs are non-negative and every aggregate is their sum —
  // so if one ever arrives it is a bug upstream, and a dash is the honest way to say we don't know.
  if (nanos < 0) return '—';
  if (nanos === 0) return '$0.00';
  if (nanos < NANOS_PER_CENT) return '<$0.01';
  return `$${(nanos / NANOS_PER_DOLLAR).toFixed(2)}`;
}

// The per-call figure needs four places or it is all zeroes: a compose is fractions of a cent.
export function formatPerCall(nanos, calls) {
  if (!calls || calls <= 0) return null;
  if (nanos == null || !Number.isFinite(nanos) || nanos < 0) return '—';
  const per = nanos / calls;
  if (per === 0) return '$0.0000';
  if (per < NANOS_PER_TENTH_CENT) return '<$0.0001';
  return `$${(per / NANOS_PER_DOLLAR).toFixed(4)}`;
}

// Grouped by hand rather than through toLocaleString, which groups differently for different
// readers — this page is two people and one shape, and a test should assert the shape they see.
export function formatCount(count) {
  return String(Math.round(count ?? 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function countLabel(count, one, many) {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

// "2026-08-03" → "Aug 3", read straight off the string. Never through Date: the server buckets days
// in its own zone, and `new Date('2026-08-03')` is UTC midnight, which in every zone west of
// Greenwich renders as the 2nd. A bar labelled a day early is this page getting a fact wrong.
export function dayLabel(day) {
  const [, month, date] = String(day).split('-');
  return `${MONTHS[Number(month) - 1] ?? '?'} ${Number(date)}`;
}

// The 30-day projection, taken from the COMPLETE days only. The last bucket in the series is today,
// which is still being spent into, so a rate that included it always reads low — and a "projection"
// computed over the whole trailing window would be the window total restated, which is not a
// projection at all. One day of data projects nothing, and says so with a dash.
export function projectionNanos(daily) {
  const complete = (daily ?? []).slice(0, -1);
  if (complete.length === 0) return null;
  const spent = complete.reduce((sum, day) => sum + day.costNanos, 0);
  return Math.round((spent / complete.length) * WINDOW_DAYS);
}

// Cache reads as a share of everything fed to the model — plain input, cache reads and cache writes
// together, because all three are tokens that went IN and the ratio is meaningless against a subset.
// This is the one number that tells "spend rose because we are busier" apart from "spend rose
// because caching regressed", which no total can ever say.
export function cacheReadPercent(summary) {
  const tokensIn = summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens;
  if (tokensIn <= 0) return null;
  return Math.round((summary.cacheReadTokens / tokensIn) * 100);
}

function percentOf(part, whole) {
  if (!whole || whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

// What an aggregate says about itself when some of the calls inside it were never priced. It is a
// FLOOR, not a total, and it carries that on its face — the badge is the mark, the title is the
// count, and neither is behind a hover for the number itself.
function floorBadge(unpricedCalls, calls) {
  if (!unpricedCalls || unpricedCalls <= 0) return null;
  return {
    text: '≥',
    title: `${countLabel(unpricedCalls, 'call', 'calls')} of ${formatCount(calls)} ${unpricedCalls === 1 ? 'carries' : 'carry'} no price — this figure is a floor`,
  };
}

// PANEL 1 — the number the week's decision is made on, and the two figures that give it a direction.
function runRate(summary, prior) {
  const partial = summary.unpricedCalls > 0;
  const projected = projectionNanos(summary.daily);
  const perCall = formatPerCall(summary.costNanos, summary.calls);
  const cacheShare = cacheReadPercent(summary);

  const parts = [countLabel(summary.calls, 'call', 'calls')];
  if (perCall) parts.push(`${perCall} per call`);
  if (cacheShare != null) parts.push(`cache reads ${cacheShare}% of input tokens`);

  return {
    // The "≥" is the third layer of the unpriced rule and it rides on the headline itself: a reader
    // who takes only one number off this page must not take a total that is really a floor.
    headline: `${partial ? '≥' : ''}${formatMoney(summary.costNanos)}`,
    partial,
    projection: projected == null ? null : { label: 'projected 30 days at this rate', value: formatMoney(projected) },
    delta: deltaAgainst(summary, prior),
    subline: parts.join(' · '),
  };
}

// The prior equal window, when we have one. A failed second read is not a reason to invent a
// comparison, so the whole line is simply absent rather than shown as zero change.
function deltaAgainst(summary, prior) {
  if (!prior) return null;
  const change = summary.costNanos - prior.costNanos;
  if (change === 0) return { direction: 'flat', text: 'level with the prior 30 days' };
  const sign = change > 0 ? '+' : '−';
  return {
    direction: change > 0 ? 'up' : 'down',
    text: `${sign}${formatMoney(Math.abs(change))} vs the prior 30 days`,
  };
}

// PANEL 2 — the caveats, and they sit SECOND. A caveat discovered under a chart, after the number at
// the top has already been read and believed, arrived too late to change anything.
//
// Two different states, not one: unpriced calls are a DEFECT (a model shipped that the price table
// has never heard of, so the meter is under-counting and does not know by how much), while anonymous
// compose is the product working as designed. Drawing them at the same volume would teach a reader
// to ignore the strip on the week it matters.
function honesty(summary) {
  const lines = [];
  if (summary.unpricedCalls > 0) {
    lines.push(`${countLabel(summary.unpricedCalls, 'call', 'calls')} of ${formatCount(summary.calls)} ${summary.unpricedCalls === 1 ? 'carries' : 'carry'} no price — every figure on this page is a floor, and the gap is unknown.`);
    if (summary.unpricedModels.length > 0) {
      lines.push(`Not in the price table: ${summary.unpricedModels.join(', ')}`);
    }
  }
  if (summary.anonymousCostNanos > 0) {
    lines.push(`${formatMoney(summary.anonymousCostNanos)} (${percentOf(summary.anonymousCostNanos, summary.costNanos)}%) has no account behind it — the anonymous birth canvas, which is open to visitors by design.`);
  }
  if (lines.length === 0) {
    return { tone: 'plain', lines: ['Every call in this window is priced, and every one of them is attributed to an account.'] };
  }
  return { tone: summary.unpricedCalls > 0 ? 'warn' : 'note', lines };
}

// PANEL 3 — bars, one per day, and never an area. An area implies a continuum between daily buckets
// that does not exist, and its fill swallows a zero day whole. This is the panel that catches a
// runaway loop on a Tuesday that a monthly total averages down into nothing.
// Every day in the window gets a bar, not just the days that spent. The server returns only days
// that have rows, and drawing those alone puts two busy days at the LEFT edge of a chart whose
// axis is the trailing thirty — which reads as "it happened early and stopped", the exact reverse
// of the truth when the spend was yesterday. A silent day is a real observation and it is drawn as
// what it is: a labelled slot with no bar on it.
function blankDay(key) {
  return { day: key, costNanos: 0, calls: 0, unpricedCalls: 0 };
}

// The window's days as YYYY-MM-DD, oldest first, walked in UTC so a chart never gains or loses a
// column when the reader's clock crosses a DST boundary mid-window.
function calendar({ fromMs, toMs }) {
  const keys = [];
  for (let at = Date.UTC(...utcParts(fromMs)); at <= toMs; at += DAY_MS) {
    keys.push(new Date(at).toISOString().slice(0, 10));
  }
  return keys;
}

function utcParts(ms) {
  const at = new Date(ms);
  return [at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()];
}

function daily(summary, window) {
  const found = new Map((summary.daily ?? []).map((day) => [day.day, day]));
  const days = window ? calendar(window).map((key) => found.get(key) ?? blankDay(key))
                      : (summary.daily ?? []);
  const bars = days.map((day) => ({
    key: day.day,
    value: day.costNanos,
    // The bar has no text on it and there is no hover on this page, so this sentence is the whole of
    // what a reader listening to the chart gets — written here with the rest of the copy rather than
    // interpolated in a view where "1 calls" is one template away.
    label: `${dayLabel(day.day)} — ${day.unpricedCalls > 0 ? 'at least ' : ''}${formatMoney(day.costNanos)}, ${countLabel(day.calls, 'call', 'calls')}`,
    partial: day.unpricedCalls > 0,
  }));
  const max = Math.max(0, ...bars.map((bar) => bar.value));
  return {
    title: 'Spend per day',
    bars,
    max,
    // Both ends of the scale said out loud. A reader who cannot see where a scale starts has to
    // trust it, and not having to trust it is the whole point of drawing bars from zero.
    floorLabel: '$0',
    ceilingLabel: formatMoney(max),
    tone: 'var(--color-brand)',
  };
}

function productFor(id) {
  return PRODUCTS.find((product) => product.id === id) ?? { ...OTHER, label: id || OTHER.label };
}

// PANEL 4 — part-to-whole, so one stacked bar, in the registry's own order rather than in the order
// the server happened to return: colour follows the entity, never its rank, so a quiet week for one
// product must not repaint the other two.
function byProduct(summary) {
  const rows = summary.byProduct ?? [];
  const ordered = [
    ...PRODUCTS.map((product) => rows.find((row) => row.product === product.id)).filter(Boolean),
    ...rows.filter((row) => !PRODUCTS.some((product) => product.id === row.product)),
  ];
  const segments = ordered.map((row) => {
    const product = productFor(row.product);
    return {
      key: row.product,
      label: product.label,
      value: row.costNanos,
      display: formatMoney(row.costNanos),
      tone: product.tone,
      badge: floorBadge(row.unpricedCalls, row.calls),
    };
  });
  if (summary.anonymousCostNanos > 0) {
    segments.push({
      key: ANONYMOUS.id,
      label: ANONYMOUS.label,
      value: summary.anonymousCostNanos,
      display: formatMoney(summary.anonymousCostNanos),
      tone: ANONYMOUS.tone,
      badge: null,
    });
  }
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return {
    title: 'Spend by product',
    segments,
    total,
    summary: segments.length === 0
      ? 'Spend by product: nothing spent in this window.'
      : `Spend by product over the last ${WINDOW_DAYS} days: ${segments.map((segment) => `${segment.label} ${segment.display}`).join(', ')}.`,
  };
}

// PANEL 5 — a ranked list of PEOPLE, which is why the anonymous aggregate is not in it and cannot
// be: a row that is not a person, sitting among rows that are, is read as a person. It gets a
// caption underneath instead, where it is stated as what it is.
function topSpenders(rows, summary) {
  const ranked = [...(rows ?? [])].sort((a, b) => b.costNanos - a.costNanos).slice(0, TOP_SPENDERS);
  return {
    title: 'Top spenders',
    rows: ranked.map((row) => ({
      key: row.userId,
      email: row.email,
      cost: formatMoney(row.costNanos),
      calls: formatCount(row.calls),
      topProduct: row.topProduct ? productFor(row.topProduct).label : '—',
      badge: floorBadge(row.unpricedCalls, row.calls),
    })),
    caption: summary.anonymousCostNanos > 0
      ? `Plus ${formatMoney(summary.anonymousCostNanos)} from anonymous compose, which has no account by design — the birth canvas is open to visitors.`
      : null,
  };
}

// The whole page, made once, from one summary, its prior twin and the spender list. `prior` is
// optional on purpose: the comparison is the only thing that needs it, and one failed read should
// cost the reader that line and nothing else.
export function usageView({ summary, prior = null, spenders = [], window = null }) {
  return {
    header: {
      title: 'AI usage',
      window: `Trailing ${WINDOW_DAYS} days`,
      note: 'All figures USD, as billed by Anthropic.',
    },
    runRate: runRate(summary, prior),
    honesty: honesty(summary),
    daily: daily(summary, window),
    products: byProduct(summary),
    spenders: topSpenders(spenders, summary),
  };
}
