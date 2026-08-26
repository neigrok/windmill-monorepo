import React, { useEffect, useRef, useState } from 'react';

// A dot per measurement on a truncated, labelled y-axis: the series' own minimum and maximum plus
// padding, so a series that moves between 82.0 and 84.5 fills the frame instead of drawing as a
// row of near-identical full-height marks. Two consecutive dots are joined only when the caller's
// `joins(from, to)` says so — what counts as consecutive (calendar days, elapsed hours) is the
// series' own rule; a longer gap is left visibly empty and carries the label the caller words for
// it. The label sits inside the gap when it fits; on a narrow frame the gap carries a dashed marker
// and its label moves beneath the axis under the gap's midpoint, a second line taking any label
// that would collide with one already placed. Nothing here fits, projects, smooths or scores a
// series: the dots are the data and the segments are a reading aid the chart says so about in
// `rule`.

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
const MARGIN = { left: 46, right: 14, top: 14, bottom: 26 };
// Mono at 10.5px is close to 6.4px per glyph; a gap label is drawn in place only when it fits.
const GLYPH_PX = 6.4;
// One line of gap labels beneath the axis.
const GAP_ROW_PX = 14;
// Breathing room between two labels on one line, and the axis column's own padding.
const LABEL_GUTTER = 8;
const AXIS_PAD = 14;

function tickStep(span, atMost) {
  return TICK_STEPS.find((step) => span / step <= atMost) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

// The y-domain is the series' own min and max plus a padding of fifteen percent of the span (a
// fifth of a unit at least), and one whole unit either side of a flat series or a single dot.
function valueDomain(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max > min ? Math.max((max - min) * 0.15, 0.2) : 1;
  return { min: min - pad, max: max + pad };
}

function valueTicks(domain, formatValue) {
  const step = tickStep(domain.max - domain.min, 5);
  const ticks = [];
  for (let value = Math.ceil(domain.min / step) * step; value <= domain.max + 1e-9; value += step) {
    ticks.push({ value: Math.round(value / step) * step, label: formatValue(Math.round(value / step) * step) });
  }
  return ticks;
}

function dateTicks(domain, formatDate) {
  if (domain.to <= domain.from) return [{ at: domain.from, label: formatDate(domain.from) }];
  const count = 4;
  return Array.from({ length: count }, (_, index) => {
    const at = domain.from + ((domain.to - domain.from) * index) / (count - 1);
    return { at, label: formatDate(at) };
  });
}

// Every gap whose label did not fit in place gets a line beneath the axis: the first line where it
// clears the label placed before it, its midpoint clamped so it stays inside the frame. Gaps come
// in x order, so one pass places them all. Returns how many lines were used.
function placeBeneath(gaps, width) {
  const edges = [];
  for (const gap of gaps) {
    if (gap.fits) continue;
    const half = (gap.label.length * GLYPH_PX) / 2;
    const mid = Math.min(Math.max(gap.mid, half), width - half);
    let row = edges.findIndex((edge) => mid - half > edge + LABEL_GUTTER);
    if (row === -1) {
      row = edges.length;
      edges.push(0);
    }
    edges[row] = mid + half;
    gap.mid = mid;
    gap.row = row;
  }
  return edges.length;
}

// Pure geometry, so the rules can be checked without a DOM. `points` sorted by `at` ascending;
// `domain` is the x-window and defaults to the first and last point. `height` is the frame the
// caller asked for; the layout's own `height` adds a line per row of gap labels beneath the axis.
// No points is an empty layout: no axis, no tick, nothing that reads as a measurement.
export function dotChartLayout({
  points, domain = null, joins, width, height, formatValue, formatDate, gapLabel,
}) {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  if (sorted.length === 0) {
    const plot = { left: MARGIN.left, right: width - MARGIN.right, top: MARGIN.top, bottom: height - MARGIN.bottom };
    return { plot, dots: [], segments: [], gaps: [], yTicks: [], xTicks: [], gapRows: 0, height };
  }
  const xDomain = domain ?? { from: sorted[0].at, to: sorted[sorted.length - 1].at };
  const yDomain = valueDomain(sorted.map((point) => point.value));
  const ticks = valueTicks(yDomain, formatValue);
  // The axis column is as wide as its widest label, so a unit on the labels never runs under the plot.
  const widest = Math.max(...ticks.map((tick) => tick.label.length));
  const left = Math.max(MARGIN.left, Math.ceil(widest * GLYPH_PX) + AXIS_PAD);
  const plot = { left, right: width - MARGIN.right, top: MARGIN.top, bottom: height - MARGIN.bottom };
  const xSpan = Math.max(xDomain.to - xDomain.from, 1);
  const x = (at) => plot.left + ((at - xDomain.from) / xSpan) * (plot.right - plot.left);
  const y = (value) => plot.bottom - ((value - yDomain.min) / (yDomain.max - yDomain.min)) * (plot.bottom - plot.top);

  const dots = sorted.map((point) => ({ x: x(point.at), y: y(point.value), point }));
  const segments = [];
  const gaps = [];
  for (let index = 1; index < dots.length; index += 1) {
    const from = dots[index - 1];
    const to = dots[index];
    if (joins(from.point, to.point)) {
      segments.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
      continue;
    }
    const label = gapLabel(from.point, to.point);
    gaps.push({
      x1: from.x,
      x2: to.x,
      y: (from.y + to.y) / 2,
      mid: (from.x + to.x) / 2,
      row: null,
      label,
      fits: label.length * GLYPH_PX <= (to.x - from.x) - 16,
    });
  }
  const gapRows = placeBeneath(gaps, width);
  return {
    plot,
    dots,
    segments,
    gaps,
    yTicks: ticks.map((tick) => ({ ...tick, y: y(tick.value) })),
    xTicks: dateTicks(xDomain, formatDate).map((tick) => ({ ...tick, x: x(tick.at) })),
    gapRows,
    height: height + gapRows * GAP_ROW_PX,
  };
}

const text = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  fill: 'var(--text-tertiary)',
  fontVariantNumeric: 'tabular-nums',
};
const label = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--text-tertiary)',
  fontVariantNumeric: 'tabular-nums',
};

// The svg is a group, not one image: each dot is its own element for assistive tech, a button where
// there is a repair path and an image where there is not, named by the caller's `label`.
export function DotChart({
  points, domain = null, joins, gapLabel, formatValue, formatDate, caption, rule, onPick = null,
  height = 220, ariaLabel = 'chart',
}) {
  const host = useRef(null);
  const [width, setWidth] = useState(560);
  const [focused, setFocused] = useState(null);

  useEffect(() => {
    const node = host.current;
    if (!node || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.floor(entry.contentRect.width);
      if (measured > 0) setWidth(measured);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const layout = dotChartLayout({ points, domain, joins, width, height, formatValue, formatDate, gapLabel });
  const pick = (point) => { if (onPick) onPick(point); };

  return (
    <figure style={{ margin: 0, fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>
      {caption && (
        <figcaption style={{ ...label, display: 'block', marginBottom: 6 }}>{caption}</figcaption>
      )}
      <div ref={host} style={{ width: '100%' }}>
        <svg width={width} height={layout.height} viewBox={`0 0 ${width} ${layout.height}`} role="group" aria-label={rule ?? ariaLabel} style={{ display: 'block', maxWidth: '100%' }}>
          {layout.yTicks.map((tick) => (
            <g key={`y-${tick.value}`}>
              <line x1={layout.plot.left} x2={layout.plot.right} y1={tick.y} y2={tick.y} stroke="var(--border-subtle)" strokeWidth="1" />
              <text x={layout.plot.left - 8} y={tick.y + 3.5} textAnchor="end" style={text}>{tick.label}</text>
            </g>
          ))}
          {layout.xTicks.map((tick, index) => (
            <text
              key={`x-${tick.at}-${index}`}
              x={tick.x}
              y={layout.plot.bottom + 17}
              textAnchor={index === 0 ? 'start' : (index === layout.xTicks.length - 1 ? 'end' : 'middle')}
              style={text}
            >
              {tick.label}
            </text>
          ))}
          {layout.segments.map((segment, index) => (
            <line key={`s-${index}`} x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} stroke="var(--color-brand)" strokeWidth="1.5" strokeOpacity="0.55" />
          ))}
          {layout.gaps.map((gap, index) => (gap.fits ? (
            <text key={`g-${index}`} x={gap.mid} y={gap.y + 3.5} textAnchor="middle" style={text}>{gap.label}</text>
          ) : (
            <g key={`g-${index}`}>
              <line
                x1={gap.x1 + Math.min(8, (gap.x2 - gap.x1) / 4)}
                x2={gap.x2 - Math.min(8, (gap.x2 - gap.x1) / 4)}
                y1={gap.y}
                y2={gap.y}
                stroke="var(--text-tertiary)"
                strokeWidth="1"
                strokeDasharray="3 3"
                strokeOpacity="0.7"
              />
              <text x={gap.mid} y={layout.plot.bottom + 17 + (gap.row + 1) * GAP_ROW_PX} textAnchor="middle" style={text}>{gap.label}</text>
            </g>
          )))}
          {layout.dots.map((dot, index) => (
            <g
              key={dot.point.key ?? `${dot.point.at}-${index}`}
              role={onPick ? 'button' : 'img'}
              tabIndex={onPick ? 0 : undefined}
              aria-label={dot.point.label}
              onClick={() => pick(dot.point)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                pick(dot.point);
              }}
              onFocus={() => setFocused(index)}
              onBlur={() => setFocused(null)}
              style={{ cursor: onPick ? 'pointer' : 'default', outline: 'none' }}
            >
              <circle cx={dot.x} cy={dot.y} r="14" fill="transparent" />
              {focused === index && <circle cx={dot.x} cy={dot.y} r="8" fill="none" stroke="var(--color-brand)" strokeWidth="1.5" />}
              <circle cx={dot.x} cy={dot.y} r="4.5" fill="var(--color-brand)" />
            </g>
          ))}
        </svg>
      </div>
      {rule && <p style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>{rule}</p>}
    </figure>
  );
}
