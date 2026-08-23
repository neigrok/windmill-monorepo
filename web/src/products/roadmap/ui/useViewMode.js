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
  // The /t/:id path is read-only ONLY while it is the rendered route: the pathname is sticky across
  // hash-only nav, so an owner opening their own /t/ link would otherwise stay locked read-only.
  const pathShare = window.location.pathname.startsWith('/t/') && !window.location.hash.startsWith('#/');
  return shared || pathShare
    || window.location.hash.startsWith('#/t/') || window.location.hash.startsWith('#/demo');
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
