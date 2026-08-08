import React from 'react';
import './charts.css';

// ONE MEASURE OVER A SEQUENCE OF BUCKETS, drawn as bars from a floor of zero — because a bar's
// LENGTH is its value, and a bar that starts anywhere else is simply the wrong length. The caller
// hands over finished geometry and finished words: this file scales values into heights and does
// not know what any of them mean.
//
// A ZERO DRAWS NOTHING. Not a hairline, not a stub — absence is what zero looks like, and a 1px
// mark at the floor reads as "a little bit" from across a desk.
//
// THE TEXT ALTERNATIVE IS A LIST, not a title attribute. A title would have been fewer characters
// and would have put every number on this chart behind a hover, which is a decision this house has
// already made twice (gym's Statistics room, and this page's whole no-tooltip posture): a chart that
// hides its numbers behind a gesture is a chart with no numbers.
//
// The tone arrives as a CSS VARIABLE STRING and is set as a custom property, so the sheet owns
// opacity, radius and the night skin, and no JavaScript here ever holds a colour.
export function BarSeries({ title, bars, max, floorLabel, ceilingLabel, tone, height = 96 }) {
  // Never zero: a divisor of zero is a NaN in a style attribute, which renders as a bar of no height
  // and no error. An all-zero window is a real state and it draws an empty plot, which is correct.
  const ceiling = Math.max(1, max);
  return (
    <figure className="wm-bars" style={{ '--tone': tone }}>
      <figcaption className="wm-bars-title">{title}</figcaption>
      <div className="wm-bars-plot" style={{ height }}>
        <div className="wm-bars-scale">
          <span>{ceilingLabel}</span>
          <span>{floorLabel}</span>
        </div>
        <div className="wm-bars-track" role="list">
          {bars.map((bar) => (
            <div className="wm-bars-col" key={bar.key} role="listitem" aria-label={bar.label}>
              {bar.value > 0 && (
                <span
                  className={bar.partial ? 'wm-bars-fill wm-bars-fill-partial' : 'wm-bars-fill'}
                  style={{ height: `${(bar.value / ceiling) * 100}%` }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

export default BarSeries;
