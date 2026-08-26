import React from 'react';

// The bottom navigation rail: the rooms of an app, drawn where a thumb already is. `Tabs.jsx` is the
// segmented pill that switches a view; this is the rail that switches a room, and the two are not
// interchangeable.
//
// The rail floats over the scroller, so it also RESERVES its own height in the flow — a page that
// mounts it never has to know how tall it is, and the last row of a list is never under it. The
// account seat does not live here: a rail has as many slots as it has rooms and no more.

export const RAIL_HEIGHT = 72;

export function TabRail({ items, width = 402, label = 'Rooms' }) {
  return (
    <>
      <div aria-hidden="true" style={{ height: RAIL_HEIGHT, flex: 'none' }} />
      <nav
        aria-label={label}
        style={{
          position: 'fixed',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: 0,
          zIndex: 4,
          width: `min(${width}px, 100vw)`,
          boxSizing: 'border-box',
          display: 'grid',
          gridTemplateColumns: `repeat(${items.length}, 1fr)`,
          padding: '0 14px 22px',
          fontFamily: 'var(--font-body)',
          background: 'linear-gradient(to bottom, transparent, var(--surface-canvas) 40%)',
        }}
      >
        {/* Keyed by the label, not the href: two rooms may share a destination (a gallery demo does,
            and a rail whose second slot is not built yet would) and React needs the two told apart. */}
        {items.map((item) => (
          <a
            key={item.label}
            href={item.href}
            aria-current={item.active ? 'page' : undefined}
            style={{
              height: RAIL_HEIGHT - 22,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: item.active ? 'var(--color-brand)' : 'var(--text-tertiary)',
              fontSize: 'var(--text-sm)',
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>
    </>
  );
}
