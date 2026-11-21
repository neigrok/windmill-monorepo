// Open steps use `?step=<id>` inside the hash; each history entry retains the visit trail.

import { useCallback, useEffect, useState } from 'react';
import { readNavigation, subscribeNavigation, requestNavigation, replaceEntry } from '../../../shell/navigation.js';

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
export function routeOf(location = readNavigation()) {
  const hashRoute = location.hash.split('?')[0];
  return `${location.pathname}${hashRoute === '#' ? '' : hashRoute}`;
}

// The open step and how the reader reached it: `trail` lists the steps of this visit, oldest first, and `door` says
// whether it arrived from a card, from another step, from a link or by going back. A view reads steps only on its own
// route: while the shell is still swapping roadmaps, a step on the next roadmap's URL is none of its business.
function readAddress(door, route) {
  const id = routeOf() === route ? stepOf(readNavigation().hash) : null;
  if (id === null) return { id: null, trail: [], pushed: 0, door };
  const held = readNavigation().state?.boardStep;
  if (held && held.trail[held.trail.length - 1] === id) return { id, trail: held.trail, pushed: held.pushed, door };
  return { id, trail: [id], pushed: 0, door };
}

// Stale steps leave the URL only after this route loads its roadmap.
export function stepIsStale({ loading, tree, treeId, stepId }) {
  return !loading && tree !== null && tree.treeId === treeId && stepId !== null && !tree.nodesById.has(stepId);
}

// `arrivedBy` is how the room reached a step its URL already holds: by a link, or by going back to its entry.
export function useStepAddress(arrivedBy = 'link') {
  const [route] = useState(routeOf);
  const [address, setAddress] = useState(() => readAddress(arrivedBy, route));
  const dropStep = (transaction) => {
    const location = transaction?.read() ?? readNavigation();
    const { boardStep, ...state } = location.state ?? {};
    const hash = hashWithStep(location.hash, null);
    const href = `${location.pathname}${location.search}${hash === '#' ? '' : hash}`;
    if (transaction) transaction.replaceEntry(href, state);
    else replaceEntry(href, state);
  };

  useEffect(() => subscribeNavigation(() => {
    setAddress((shown) => {
      const next = readAddress('back', route);
      return next.id === shown.id ? { ...next, door: shown.door } : next;
    });
  }), []);

  const open = useCallback((id, door, transaction) => {
    const run = (tx) => {
      const current = readAddress('back', route);
      if (current.id === id) return;
      const boardStep = current.id === null
        ? { trail: [id], pushed: 1 }
        : { trail: [...current.trail, id], pushed: current.pushed + 1 };
      const location = tx.read();
      const hash = hashWithStep(location.hash, id);
      tx.pushEntry(`${location.pathname}${location.search}${hash}`, { ...location.state, boardStep });
      setAddress({ id, ...boardStep, door });
    };
    if (transaction?.traverse) return run(transaction);
    return requestNavigation({ key: `step:open:${id}`, run });
  }, []);

  const close = useCallback((transaction) => {
    const run = async (tx) => {
      const current = readAddress('back', route);
      if (current.id === null) return;
      if (current.pushed > 0 && !await tx.traverse(-current.pushed)) return false;
      if (stepOf(tx.read().hash) !== null) dropStep(tx);
    };
    if (transaction?.traverse) return run(transaction);
    return requestNavigation({ key: 'step:close', run });
  }, []);

  const back = useCallback((transaction) => {
    const run = (tx) => {
      const current = readAddress('back', route);
      if (current.pushed > 0) return tx.traverse(-1);
      return close(tx);
    };
    if (transaction?.traverse) return run(transaction);
    return requestNavigation({ key: 'step:back', run });
  }, [close]);

  const drop = useCallback(() => {
    if (readAddress('back', route).id === null) return;
    dropStep();
    setAddress(readAddress('back', route));
  }, []);

  return { ...address, open, back, close, drop };
}
