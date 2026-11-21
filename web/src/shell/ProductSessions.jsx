import React, { createContext, useContext, useEffect, useId, useState, useSyncExternalStore } from 'react';

const SessionContributions = createContext([]);

// The rows product sessions offer the account menu, each `{ label, count, onSelect }`, in the order they were offered.
class AccountRows {
  constructor() {
    this.offers = new Map();
    this.listeners = new Set();
    this.rows = Object.freeze([]);
  }

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.rows;

  offer(key, row) {
    if (this.offers.get(key) === (row ?? undefined)) return;
    if (row) this.offers.set(key, row);
    else this.offers.delete(key);
    this.rows = Object.freeze([...this.offers.values()]);
    for (const listener of this.listeners) listener();
  }
}

const OfferedRows = createContext(new AccountRows());

export function ProductSessions({ products, dataScope, children }) {
  const [rows] = useState(() => new AccountRows());
  const contributions = products.flatMap((product) => product.session ? [product.session] : []);
  const content = contributions.reduceRight((nested, { Provider }, index) => (
    <Provider key={index} dataScope={dataScope}>{nested}</Provider>
  ), children);
  return (
    <SessionContributions.Provider value={contributions}>
      <OfferedRows.Provider value={rows}>{content}</OfferedRows.Provider>
    </SessionContributions.Provider>
  );
}

export function ProductSessionNotices() {
  return useContext(SessionContributions).map(({ Notice }, index) => Notice ? <Notice key={index} /> : null);
}

// A product session offers the account menu one row while `row` is not null: `{ label, count, onSelect }`, the same
// object for as long as it says the same.
export function useAccountRowOffer(row) {
  const rows = useContext(OfferedRows);
  const key = useId();
  useEffect(() => { rows.offer(key, row); }, [rows, key, row]);
  useEffect(() => () => rows.offer(key, null), [rows, key]);
}

export function useOfferedAccountRows() {
  const rows = useContext(OfferedRows);
  return useSyncExternalStore(rows.subscribe, rows.getSnapshot, rows.getSnapshot);
}
