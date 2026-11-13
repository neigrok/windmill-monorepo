// Open steps use `?step=<id>` inside the hash; each history entry retains the visit trail.

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

// The roadmap a view stands on: the path and the hash's route; a hash holding only a query names none.
export function routeOf() {
  const hashRoute = window.location.hash.split('?')[0];
  return `${window.location.pathname}${hashRoute === '#' ? '' : hashRoute}`;
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

// Stale steps leave the URL only after this route loads its roadmap.
export function stepIsStale({ loading, tree, treeId, stepId }) {
  return !loading && tree !== null && tree.treeId === treeId && stepId !== null && !tree.nodesById.has(stepId);
}

// `arrivedBy` is how the room reached a step its URL already holds: by a link, or by going back to its entry.
export function useStepAddress(arrivedBy = 'link') {
  const [route] = useState(routeOf);
  const [address, setAddress] = useState(() => readAddress(arrivedBy, route));
  const closing = useRef(false);

  const dropStep = () => {
    const { boardStep, ...state } = window.history.state ?? {};
    window.history.replaceState(state, '', hrefWith(hashWithStep(window.location.hash, null)));
  };

  // A visit that began at a link still shows its first step once the pushed entries are popped, so that step goes too.
  // An event that leaves the open step open is no arrival, so the step keeps its door: the hashchange of the navigation
  // that mounted this view can reach it after it mounts.
  useEffect(() => {
    const follow = () => {
      if (closing.current) {
        closing.current = false;
        if (stepOf(window.location.hash) !== null) dropStep();
      }
      setAddress((shown) => {
        const next = readAddress('back', route);
        return next.id === shown.id ? { ...next, door: shown.door } : next;
      });
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
