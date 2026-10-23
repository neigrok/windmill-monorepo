// registry/refusals.json: documents that break one of §2.4's rules beside a document that keeps them.
// Every implementation loads each whole document as a registry; `admitted` says whether it loads.

import { Registry } from '../core/registry.js';
import { vector } from './fixtures.js';

const ITEM = {
  type: 'item', scope: 'product:p', identity: 'minted', idSpace: 'scope', idPattern: '^i_[0-9]+$',
  mint: { prefix: 'i_', alphabet: '0123456789', length: 12 }, life: true, revivable: false, deadRows: 'spent',
  origins: ['replica'], fields: { title: { kind: 'lww', writer: 'client' } },
};
const BOARD = {
  type: 'board', scope: 'product:p', identity: 'minted', idSpace: 'global', idPattern: '^b_[0-9a-f]{8}$',
  mint: { prefix: 'b_', alphabet: '0123456789abcdef', length: 8 }, life: true, revivable: false, deadRows: 'keep',
  governs: 'tree', origins: ['replica'], fields: {},
};
const META = {
  type: 'meta', scope: 'tree', identity: 'singleton', singletonId: 'meta', idPattern: '^meta$', life: false,
  origins: ['replica'], fields: { title: { kind: 'lww', writer: 'client' } },
};

function documentOf(...types) {
  return {
    registry: 'mini', version: 2, minVersion: 1, products: { p: {}, q: {} }, types,
    commands: [{ name: 'p.sweep', scope: 'product:p', origins: ['server'], serverInternal: true, args: {} }],
  };
}

function loaded(name, registry) {
  let admitted = true;
  try {
    new Registry(registry);
  } catch {
    admitted = false;
  }
  return vector(name, { registry }, { admitted });
}

function headlines() {
  return [
    loaded('a primary type of a product scope is its headline type', documentOf({ ...ITEM, primary: true, headline: true })),
    loaded('two products each have a headline type', documentOf(
      { ...ITEM, primary: true, headline: true },
      { ...ITEM, type: 'other', scope: 'product:q', primary: true, headline: true },
    )),
    loaded('a headline type is primary', documentOf({ ...ITEM, headline: true })),
    loaded('headline is true or absent', documentOf({ ...ITEM, primary: true, headline: false })),
    loaded('a headline type lives in a product scope, never in a tree', documentOf(
      { ...BOARD, primary: true },
      { ...META, primary: true, headline: true },
    )),
    loaded('a product has at most one headline type', documentOf(
      { ...ITEM, primary: true, headline: true },
      { ...ITEM, type: 'other', primary: true, headline: true },
    )),
  ];
}

export function files() {
  return { 'registry/refusals.json': headlines() };
}
