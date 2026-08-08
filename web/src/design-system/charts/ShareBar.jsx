import React from 'react';
import { Badge } from '../core/Badge.jsx';
import './charts.css';

// A sliver too thin to be a shape. Below this it is a smear of colour a reader cannot compare
// against anything, and the two pixels it takes belong to its neighbours — so it leaves the bar and
// keeps its row in the legend, where its value is written out in full anyway.
const MIN_VISIBLE_PERCENT = 2;

// PART-TO-WHOLE, so ONE horizontal stacked bar and a legend in real text underneath. The legend is
// not optional decoration: it is the dependable identity channel, and it is what lets this chart
// stay honest inside a design system whose palette is a deliberately narrow warm family. Nobody here
// has to tell two hues apart to read the number — the number is written next to its name.
//
// Segments carry their own `display` string rather than a value this file formats: money belongs to
// the caller's pure module, which knows that a third of a cent is "<$0.01" and not "$0.00".
export function ShareBar({ segments, total, summary }) {
  const shown = segments.filter((segment) => total > 0 && (segment.value / total) * 100 >= MIN_VISIBLE_PERCENT);
  return (
    <div className="wm-share">
      <div className="wm-share-bar" role="img" aria-label={summary}>
        {shown.map((segment) => (
          <span
            key={segment.key}
            className="wm-share-seg"
            style={{ '--tone': segment.tone, width: `${(segment.value / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="wm-share-legend">
        {segments.map((segment) => (
          <li className="wm-share-row" key={segment.key}>
            <span className="wm-share-key" style={{ '--tone': segment.tone }} aria-hidden="true" />
            <span className="wm-share-label">{segment.label}</span>
            {segment.badge && <span title={segment.badge.title}><Badge tone="warning">{segment.badge.text}</Badge></span>}
            <span className="wm-share-value">{segment.display}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ShareBar;
