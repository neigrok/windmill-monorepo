// @ts-check
// layer: kit
// file: entities.js
import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { utf8 } from '../sync/core/encoding.js';
import { nextDocumentStamp } from '../sync/core/content.js';
import { Path } from './values.js';
export class Card {
  #ownId;
  constructor(id) { this.#ownId = id; this.at = Math.floor(1.5); }
  get label() { return `Date ${jcs(this.#ownId)} console.log random await`; }
  static keep(x) { return Number.isInteger(x) ? new Path('x') : null; }
}
// Date.now() and Math.random() in a comment are not tokens
