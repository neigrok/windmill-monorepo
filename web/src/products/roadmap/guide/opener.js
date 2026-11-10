import { useEffect, useRef, useState } from 'react';

// The guide's opener is the chip from 744px or a reader's line on phones: the one control that opens a surface on the
// guide, the one that flashes when a guide set elsewhere arrives, and the one focus returns to when a surface closes.

const FLASH_MS = 750;

// The gold beat a guide set elsewhere earns, on the chip or the reader's line. It retires on a timer: under reduced motion
// the animation never runs, so its end alone would leave the class standing.
export function useGuideFlash(arrival) {
  const [flashing, setFlashing] = useState(false);
  const shownAt = useRef(arrival);
  useEffect(() => {
    if (arrival === shownAt.current) return undefined;
    shownAt.current = arrival;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [arrival]);
  return flashing;
}

// A surface closing hands focus back to the chip or the line that opened it, whichever stands uncovered.
export function focusGuideOpener() {
  const opener = [...document.querySelectorAll('[data-guide-opener]')]
    .find((element) => !element.closest('[inert]') && element.getClientRects().length > 0);
  opener?.focus({ preventScroll: true });
}
