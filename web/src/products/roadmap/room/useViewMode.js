import { useEffect, useState } from 'react';
import { readNavigation, subscribeNavigation } from '../../../shell/navigation.js';

const TABLET_MIN = 744;
const DESKTOP_MIN = 1024;

function breakpointFor(width) {
  if (width < TABLET_MIN) return 'phone';
  if (width < DESKTOP_MIN) return 'tablet';
  return 'desktop';
}

function isShared() {
  if (typeof window === 'undefined') return false;
  const shared = new URLSearchParams(readNavigation().search).has('view');
  // The /t/:id path is read-only ONLY while it is the rendered route: the pathname is sticky across
  // hash-only nav, so an owner opening their own /t/ link would otherwise stay locked read-only.
  const pathShare = readNavigation().pathname.startsWith('/t/') && !readNavigation().hash.startsWith('#/');
  return shared || pathShare
    || readNavigation().hash.startsWith('#/t/') || readNavigation().hash.startsWith('#/demo');
}

function readViewMode() {
  const width = typeof window === 'undefined' ? DESKTOP_MIN : window.innerWidth;
  return { breakpoint: breakpointFor(width), shared: isShared() };
}

export function useViewMode() {
  const [view, setView] = useState(readViewMode);
  useEffect(() => {
    const sync = () => setView((prev) => {
      const next = readViewMode();
      return prev.breakpoint === next.breakpoint && prev.shared === next.shared ? prev : next;
    });
    window.addEventListener('resize', sync);
    const release = subscribeNavigation(sync);
    return () => {
      window.removeEventListener('resize', sync);
      release();
    };
  }, []);
  return view;
}
