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

// The roadmap a view stands on: the path and the hash before its query.
function routeOf() {
  return `${window.location.pathname}${window.location.hash.split('?')[0]}`;
}

// The open step and how the reader reached it: `trail` lists the steps of this visit, oldest first, and `door` says
// whether it arrived from a card, from another step, from a link or by going back. A view reads steps only on its own
// route: while the shell is still swapping roadmaps, a step on the next roadmap's URL is none of its business.
function readAddress(door, route) {
  const id = routeOf() === route ? stepOf(window.location.hash) : null;
  if (id === null) return { id: null, trail: [], pushed: 0, door };
  const held = window.history.state?.boardStep;
  if (held && held.trail[held.trail.length - 1] === id) return { id, trail: held.trail, pushed: held.pushed, door };
  return { id, trail: [id], pushed: 0, door };
}

function hrefWith(hash) {
  return `${window.location.pathname}${window.location.search}${hash === '#' ? '' : hash}`;
}

// Stale only once this view's own roadmap has loaded without the step, and only while the Board can show at all: with the
// Board's gate closed nothing here ever touches the URL.
export function stepIsStale({ boardOpen, loading, tree, treeId, stepId }) {
  return boardOpen && !loading && tree !== null && tree.treeId === treeId && stepId !== null && !tree.nodesById.has(stepId);
}

export function useStepAddress() {
  const [route] = useState(routeOf);
  const [address, setAddress] = useState(() => readAddress('link', route));
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
      setAddress(readAddress('back', route));
    };
    window.addEventListener('popstate', follow);
    window.addEventListener('hashchange', follow);
    return () => {
      window.removeEventListener('popstate', follow);
      window.removeEventListener('hashchange', follow);
    };
  }, []);

  const open = useCallback((id, door) => {
    const current = readAddress('back', route);
    if (current.id === id) return;
    const boardStep = current.id === null
      ? { trail: [id], pushed: 1 }
      : { trail: [...current.trail, id], pushed: current.pushed + 1 };
    window.history.pushState({ ...window.history.state, boardStep }, '', hrefWith(hashWithStep(window.location.hash, id)));
    setAddress({ id, ...boardStep, door });
  }, []);

  // Closing pops every entry this visit pushed, and an entry that arrived by link loses its step in place.
  const close = useCallback(() => {
    const current = readAddress('back', route);
    if (current.id === null) return;
    if (current.pushed > 0) {
      closing.current = true;
      window.history.go(-current.pushed);
      return;
    }
    dropStep();
    setAddress(readAddress('back', route));
  }, []);

  const back = useCallback(() => {
    const current = readAddress('back', route);
    if (current.pushed > 0) window.history.back();
    else close();
  }, [close]);

  // A step the roadmap no longer holds leaves the URL where it stands, with nothing pushed or popped.
  const drop = useCallback(() => {
    if (readAddress('back', route).id === null) return;
    dropStep();
    setAddress(readAddress('back', route));
  }, []);

  return { ...address, open, back, close, drop };
}
