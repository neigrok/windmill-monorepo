import { useRef, useState } from 'react';

// The reorder handle of both drag lists, and the three paths it answers on. The drag is one of them
// and never the only one: WCAG 2.2 SC 2.5.7 asks that what a drag reaches be reachable by a SINGLE
// POINTER without dragging, which the arrows do not answer — they answer 2.1.1, and a phone has no
// arrow keys. So an activation picks the row up, the next activation on any handle places it there,
// the same handle again puts it down where it stands, and Escape puts it back. A real `<button>`
// turns click, Enter, Space and a screen reader's double tap all into the one `click` this reads,
// so the keyboard costs nothing extra.
const PICKED_UP = 'picked up';
const PUT_BACK = 'put back';

export function useRail({ count, nameOf, placeOf, move }) {
  const [picked, setPicked] = useState(null);
  const [said, setSaid] = useState('');
  // A drag must not also be read as an activation. Driven in Chrome, a drop that moved fires no
  // `click` on either rail — the row travels out from under the release, so the hit test lands
  // elsewhere — but a browser that does fire one must not read it as a pick-up. So the latch is
  // armed by a drop that moved, spent by that click where one comes, and cleared by the start of the
  // next pointer sequence where none does. A latch with only the first clear eats the next real tap
  // instead, and the next real tap is the whole single-pointer path.
  const dragged = useRef(false);

  // What the handle does next, said in its own name: the row it holds, or the place it would put
  // the held row, or the ordinary move.
  const nameFor = (index) => {
    if (picked === index) return `Move ${nameOf(index)}, ${placeOf(index)} — ${PICKED_UP}`;
    if (picked !== null) return `Place ${nameOf(picked)} at ${placeOf(index)}`;
    return `Move ${nameOf(index)}, ${placeOf(index)}`;
  };

  // The pick-up outlives a blur on purpose. On a touch screen reader the second activation lands on
  // ANOTHER handle, so focus has already left the first one by the time the place is asked for; a
  // pick-up dropped on blur would make the place unreachable exactly where this is the only path.
  // A keyboard activation is a `click` with no pointer behind it (`detail === 0`) and so is never a
  // drop's own click: it is not what the latch is for, and never spends it.
  const activate = (index, event) => {
    if (dragged.current && event?.detail !== 0) {
      dragged.current = false;
      return;
    }
    if (picked === null) {
      setPicked(index);
      setSaid(`${nameOf(index)}, ${placeOf(index)} — ${PICKED_UP}`);
      return;
    }
    setPicked(null);
    if (picked === index) {
      setSaid(`${nameOf(index)}, ${placeOf(index)} — ${PUT_BACK}`);
      return;
    }
    setSaid(`${nameOf(picked)}, ${placeOf(index)}`);
    move(picked, index);
  };

  // The ends are not wrapped: a row at the top has nowhere above it, and an arrow this handle cannot
  // spend is the page's, like every other key it does not take. A held row is what the arrows move,
  // and it stays held as it travels.
  const step = (index, by) => {
    const from = picked ?? index;
    const to = from + by;
    if (to < 0 || to >= count) return false;
    setSaid(`${nameOf(from)}, ${placeOf(to)}`);
    if (picked !== null) setPicked(to);
    move(from, to);
    return true;
  };

  const keyDown = (index, event) => {
    if (event.key === 'Escape') {
      if (picked === null) return;
      setSaid(`${nameOf(picked)}, ${placeOf(picked)} — ${PUT_BACK}`);
      setPicked(null);
      event.preventDefault();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (step(index, event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault();
  };

  // The start of a pointer sequence: whatever a previous drop armed and no click ever spent goes
  // here, so a tap is never the one that pays for it.
  const grabbed = () => { dragged.current = false; };

  // The end of a drag, clamped by the caller to the rows that exist. A drop that lands where it
  // started is a tap, and a tap is an activation: it is left to the click that follows it.
  const dropped = (from, to) => {
    if (to === from) return;
    dragged.current = true;
    setPicked(null);
    setSaid(`${nameOf(from)}, ${placeOf(to)}`);
    move(from, to);
  };

  return { picked, said, nameFor, activate, keyDown, grabbed, dropped };
}
