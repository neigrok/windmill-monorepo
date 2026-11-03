import { useSyncExternalStore } from 'react';

let current = null;
let publisher = null;
const listeners = new Set();

export function getRoomStatus() {
  return current?.status ?? null;
}

export function subscribeRoomStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerRoomStatus() {
  const lease = {};
  publisher = lease;
  current = Object.freeze({ status: null });
  for (const listener of listeners) listener();
  return {
    publish(status) {
      if (publisher !== lease) return;
      const previous = current.status;
      const next = status ? Object.freeze({ ...status }) : null;
      if (previous === next) return;
      if (previous && next) {
        const unchanged = previous.line === next.line
          && previous.short === next.short
          && previous.icon === next.icon
          && previous.narrow === next.narrow
          && previous.connectivity === next.connectivity;
        if (unchanged) return;
      }
      current = Object.freeze({ status: next });
      for (const listener of listeners) listener();
    },
    release() {
      if (publisher !== lease) return;
      publisher = null;
      current = null;
      for (const listener of listeners) listener();
    },
  };
}

const getPublication = () => current;
const serverPublication = () => null;

export function useRoomStatus() {
  return useSyncExternalStore(subscribeRoomStatus, getPublication, serverPublication);
}
