// The gym room, before it arrives — three routine cards on the room's own basalt. Kept beside
// Routines.jsx because the numbers below are .gym-routine's, read off gym.css, and the pair has to
// move together.
//
// It draws the CARD, which is the vocabulary every list room in gym is made of, rather than any one
// screen's contents. Worth saying out loud: on this surface #/gym opens Today (the mirror of the
// session running on the phone), not the routine list — the card is what both rooms stack, so the
// stand-in stays true either way, and it promises no title, no tab bar and no numbers, because a
// ghost that draws a control the arriving room might not have is a flash rather than an apology.
//
// The tokens are the palette's, not gym.css's `--gym-*`: this mounts in the shell's room, above the
// .gym-root that defines those, and the shell has already stamped basalt-and-iris on the pair.

import React from 'react';
import { Ghost, GhostBar } from '../../design-system/index.js';

// A WIDTH, not a max-width. The ghost's ground is a flex column (design-system/feedback/Ghost.jsx)
// and `margin: 0 auto` cancels the cross-axis stretch, so a max-width alone leaves this sized to its
// content — three 34px pills adrift mid-screen instead of the 560px card stack .gym-column really
// draws (gym.css). The arriving room contradicting its own stand-in is worse than no stand-in.
const COLUMN = { width: 'min(560px, 100%)', margin: '0 auto', padding: '28px 16px 96px' };

const CARD = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '14px 16px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 12,
  background: 'var(--surface-card)',
};

export function RoutinesGhost() {
  return (
    <Ghost>
      <div style={COLUMN}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[0, 1, 2].map((card) => (
            <div key={card} style={CARD}>
              <GhostBar width="46%" height={12} tone="var(--neutral-200)" />
              <GhostBar width="72%" height={9} />
              <GhostBar width="54%" height={9} />
            </div>
          ))}
        </div>
      </div>
    </Ghost>
  );
}
