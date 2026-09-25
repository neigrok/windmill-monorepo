import React, { useEffect, useRef, useState } from 'react';

// A dot per measurement on a truncated, labelled y-axis: the series' own minimum and maximum plus
// padding, so a series that moves between 82.0 and 84.5 fills the frame instead of drawing as a
// row of near-identical full-height marks. Two consecutive dots are joined only when the caller's
// `joins(from, to)` says so — what counts as consecutive (calendar days, elapsed hours) is the
// series' own rule; a longer gap is left visibly empty and carries the label the caller words for
// it. The label sits inside the gap when it fits; on a narrow frame the gap carries a dashed marker
// and its label moves beneath the axis under the gap's midpoint, a second line taking any label
// that would collide with one already placed. Nothing here fits, projects, smooths or scores a
// series: the dots are the data and the segments are a reading aid.

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
const MARGIN = { left: 46, right: 14, top: 14, bottom: 26 };
const COMPACT_MARGIN = { left: 30, right: 0, top: 0, bottom: 26 };
const COMPACT_DOT_RADIUS = 2.5;
const MINIMAL_MARGIN = { left: 32, right: 16, top: 20, bottom: 40 };
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
function valueDomain(values, rounded = false) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max > min ? Math.max((max - min) * 0.15, 0.2) : 1;
  const domain = { min: min - pad, max: max + pad };
  if (!rounded) return domain;
  const target = (domain.max - domain.min) / 2;
  const power = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((value) => value >= target);
  return { min: Math.floor(domain.min / step) * step, max: Math.ceil(domain.max / step) * step };
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
function placeBeneath(gaps, width, glyphWidth = GLYPH_PX) {
  const edges = [];
  for (const gap of gaps) {
    if (gap.fits) continue;
    const half = (gap.label.length * glyphWidth) / 2;
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
  points, domain = null, joins, width, height, formatValue, formatDate, gapLabel, fontSize = 10.5, compact = false, minimal = false, edgeInset = 0,
}) {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const margin = compact ? COMPACT_MARGIN : minimal ? MINIMAL_MARGIN : MARGIN;
  if (sorted.length === 0) {
    const plot = { left: margin.left, right: width - margin.right, top: margin.top, bottom: height - margin.bottom };
    return { plot, dots: [], segments: [], gaps: [], yTicks: [], xTicks: [], gapRows: 0, height };
  }
  const glyphWidth = GLYPH_PX * fontSize / 10.5;
  const xDomain = domain ?? { from: sorted[0].at, to: sorted[sorted.length - 1].at };
  const endpoints = compact || minimal;
  const yDomain = valueDomain(sorted.map((point) => point.value), endpoints);
  const ticks = endpoints
    ? [yDomain.min, yDomain.max].map((value) => ({ value, label: formatValue(value) }))
    : valueTicks(yDomain, formatValue);
  // The axis column is as wide as its widest label, so a unit on the labels never runs under the plot.
  const widest = Math.max(...ticks.map((tick) => tick.label.length));
  const left = Math.max(margin.left, Math.ceil(widest * glyphWidth) + (endpoints ? 8 : AXIS_PAD));
  const plot = { left, right: width - margin.right, top: margin.top, bottom: height - margin.bottom };
  const xSpan = Math.max(xDomain.to - xDomain.from, 1);
  const x = (at) => plot.left + edgeInset + ((at - xDomain.from) / xSpan) * (plot.right - plot.left - edgeInset * 2);
  const y = (value) => plot.bottom - ((value - yDomain.min) / (yDomain.max - yDomain.min)) * (plot.bottom - plot.top);

  const dots = sorted.map((point) => ({ x: compact ? Math.min(x(point.at), width - COMPACT_DOT_RADIUS) : x(point.at), y: y(point.value), point }));
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
      fits: label.length * glyphWidth <= (to.x - from.x) - 16,
    });
  }
  const gapRows = placeBeneath(gaps, width, glyphWidth);
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
  points, domain = null, joins, gapLabel, formatValue, formatDate, caption, onPick = null,
  height = 220, axisFontSize = 10.5, ariaLabel = 'chart', interactive = false, compact = false, minimal = false, pointPitch = 0, holdMs = 1500,
}) {
  const host = useRef(null);
  const viewport = useRef(null);
  const drag = useRef(null);
  const clear = useRef(null);
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

  const plotWidth = interactive ? Math.max(width, new Set(points.map((point) => point.at)).size * pointPitch + 60) : width;
  const layout = dotChartLayout({ points, domain, joins, width: plotWidth, height, formatValue, formatDate, gapLabel: compact ? () => '' : gapLabel, fontSize: axisFontSize, compact, minimal, edgeInset: interactive && !minimal ? 14 : 0 });
  useEffect(() => {
    if (interactive && viewport.current) viewport.current.scrollLeft = plotWidth;
  }, [interactive, plotWidth, domain?.from]);
  useEffect(() => () => { if (clear.current !== null) clearTimeout(clear.current); }, []);
  const select = (index) => {
    if (clear.current !== null) clearTimeout(clear.current);
    clear.current = null;
    setFocused(index);
  };
  const release = () => {
    if (!interactive) return;
    drag.current = null;
    if (clear.current !== null) clearTimeout(clear.current);
    clear.current = setTimeout(() => { clear.current = null; setFocused(null); }, holdMs);
  };
  const hover = (event) => {
    if (!interactive || !layout.dots.length) return;
    if (drag.current) {
      if (viewport.current) viewport.current.scrollLeft = drag.current.scroll - (event.clientX - drag.current.x);
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) * plotWidth / box.width;
    let nearest = 0;
    for (let index = 1; index < layout.dots.length; index += 1) {
      if (Math.abs(layout.dots[index].x - x) < Math.abs(layout.dots[nearest].x - x)) nearest = index;
    }
    select(nearest);
  };
  const axisText = { ...text, fontSize: axisFontSize, ...(minimal ? { fill: 'var(--text-secondary)' } : {}) };
  const pick = (point) => { if (onPick) onPick(point); };
  const yTicks = layout.yTicks;
  const frameHeight = compact || minimal || interactive ? height : layout.height;
  const xTicks = compact || minimal ? layout.xTicks.filter((_, index) => index === 0 || index === layout.xTicks.length - 1) : layout.xTicks;

  return (
    <figure className={minimal ? 'dot-chart-minimal' : undefined} style={{ margin: 0, position: minimal ? 'relative' : undefined, fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>
      {caption && (
        <figcaption style={{ ...label, display: 'block', marginBottom: 6 }}>{caption}</figcaption>
      )}
      {interactive && <p className={`dot-chart-readout${focused == null ? ' is-hint' : ''}`} aria-live="polite" style={{ ...label, minHeight: minimal ? undefined : 32, margin: minimal ? 0 : '0 0 4px' }}>{focused != null ? layout.dots[focused]?.point.label : 'Hover or use ← → to read a session'}</p>}
      <div ref={host} style={{ width: '100%', position: 'relative' }}>
        <div ref={viewport} style={{ overflowX: interactive ? 'auto' : 'hidden', overscrollBehaviorX: 'contain' }}>
        <svg width={plotWidth} height={frameHeight} viewBox={`0 0 ${plotWidth} ${frameHeight}`} role="group" aria-label={interactive && focused != null ? `${ariaLabel}. ${layout.dots[focused]?.point.label ?? ''}` : ariaLabel} tabIndex={interactive ? 0 : undefined}
          onPointerMove={interactive ? hover : undefined}
          onPointerDown={(event) => {
            if (!interactive) return;
            hover(event);
            drag.current = { x: event.clientX, scroll: viewport.current?.scrollLeft ?? 0 };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerUp={interactive ? release : undefined} onPointerCancel={interactive ? release : undefined} onPointerLeave={() => { if (interactive && !drag.current) release(); }}
          onKeyDown={(event) => {
            if (!interactive || !layout.dots.length || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            const next = Math.max(0, Math.min(layout.dots.length - 1, (focused ?? layout.dots.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)));
            select(next);
            if (viewport.current) viewport.current.scrollLeft = layout.dots[next].x - width / 2;
          }}
          style={{ display: 'block', maxWidth: interactive ? 'none' : '100%', touchAction: interactive ? 'pan-x' : undefined, cursor: interactive ? 'grab' : undefined }}>

          {yTicks.map((tick) => (
            <g key={`y-${tick.value}`}>
              {!compact && !minimal && <line x1={layout.plot.left} x2={layout.plot.right} y1={tick.y} y2={tick.y} stroke="var(--border-subtle)" strokeWidth="1" />}
              {!interactive && <text x={compact || minimal ? 0 : layout.plot.left - 8} y={compact ? Math.max(axisFontSize, Math.min(layout.plot.bottom - 4, tick.y + 3.5)) : tick.y + 3.5} textAnchor={compact || minimal ? 'start' : 'end'} style={axisText}>{tick.label}</text>}
            </g>
          ))}
          {!interactive && xTicks.map((tick, index) => (
            <text
              key={`x-${tick.at}-${index}`}
              x={compact && index === 0 ? tick.x + 2 : tick.x}
              y={layout.plot.bottom + (compact ? 21 : minimal ? 33 : 17)}
              textAnchor={index === 0 ? 'start' : (index === xTicks.length - 1 ? 'end' : 'middle')}
              style={axisText}
            >
              {tick.label}
            </text>
          ))}
          {layout.segments.map((segment, index) => (
            <line key={`s-${index}`} x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} stroke="var(--color-brand)" strokeWidth="1.5" strokeOpacity={minimal ? '1' : '0.55'} />
          ))}
          {!compact && !minimal && layout.gaps.map((gap, index) => (gap.fits ? (
            <text key={`g-${index}`} x={gap.mid} y={gap.y + 3.5} textAnchor="middle" style={axisText}>{gap.label}</text>
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
              {!interactive && <text x={gap.mid} y={layout.plot.bottom + 17 + (gap.row + 1) * GAP_ROW_PX} textAnchor="middle" style={axisText}>{gap.label}</text>}
            </g>
          )))}
          {layout.dots.map((dot, index) => (
            <g
              key={dot.point.key ?? `${dot.point.at}-${index}`}
              role={onPick ? 'button' : 'img'}
              tabIndex={onPick || interactive ? 0 : undefined}
              aria-label={dot.point.label}
              onClick={() => pick(dot.point)}
              onKeyDown={(event) => {
                if (interactive && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                pick(dot.point);
              }}
              onFocus={() => select(index)}
              onBlur={() => setFocused(null)}
              style={{ cursor: onPick ? 'pointer' : 'default', outline: 'none' }}
            >
              <title>{dot.point.label}</title>
              <circle cx={dot.x} cy={dot.y} r="14" fill="transparent" />
              {focused === index && <circle cx={dot.x} cy={dot.y} r="8" fill="none" stroke="var(--color-brand)" strokeWidth="1.5" />}
              <circle cx={dot.x} cy={dot.y} r={compact ? COMPACT_DOT_RADIUS : minimal ? '4' : '4.5'} fill={dot.point.color ?? 'var(--color-brand)'} />
            </g>
          ))}
        </svg>
        </div>
        {interactive && <svg aria-hidden="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', maxWidth: '100%' }}>
          <rect x="0" y="0" width={minimal ? layout.plot.left - 8 : layout.plot.left} height={height} fill="var(--surface-card)" />
          {yTicks.map((tick) => <text key={tick.value} x={minimal ? 0 : layout.plot.left - 8} y={tick.y + 3.5} textAnchor={minimal ? 'start' : 'end'} style={axisText}>{tick.label}</text>)}
          {[layout.xTicks[0], layout.xTicks.at(-1)].filter(Boolean).map((tick, index) => <text key={`${tick.at}-${index}`} x={index === 0 ? layout.plot.left : width - (minimal ? MINIMAL_MARGIN.right : MARGIN.right)} y={layout.plot.bottom + (minimal ? 33 : 17)} textAnchor={index === 0 ? 'start' : 'end'} style={axisText}>{tick.label}</text>)}
        </svg>}
      </div>
      {(interactive || minimal) && !compact && layout.gaps.filter((gap) => minimal || !gap.fits).map((gap, index) => <p key={index} className="dot-chart-gap" style={{ ...label, ...(minimal ? { fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' } : {}), fontSize: axisFontSize, lineHeight: '18px', margin: minimal ? '12px 0 0' : '4px 0 0', overflowWrap: 'anywhere' }}>{gap.label}</p>)}
    </figure>
  );
}
