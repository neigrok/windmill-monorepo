// STATISTICS — the fourth room, and the longest window this product looks through. Everything on it
// is a number the store already decided (stats.js says which, and what stays cut and why); this file
// is the drawing and none of the meaning.
//
// IT IS MATTER-OF-FACT ON PURPOSE. No scrub, no tooltip that has to be hovered — this is read on a
// phone at a rack, where hover does not exist and a chart that hides its numbers behind a gesture is
// a chart with no numbers. So the charts say their own ends in words, every axis states its range,
// and nothing animates on the way in: a bar growing out of the floor is a small celebration, and a
// quarter of honest training is not a thing to be congratulated for.
//
// THE ARITHMETIC IS NOT IN A VIEW BODY. `statsView` runs once per read and is held against the read
// itself — the object the fetch resolved to, which is a DATA VERSION and changes only when new data
// lands. Never a collection length: Lift keyed its chart caches on `sessions.count`, and editing a
// past session left every chart on the screen wrong with the count unmoved. And it matters here for
// a plainer reason too — the live band above this room re-renders twice a second while a workout is
// running, so a trend computed inline would be recomputed twice a second behind it.

import React, { useMemo, useState } from 'react';
import { gymApi } from './gymApi.js';
import { isEmpty, MOVEMENT_PAGE, PLOT, statsView } from './stats.js';
import { useGymRead } from './useGymRead.js';

export function Stats() {
  const view = useGymRead(
    () => Promise.all([gymApi.stats(), gymApi.exercises()])
      .then(([stats, catalog]) => ({ stats, catalog })),
    [],
  );

  if (view.phase === 'ready') return <Counted data={view.data} />;
  if (view.phase === 'failed') {
    return (
      <p className="gym-read-failed">
        The numbers didn’t load.
        <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
      </p>
    );
  }
  // Loading — and anything else the hook could ever answer, which is the point of taking this
  // branch last. `absent` is unreachable here (the read composes an object and never resolves to
  // null), and a fourth phase falling through to a read of `view.data` would be a render that
  // throws and takes the whole app down with it.
  return <p className="gym-quiet">Counting your log…</p>;
}

// Its own component so the memo can hold: the read's phases are branches, and a hook cannot live
// under one. What it is keyed on is the read's own answer — one object per completed read.
function Counted({ data }) {
  const model = useMemo(() => statsView(data.stats, data.catalog), [data]);
  const [allMovements, setAllMovements] = useState(false);

  if (isEmpty(model)) {
    return (
      <section className="gym-stats-screen">
        <h1 className="gym-title">Statistics</h1>
        <p className="gym-quiet">Nothing counted yet.</p>
        <p className="gym-quiet">Finish a session and it starts counting from there.</p>
      </section>
    );
  }

  const movements = allMovements ? model.movements : model.movements.slice(0, MOVEMENT_PAGE);
  return (
    <section className="gym-stats-screen">
      <h1 className="gym-title">Statistics</h1>
      <p className="gym-quiet">Finished sessions only — today’s workout counts once it closes.</p>

      {model.weeks.bars.length > 0 && (
        <section className="gym-weeks">
          {/* TWO CHARTS, NOT ONE WITH TWO AXES. Sessions and working sets are different measures on
              different scales, and putting them on one plot lets whoever chose the two scales decide
              which one looks like it is winning. */}
          <WeekChart title="Sessions a week" bars={model.weeks.bars} max={model.weeks.sessionsMax} field="sessions" pct="sessionsPct" label="sessionsLabel" />
          <WeekChart title="Working sets a week" bars={model.weeks.bars} max={model.weeks.setsMax} field="workingSets" pct="setsPct" label="setsLabel" />
          <p className="gym-weeks-span">
            {`${model.weeks.from} → ${model.weeks.to}`}
            {model.weeks.olderLabel && <span className="gym-weeks-older">{`  ·  ${model.weeks.olderLabel}`}</span>}
          </p>
        </section>
      )}

      {movements.length > 0 && (
        <section className="gym-moves">
          <h2 className="gym-moves-title">Movements</h2>
          {movements.map((movement) => <MovementCard key={movement.exerciseId} movement={movement} />)}
          {!allMovements && model.movements.length > MOVEMENT_PAGE && (
            <button type="button" className="gym-older" onClick={() => setAllMovements(true)}>
              {`Show all ${model.movements.length} movements`}
            </button>
          )}
        </section>
      )}
    </section>
  );
}

// Counts, so bars, so a floor at zero — a bar's LENGTH is its value and a truncated one is simply
// the wrong length. The gutter says both ends of that scale out loud rather than leaving the reader
// to assume the floor, and a week nobody trained draws no bar at all, which is what zero looks like.
//
// The list role and the per-bar label are the text alternative. A `title` would have been fewer
// characters and would have put the numbers behind a hover this product decided not to have.
function WeekChart({ title, bars, max, field, pct, label }) {
  return (
    <figure className="gym-chart">
      <figcaption className="gym-chart-title">{title}</figcaption>
      <div className="gym-chart-plot">
        <div className="gym-chart-scale">
          <span>{max}</span>
          <span>0</span>
        </div>
        <div className="gym-bars" role="list">
          {bars.map((bar) => (
            <div
              className="gym-bar-col"
              key={bar.startedAt}
              role="listitem"
              aria-label={bar[label]}
            >
              {bar[field] > 0 && <span className="gym-bar-fill" style={{ height: `${bar[pct]}%` }} />}
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

// ONE MOVEMENT, ON ITS OWN SCALE. Never a shared Y axis across movements — a bench and a squat on
// one scale is the first bug in Lift's Progress tab, and it is a drawing decision, so it is designed
// out here rather than caught later.
function MovementCard({ movement }) {
  return (
    <article className="gym-move">
      <header className="gym-move-head">
        <h3 className="gym-move-name">{movement.name}</h3>
        <span className="gym-move-when">{`trained ${movement.lastTrained}`}</span>
      </header>
      <p className="gym-move-caption">
        {movement.caption}
        {movement.older > 0 && `  ·  last ${movement.sessions} sessions`}
      </p>

      {movement.plot ? (
        <svg
          className="gym-move-plot"
          viewBox={`0 0 ${movement.plot.width} ${movement.plot.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={movement.summary}
        >
          <line className="gym-plot-zero" x1="0" y1={movement.plot.zeroY} x2={movement.plot.width} y2={movement.plot.zeroY} />
          <path className="gym-plot-line" d={movement.plot.path} fill="none" />
          {movement.plot.dots.map((dot) => (
            <circle className="gym-plot-dot" key={`${dot.x}-${dot.y}`} cx={dot.x} cy={dot.y} r={PLOT.dot} />
          ))}
        </svg>
      ) : (
        <p className="gym-move-flat">Same load every session so far — there is no line in that yet.</p>
      )}

      {/* The ends, in words, because there is no hover to reveal them. One session gets one end and
          no arrow: a single point is not a direction. */}
      <p className="gym-move-ends">
        {movement.first && <span>{`${movement.first.value}  ·  ${movement.first.when}`}</span>}
        {movement.first && <span className="gym-move-arrow" aria-hidden="true">→</span>}
        {movement.last && <span>{`${movement.last.value}  ·  ${movement.last.when}`}</span>}
      </p>

      {movement.bests.length > 0 && (
        <ul className="gym-move-bests">
          {movement.bests.map((best) => (
            <li className="gym-move-best" key={best.label}>
              <span className="gym-move-best-label">{best.label}</span>
              <span className="gym-move-best-value">{best.value}</span>
              <span className="gym-move-best-when">{best.when}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
