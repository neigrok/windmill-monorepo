// The canvas, before it arrives. Kept beside Canvas.jsx on purpose: every number below was read off
// journal.css, and a ghost that stops matching the thing it stands in for is a lie the next person
// to edit the real geometry should trip over rather than discover on a slow connection.
//
// BOTTOM-ANCHORED, because the canvas opens on tonight with the older days already above it. A
// stand-in that filled from the top would promise a scroll to the newest page that never happens.
//
// NO MOOD PIPS. DayMarker draws neither pip nor tick for today, and the ghost's newest day is
// today — a ghost that promises two glyphs the arriving page does not draw is a flash of furniture.
// The five dots and three ticks below are the ScaleStrip under the writing field, which is a
// different control and is really there.

import React from 'react';
import { Ghost, GhostBar } from '../../design-system/index.js';

const COLUMN = { width: 'min(640px, 100% - 44px)', margin: '0 auto', padding: '32px 0 clamp(140px, 24vh, 280px)' };

// .journal-prose is 16/28, so a 10px bar on an 18px gap keeps the arriving prose's own rhythm.
const LINE_WIDTHS = ['100%', '94%', '88%', '40%'];

const MOOD_STEPS = [1, 2, 3, 4, 5];
const ENERGY_HEIGHTS = [6, 10, 14];

export function CanvasGhost() {
  return (
    <Ghost anchor="bottom">
      <div style={COLUMN}>
        {/* Three days: two above tonight, tonight last. .journal-day is 34px apart. */}
        {[0, 1, 2].map((day) => (
          <div key={day} style={{ marginBottom: 34 }}>
            <div style={{ padding: '8px 0 6px' }}>
              <GhostBar width={150} height={12} tone="var(--neutral-200)" />
            </div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 18 }}>
              {LINE_WIDTHS.map((width) => <GhostBar key={width} width={width} height={10} />)}
            </div>
          </div>
        ))}
        {/* The strip: five mood dots (13px on 26px targets), the hairline, three rising ticks. */}
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 16 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {MOOD_STEPS.map((step) => (
              <span key={step} style={{ width: 26, display: 'inline-flex', justifyContent: 'center' }}>
                <GhostBar width={13} height={13} tone="var(--neutral-200)" radius="var(--radius-full)" />
              </span>
            ))}
          </div>
          <span style={{ width: 1, height: 14, margin: '0 10px', background: 'var(--neutral-200)' }} />
          <div style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 3, height: 26, paddingBottom: 6 }}>
            {ENERGY_HEIGHTS.map((height) => (
              <span key={height} style={{ width: 14, display: 'inline-flex', justifyContent: 'center', alignItems: 'flex-end' }}>
                <GhostBar width={5} height={height} tone="var(--neutral-200)" radius="2px" />
              </span>
            ))}
          </div>
        </div>
      </div>
    </Ghost>
  );
}
