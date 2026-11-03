import { useSyncExternalStore } from 'react';

let current = null;
let publisher = null;
const listeners = new Set();

export function getRoomStatus() {
  return current;
}

export function subscribeRoomStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishRoomStatus(status) {
  const lease = {};
  publisher = lease;
  const next = status ? Object.freeze({ ...status }) : null;
  const unchanged = current === next || (current && next
    && current.line === next.line && current.short === next.short
    && current.icon === next.icon && current.narrow === next.narrow);
  if (!unchanged) {
    current = next;
    for (const listener of listeners) listener();
  }
  return () => {
    if (publisher !== lease) return;
    publisher = null;
    if (!current) return;
    current = null;
    for (const listener of listeners) listener();
  };
}

const serverStatus = () => null;

export function useRoomStatus() {
  return useSyncExternalStore(subscribeRoomStatus, getRoomStatus, serverStatus);
}
