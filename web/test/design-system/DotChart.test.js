import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserWith, elementsOf, findByClass, loadScreen, renderHook, textOf } from '../products/gym/harness.mjs';

const CHART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/design-system/charts/DotChart.jsx');
const DAY = 86400000;
const AUG = (day) => new Date(2026, 7, day).getTime();

const words = {
  joins: (from, to) => to.at - from.at <= 7 * DAY,
  width: 560,
  height: 220,
  formatValue: (value) => String(value),
  formatDate: (ms) => `${new Date(ms).getDate()} Aug`,
  gapLabel: (from, to) => `no weigh-in · ${new Date(from.at).getDate()} Aug – ${new Date(to.at).getDate()} Aug`,
};

test('dotChartLayout — a segment joins two dots only where the caller’s `joins` says they are consecutive', async () => {
  const { dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  const layout = dotChartLayout({
    ...words,
    points: [
      { at: AUG(1), value: 82.4 },
      { at: AUG(4), value: 82.0 },
      { at: AUG(11), value: 82.2 },   // exactly seven days: joined
      { at: AUG(19), value: 83.1 },   // eight days: a gap
      { at: AUG(20), value: 83.0 },
    ],
  });
  assert.equal(layout.dots.length, 5);
  assert.equal(layout.segments.length, 3);
  assert.equal(layout.gaps.length, 1);
  assert.equal(layout.gaps[0].label, 'no weigh-in · 11 Aug – 19 Aug');
  assert.equal(layout.gaps[0].x1, layout.dots[2].x);
  assert.equal(layout.gaps[0].x2, layout.dots[3].x);
});

test('dotChartLayout — the y-axis is the series’ own min and max plus padding, so a narrow series fills the frame', async () => {
  const { dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  const layout = dotChartLayout({ ...words, points: [{ at: AUG(1), value: 82.0 }, { at: AUG(3), value: 84.5 }] });
  const [low, high] = layout.dots;
  const plotHeight = layout.plot.bottom - layout.plot.top;
  assert.ok(high.y < low.y, 'the heavier dot is higher');
  assert.ok(low.y - high.y > plotHeight * 0.6, `2.5 units spread over ${(low.y - high.y).toFixed(0)}px of ${plotHeight}px`);
  assert.ok(low.y <= layout.plot.bottom && high.y >= layout.plot.top);
  const labels = layout.yTicks.map((tick) => tick.label);
  assert.ok(labels.every((label) => Number(label) > 81 && Number(label) < 86), labels.join(' '));
  assert.ok(!labels.includes('0'), 'the axis is truncated, never anchored at zero');
});

test('dotChartLayout — a single dot still has an axis on either side of it', async () => {
  const { dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  const layout = dotChartLayout({ ...words, points: [{ at: AUG(5), value: 82.4 }], domain: { from: AUG(1), to: AUG(10) } });
  assert.equal(layout.dots.length, 1);
  assert.ok(layout.dots[0].y > layout.plot.top && layout.dots[0].y < layout.plot.bottom);
  assert.ok(layout.yTicks.length >= 2);
  assert.equal(layout.xTicks[0].label, '1 Aug');
  assert.equal(layout.xTicks[layout.xTicks.length - 1].label, '10 Aug');
});

test('dotChartLayout — a gap label is placed in the gap when it fits and beneath the axis, under the gap, when it does not', async () => {
  const { dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  const wide = dotChartLayout({ ...words, points: [{ at: AUG(1), value: 82 }, { at: AUG(30), value: 82 }] });
  assert.equal(wide.gaps[0].fits, true);
  assert.equal(wide.gaps[0].row, null);
  assert.equal(wide.gaps[0].mid, (wide.gaps[0].x1 + wide.gaps[0].x2) / 2);
  assert.equal(wide.gapRows, 0);
  assert.equal(wide.height, 220);
  const narrow = dotChartLayout({
    ...words,
    domain: { from: new Date(2025, 0, 1).getTime(), to: AUG(30) },
    points: [{ at: AUG(1), value: 82 }, { at: AUG(9), value: 82 }],
  });
  assert.equal(narrow.gaps[0].fits, false);
  assert.equal(narrow.gaps[0].row, 0, 'carried beneath the axis');
  assert.equal(narrow.gapRows, 1);
  assert.equal(narrow.height, 234, 'one line of labels beneath the axis');
  const half = (narrow.gaps[0].label.length * 6.4) / 2;
  assert.ok(narrow.gaps[0].mid - half >= 0 && narrow.gaps[0].mid + half <= 560, 'clamped inside the frame');
});

test('dotChartLayout — at phone width every gap keeps its own label beneath the axis, and two that would collide take two lines', async () => {
  const { dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  const JUL = (day) => new Date(2026, 6, day).getTime();
  const layout = dotChartLayout({
    ...words,
    width: 390,
    domain: { from: new Date(2026, 4, 29).getTime(), to: AUG(26) },
    points: [{ at: JUL(11), value: 82.4 }, { at: JUL(19), value: 82.0 }, { at: AUG(12), value: 82.2 }],
  });
  assert.equal(layout.gaps.length, 2);
  assert.deepEqual(layout.gaps.map((gap) => gap.fits), [false, false]);
  assert.deepEqual(layout.gaps.map((gap) => gap.row), [0, 1], 'the second wraps to a second line');
  assert.equal(layout.gapRows, 2);
  assert.equal(layout.height, 220 + 2 * 14);
  const [first, second] = layout.gaps;
  assert.ok(Math.abs(first.mid - (first.x1 + first.x2) / 2) < 1e-9 || first.mid > (first.x1 + first.x2) / 2, 'under the gap’s midpoint, or clamped in from the edge');
  assert.ok(second.mid > first.mid);
  const far = dotChartLayout({
    ...words,
    width: 390,
    domain: { from: new Date(2026, 0, 1).getTime(), to: AUG(26) },
    points: [{ at: new Date(2026, 0, 5).getTime(), value: 82 }, { at: new Date(2026, 0, 20).getTime(), value: 82 }, { at: AUG(1), value: 82 }, { at: AUG(20), value: 82 }],
  });
  assert.deepEqual(far.gaps.map((gap) => gap.fits), [false, true, false], 'the wide middle gap holds its own label');
  assert.deepEqual(far.gaps.map((gap) => gap.row), [0, null, 0], 'beneath labels that clear each other share the first line');
});

test('dotChartLayout — no points is an empty layout, with no phantom tick', async () => {
  const { dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  const layout = dotChartLayout({ ...words, points: [] });
  assert.deepEqual(layout.dots, []);
  assert.deepEqual(layout.segments, []);
  assert.deepEqual(layout.gaps, []);
  assert.deepEqual(layout.yTicks, []);
  assert.deepEqual(layout.xTicks, []);
  assert.equal(layout.gapRows, 0);
  assert.equal(layout.height, 220);
});

test('dotChartLayout — the axis column widens to its widest label, so a unit on the labels stays clear of the plot', async () => {
  const { dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  const bare = dotChartLayout({ ...words, points: [{ at: AUG(1), value: 82.0 }, { at: AUG(3), value: 84.5 }] });
  const unit = dotChartLayout({ ...words, formatValue: (value) => `${value.toFixed(1)} kg`, points: [{ at: AUG(1), value: 100.2 }, { at: AUG(3), value: 100.6 }] });
  assert.equal(bare.plot.left, 46);
  assert.equal(unit.yTicks[0].label.length, 8);
  const widest = Math.max(...unit.yTicks.map((tick) => tick.label.length));
  assert.equal(unit.plot.left, Math.ceil(widest * 6.4) + 14);
  assert.ok(unit.plot.left > bare.plot.left);
});

test('the chart draws the window it shows, and a dot is a button when there is a repair path', async (t) => {
  browserWith();
  const { DotChart } = await loadScreen('design-system/charts/DotChart.jsx');
  const picked = [];
  const screen = renderHook(t, () => DotChart({
    ...words,
    points: [{ at: AUG(1), value: 82.4, label: '82.4 kg · 1 Aug', dateLocal: '2026-08-01' }, { at: AUG(20), value: 83, label: '83 kg · 20 Aug' }],
    caption: 'last 90 days · 2 weigh-ins',
    ariaLabel: 'Bodyweight',
    onPick: (point) => picked.push(point.dateLocal),
  }));
  const figure = elementsOf(screen.tree).find((each) => each.type === 'figure');
  assert.equal(textOf(figure).includes('last 90 days · 2 weigh-ins'), true);
  assert.equal(elementsOf(figure).some((each) => each.type === 'p'), false, 'no legend under the chart explains a gap');
  const svg = elementsOf(screen.tree).find((each) => each.type === 'svg');
  assert.equal(svg.props.role, 'group', 'a group, so the dots inside stay reachable');
  assert.equal(svg.props['aria-label'], 'Bodyweight');
  assert.equal(elementsOf(screen.tree).some((each) => each.props?.role === 'img' && each.type === 'svg'), false);
  const dots = elementsOf(screen.tree).filter((each) => each.type === 'g' && each.props.role === 'button');
  assert.equal(dots.length, 2);
  assert.equal(dots[0].props['aria-label'], '82.4 kg · 1 Aug');
  assert.equal(dots[0].props.tabIndex, 0);
  dots[0].props.onClick();
  assert.deepEqual(picked, ['2026-08-01']);
  const still = renderHook(t, () => DotChart({ ...words, points: [{ at: AUG(1), value: 82.4, label: '82.4 kg · 1 Aug' }] }));
  assert.equal(elementsOf(still.tree).filter((each) => each.type === 'g' && each.props.role === 'button').length, 0);
  const images = elementsOf(still.tree).filter((each) => each.type === 'g' && each.props.role === 'img');
  assert.equal(images.length, 1, 'with no repair path a dot is still its own named element');
  assert.equal(images[0].props['aria-label'], '82.4 kg · 1 Aug');
  assert.equal(findByClass(still.tree, 'gym-record-bar').length, 0);
  const bare = renderHook(t, () => DotChart({ ...words, points: [{ at: AUG(1), value: 82.4, label: 'x' }] }));
  assert.equal(elementsOf(bare.tree).find((each) => each.type === 'svg').props['aria-label'], 'chart', 'a caller that names nothing gets the plain word');
});

test('a gap the frame cannot hold is drawn as a dashed marker across the gap and its label beneath the axis; nothing is listed apart', async (t) => {
  browserWith();
  const { DotChart } = await loadScreen('design-system/charts/DotChart.jsx');
  const screen = renderHook(t, () => DotChart({
    ...words,
    domain: { from: new Date(2025, 0, 1).getTime(), to: AUG(30) },
    points: [{ at: AUG(1), value: 82, label: '82 kg · 1 Aug' }, { at: AUG(9), value: 82, label: '82 kg · 9 Aug' }],
  }));
  const all = elementsOf(screen.tree);
  const dashed = all.filter((each) => each.type === 'line' && each.props.strokeDasharray);
  assert.equal(dashed.length, 1);
  const beneath = all.filter((each) => each.type === 'text' && textOf(each) === 'no weigh-in · 1 Aug – 9 Aug');
  assert.equal(beneath.length, 1, 'one label per gap');
  const svg = all.find((each) => each.type === 'svg');
  assert.ok(beneath[0].props.y > svg.props.height - 26, 'beneath the axis');
  assert.equal(beneath[0].props.textAnchor, 'middle');
  assert.equal(svg.props.height, 234);
  assert.equal(all.some((each) => each.type === 'ul'), false);
});

test('the primitive fits nothing, projects nothing and scores nothing', () => {
  const spoken = fs.readFileSync(CHART, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const banned of ['goal', 'projection', 'BMI', 'body fat', 'trend', 'average', 'smooth', 'regression', 'scrub', 'congrat', 'alarm', 'streak']) {
    assert.equal(spoken.toLowerCase().includes(banned.toLowerCase()), false, banned);
  }
  assert.equal(/\/ top\b|series max|normalis/.test(spoken), false, 'never normalised to the series maximum');
});


test('interactive reading is opt-in, keeps pinned axes and releases its readout after1500ms', async (t) => {
  browserWith();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { DotChart } = await loadScreen('design-system/charts/DotChart.jsx');
  const screen = renderHook(t, () => DotChart({ ...words, interactive: true, points: [{ at: AUG(1), value: 82, label: 'first measurement' }, { at: AUG(20), value: 84, label: 'last measurement' }] }));
  const plot = () => elementsOf(screen.tree).find((each) => each.type === 'svg');
  plot().props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(plot().props['aria-label'], 'chart. first measurement');
  assert.equal(elementsOf(screen.tree).find((each) => each.props['aria-live'] === 'polite').props.children, 'first measurement');
  plot().props.onPointerUp();
  t.mock.timers.tick(1499);
  assert.equal(plot().props['aria-label'], 'chart. first measurement');
  t.mock.timers.tick(1);
  assert.equal(plot().props['aria-label'], 'chart');
  const axis = elementsOf(screen.tree).find((each) => each.type === 'svg' && each.props['aria-hidden'] === 'true');
  assert.equal(axis.props.style.position, 'absolute');
  assert.equal(axis.props.style.pointerEvents, 'none');
  assert.equal(elementsOf(axis).filter((each) => each.type === 'text').at(-1).props.textAnchor, 'end');
  const staticScreen = renderHook(t, () => DotChart({ ...words, compact: true, points: [{ at: AUG(1), value: 82, label: 'first' }, { at: AUG(20), value: 84, label: 'last' }] }));
  const staticPlot = elementsOf(staticScreen.tree).find((each) => each.type === 'svg');
  assert.equal(staticPlot.props.onPointerMove, undefined);
  assert.equal(staticPlot.props.onPointerUp, undefined);
  assert.equal(staticPlot.props.style.touchAction, undefined);
  assert.equal(elementsOf(staticPlot).filter((each) => each.type === 'text').at(-1).props.textAnchor, 'end');
});

test('compact axes use the plot edges and interactive gap captions stay clear of the pinned axis', async (t) => {
  browserWith();
  const { DotChart, dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  const layout = dotChartLayout({ ...words, compact: true, height: 90, fontSize: 13, points: [{ at: AUG(1), value: 66 }, { at: AUG(20), value: 76 }] });
  assert.deepEqual(layout.yTicks.map(({ value, y }) => ({ value, y })), [{ value: 60, y: 64 }, { value: 80, y: 0 }]);
  assert.deepEqual(layout.plot, { left: 30, right: 560, top: 0, bottom: 64 });
  const screen = renderHook(t, () => DotChart({ ...words, interactive: true, axisFontSize: 13,
    domain: { from: new Date(2025, 0, 1).getTime(), to: AUG(30) },
    points: [{ at: AUG(1), value: 82, label: 'first' }, { at: AUG(9), value: 82, label: 'last' }],
  }));
  assert.deepEqual(findByClass(screen.tree, 'dot-chart-gap').map(textOf), ['no weigh-in · 1 Aug – 9 Aug']);
  for (const svg of elementsOf(screen.tree).filter((element) => element.type === 'svg')) {
    assert.equal(svg.props.height, 220);
    assert.equal(elementsOf(svg).some((element) => element.type === 'text' && textOf(element).startsWith('no weigh-in')), false);
  }
});

test('compact rounded endpoints enclose flat, negative and large series without changing full charts', async () => {
  const { dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  for (const [values, endpoints] of [
    [[76, 76], [75, 77]],
    [[0, 0], [-1, 1]],
    [[-5, -3], [-6, -2]],
    [[-1e12, 1e12], [-2e12, 2e12]],
  ]) {
    const layout = dotChartLayout({ ...words, compact: true, height: 90, points: values.map((value, index) => ({ at: AUG(index + 1), value })) });
    assert.deepEqual(layout.yTicks.map(tick => tick.value), endpoints);
    for (const dot of layout.dots) assert(dot.y > layout.plot.top && dot.y < layout.plot.bottom && Number.isFinite(dot.x));
  }
  const full = dotChartLayout({ ...words, points: [{ at: AUG(1), value: 66 }, { at: AUG(20), value: 76 }] });
  assert.deepEqual(full.plot, { left: 46, right: 546, top: 14, bottom: 194 });
  assert.deepEqual(full.yTicks.map(tick => tick.value), [65, 70, 75]);
});

test('compact endpoint dots fit inside the viewport while dates retain their domain positions', async () => {
  const { dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  const points = [{ at: AUG(1), value: 66 }, { at: AUG(2), value: 70 }, { at: AUG(3), value: 76 }];
  const layout = dotChartLayout({ ...words, compact: true, width: 280, height: 90, points });
  assert.deepEqual(layout.dots.map(dot => dot.x), [30, 155, 277.5]);
  assert.deepEqual([layout.xTicks[0].x, layout.xTicks.at(-1).x], [30, 280]);
  assert.equal(layout.segments.at(-1).x2 + 2.5, 280);
  const bounded = dotChartLayout({ ...words, compact: true, width: 280, height: 90, points, domain: { from: AUG(1), to: AUG(4) } });
  assert.equal(bounded.dots.at(-1).x, 30 + 250 * 2 / 3);
});

test('interactive points and focus rings have space inside the pinned axis edge', async (t) => {
  browserWith();
  const { DotChart } = await loadScreen('design-system/charts/DotChart.jsx');
  const screen = renderHook(t, () => DotChart({ ...words, interactive: true, points: [{ at: AUG(1), value: 82, label: 'first' }, { at: AUG(20), value: 84, label: 'last' }] }));
  const axes = elementsOf(screen.tree).find((each) => each.type === 'svg' && each.props['aria-hidden'] === 'true');
  const edge = elementsOf(axes).find((each) => each.type === 'rect').props.width;
  const first = elementsOf(screen.tree).find((each) => each.type === 'g' && each.props['aria-label'] === 'first');
  assert.equal(elementsOf(first).find((each) => each.type === 'circle').props.cx - edge, 14);
});

test('minimal full charts keep endpoint axes, every gap below the plot and keyboard reading', async (t) => {
  browserWith();
  const { DotChart, dotChartLayout } = await loadScreen('design-system/charts/DotChart.jsx');
  const points = [{ at: AUG(1), value: 66, label: 'first' }, { at: AUG(30), value: 76, label: 'last' }];
  for (const width of [310, 984]) {
    const layout = dotChartLayout({ ...words, width, points, minimal: true, fontSize: 13 });
    assert.deepEqual(layout.plot, { left: 32, right: width - 16, top: 20, bottom: 180 });
    assert.deepEqual(layout.yTicks.map(({ value, y }) => ({ value, y })), [{ value: 60, y: 180 }, { value: 80, y: 20 }]);
  }
  const screen = renderHook(t, () => DotChart({ ...words, points, minimal: true, interactive: true, axisFontSize: 13 }));
  const plot = () => elementsOf(screen.tree).find(each => each.type === 'svg');
  assert.equal(elementsOf(plot()).filter(each => each.type === 'line').length, 0, 'no grid or line across a missing interval');
  assert.deepEqual(findByClass(screen.tree, 'dot-chart-gap').map(textOf), ['no weigh-in · 1 Aug – 30 Aug']);
  assert.deepEqual(elementsOf(plot()).filter(each => each.type === 'circle' && each.props.fill === 'var(--color-brand)').map(each => each.props.r), ['4', '4']);
  plot().props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(plot().props['aria-label'], 'chart. first');
  assert.equal(findByClass(screen.tree, 'dot-chart-readout').map(textOf)[0], 'first');
  const axes = elementsOf(screen.tree).find(each => each.type === 'svg' && each.props['aria-hidden']);
  assert.deepEqual(elementsOf(axes).filter(each => each.type === 'text').map(textOf), ['60', '80', '1 Aug', '30 Aug']);
});
