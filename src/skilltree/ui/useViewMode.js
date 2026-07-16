// The view mode (X5): the current breakpoint from the window width, and whether
// the app is read-only. Small screens default to read-only — editing stays on
// desktop — and a `?view` query param or a `#/t/…` share hash forces read-only
// on any width. Desktop with no share param is the editor, unchanged.

import { useEffect, useState } from 'react';

const TABLET_MIN = 744;
const DESKTOP_MIN = 1024;

function breakpointFor(width) {
  if (width < TABLET_MIN) return 'phone';
  if (width < DESKTOP_MIN) return 'tablet';
  return 'desktop';
}

function isShared() {
  if (typeof window === 'undefined') return false;
  const shared = new URLSearchParams(window.location.search).has('view');
  return shared || window.location.hash.startsWith('#/t/');
}

function readViewMode() {
  const width = typeof window === 'undefined' ? DESKTOP_MIN : window.innerWidth;
  const breakpoint = breakpointFor(width);
  const shared = isShared();
  return { breakpoint, shared, readOnly: shared || breakpoint !== 'desktop' };
}

export function useViewMode() {
  const [view, setView] = useState(readViewMode);
  useEffect(() => {
    const sync = () => setView((prev) => {
      const next = readViewMode();
      return prev.breakpoint === next.breakpoint && prev.readOnly === next.readOnly && prev.shared === next.shared ? prev : next;
    });
    window.addEventListener('resize', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);
  return view;
}
