// The canvas, before it arrives. Every number below is read off journal.css and must keep matching it.
// No mood pips: DayMarker draws neither pip nor tick for today, and the ghost's newest day is today.

import React from 'react';
import { Ghost, GhostBar } from '../../design-system/index.js';

const COLUMN = { width: 'min(640px, 100% - 44px)', margin: '0 auto', padding: '32px 0 clamp(140px, 24vh, 280px)' };

// .journal-prose is 16/28, so a 10px bar on an 18px gap keeps the arriving prose's rhythm.
const LINE_WIDTHS = ['100%', '94%', '88%', '40%'];

// The strip: two labelled rows, [label][track][numeral] on a 54 / 1fr / 30 grid, 10px between them.
// The track is 24px tall on a 6px bed; the heads are mood's 14px circle and energy's 6x16 capsule,
// resting at the left inset because a ghost of an unwritten day has no value to show.
const ROW = { display: 'grid', gridTemplateColumns: '54px 1fr 30px', columnGap: 10, alignItems: 'center' };
const HEADS = { mood: { width: 14, height: 14, radius: 'var(--radius-full)' }, energy: { width: 6, height: 16, radius: '3px' } };

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }}>
          {['mood', 'energy'].map((field) => (
            <div key={field} style={ROW}>
              <GhostBar width={34} height={10} tone="var(--neutral-200)" />
              <div style={{ position: 'relative', height: 24, display: 'flex', alignItems: 'center' }}>
                <GhostBar width="100%" height={6} radius="var(--radius-full)" />
                <span style={{ position: 'absolute', left: 0, display: 'inline-flex' }}>
                  <GhostBar {...HEADS[field]} tone="var(--neutral-200)" />
                </span>
              </div>
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <GhostBar width={12} height={2} tone="var(--neutral-200)" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </Ghost>
  );
}
