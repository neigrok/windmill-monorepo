import React from 'react';
import { Icon } from '../../design-system/index.js';

// The one back link every pushed screen draws. A tab root draws none. `onClick` is for a screen
// that holds its own pushed state (the note editor): the href still names where the link goes.
export function Back({ href, onClick, children }) {
  return (
    <a className="gym-back" href={href} onClick={onClick}>
      <Icon name="arrow-left" size={16} strokeWidth={1.9} /> {children}
    </a>
  );
}
