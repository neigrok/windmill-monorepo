// A step open on the Board lives in the URL as `?step=<id>` inside the hash, so a link lands on it and Back leaves it.
// Each step opened from the Board or from another step is its own history entry; the entry remembers the trail of steps
// that led to it, so closing pops them all and a step pushed from a step names the one before it.

import { useCallback, useEffect, useRef, useState } from 'react';

export function stepOf(hash) {
  const query = hash.split('?')[1];
  return query ? new URLSearchParams(query).get('step') : null;
}

// The same hash with the step set, or dropped when `id` is null; every other part of it stays as it was.
export function hashWithStep(hash, id) {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const kept = query.split('&').filter((part) => part !== '' && part !== 'step' && !part.startsWith('step='));
  const parts = id === null ? kept : [...kept, `step=${encodeURIComponent(id)}`];
  return `#${path}${parts.length > 0 ? `?${parts.join('&')}` : ''}`;
}

// The open step and how the reader reached it: `trail` lists the steps of this visit, oldest first, and `door` says
// whether it arrived from a card, from another step, from a link or by going back.
function readAddress(door) {
  const id = stepOf(window.location.hash);
  if (id === null) return { id: null, trail: [], pushed: 0, door };
  const held = window.history.state?.boardStep;
  if (held && held.trail[held.trail.length - 1] === id) return { id, trail: held.trail, pushed: held.pushed, door };
  return { id, trail: [id], pushed: 0, door };
}

function hrefWith(hash) {
  return `${window.location.pathname}${window.location.search}${hash === '#' ? '' : hash}`;
}

export function useStepAddress() {
  const [address, setAddress] = useState(() => readAddress('link'));
  const closing = useRef(false);

  const dropStep = () => {
    const { boardStep, ...state } = window.history.state ?? {};
    window.history.replaceState(state, '', hrefWith(hashWithStep(window.location.hash, null)));
  };

  // A visit that began at a link still shows its first step once the pushed entries are popped, so that step goes too.
  useEffect(() => {
    const follow = () => {
      if (closing.current) {
        closing.current = false;
        if (stepOf(window.location.hash) !== null) dropStep();
      }
      setAddress(readAddress('back'));
    };
    window.addEventListener('popstate', follow);
    window.addEventListener('hashchange', follow);
    return () => {
      window.removeEventListener('popstate', follow);
      window.removeEventListener('hashchange', follow);
    };
  }, []);

  const open = useCallback((id, door) => {
    const current = readAddress('back');
    if (current.id === id) return;
    const boardStep = current.id === null
      ? { trail: [id], pushed: 1 }
      : { trail: [...current.trail, id], pushed: current.pushed + 1 };
    window.history.pushState({ ...window.history.state, boardStep }, '', hrefWith(hashWithStep(window.location.hash, id)));
    setAddress({ id, ...boardStep, door });
  }, []);

  // Closing pops every entry this visit pushed, and an entry that arrived by link loses its step in place.
  const close = useCallback(() => {
    const current = readAddress('back');
    if (current.id === null) return;
    if (current.pushed > 0) {
      closing.current = true;
      window.history.go(-current.pushed);
      return;
    }
    dropStep();
    setAddress(readAddress('back'));
  }, []);

  const back = useCallback(() => {
    const current = readAddress('back');
    if (current.pushed > 0) window.history.back();
    else close();
  }, [close]);

  // A step the roadmap no longer holds leaves the URL where it stands, with nothing pushed or popped.
  const drop = useCallback(() => {
    if (stepOf(window.location.hash) === null) return;
    dropStep();
    setAddress(readAddress('back'));
  }, []);

  return { ...address, open, back, close, drop };
}
