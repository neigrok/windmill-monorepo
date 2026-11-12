// The mark of a step that opens a tree, by what its tree has come to: one set of drawings for the card's pill, the
// step's row and band, the Graph's bar and dock, and the glyph at a node's centre.

import React from 'react';
import { Check, CircleAlert, Repeat } from 'lucide-react';

// The Board's graph mark on lucide's 24 grid, taking lucide's props, so one stroke weight serves every glyph here.
function TreeMark({ size = 24, strokeWidth = 2, absoluteStrokeWidth = false, color = 'currentColor' }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round"
      strokeWidth={absoluteStrokeWidth ? (strokeWidth * 24) / size : strokeWidth} aria-hidden>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M12 7.5v4m0 0-5 5.5m5-5.5 5 5.5" />
    </svg>
  );
}

const DRAWINGS = { open: TreeMark, empty: TreeMark, unread: TreeMark, complete: TreeMark, loop: Repeat, missing: CircleAlert };

// Board strokes are 1.67px at every size the boards draw a glyph. A pill and a row `check` a tree that is done; a band,
// a bar and a node keep the mark, as the step's own state already says done.
export function OpeningGlyph({ face, size, check = false }) {
  const Drawing = check && face === 'complete' ? Check : DRAWINGS[face];
  return <Drawing size={size} strokeWidth={1.66667} absoluteStrokeWidth aria-hidden />;
}

// The node's centre, by the names theme.js gives a render node's `icon`.
const NODE_GLYPHS = { 'tree:mark': TreeMark, 'tree:loop': Repeat, 'tree:missing': CircleAlert };

export function nodeGlyph(name) {
  return NODE_GLYPHS[name] ?? null;
}
