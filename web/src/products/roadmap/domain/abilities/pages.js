// @ts-check
// Roadmap Coach §5.2: a read's answer in pages of at most 16,384 bytes of canonical text, an object too long for one sent
// in parts, and the cursor that carries a reader from one page to the next.

import { jcs, jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { hashText } from '../../../../platform/sync/core/encoding.js';
import { AbilityCodes } from './answers.js';

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {{ [key: string]: Json }} JsonObject */
/** @typedef {{ index: number, part: number }} Position an object of the sequence, from 0, and the part of it, from 1 */
/** @typedef {{ under: string, make: () => JsonObject }} Entry an object of the sequence: the key it falls under on a page, and how the read answers it */
/** @typedef {{ under: string, value: JsonObject }} Placed */

// The catalog's `result.maxBytes` of every read.
export const MAX_BYTES = 16384;
// The fields whose text or list can pass a page, filled in key order (rule 3).
const LONG = Object.freeze(['description', 'frontier', 'guide', 'links', 'prerequisites', 'subtasks']);
const CURSOR = /^(0|[1-9][0-9]{0,8})\.([1-9][0-9]{0,8})\.([0-9a-f]{16})$/;
// The cuts an object's parts may take for the number they name to hold: past them the pager is at fault, not the object.
const RECUTS = 8;

// A read's answer as pages. `lists` are the lists every page carries, each with the entries that fall on it; an entry
// under any other key is get_tree's header, under `tree`. `read` is what the pages stand on, which each cursor's digest
// holds (rule 4), and `first` what the first page alone carries. Each object is made the first time a page reads it.
export class Pages {
  /** @type {Map<number, JsonObject>} */
  #values = new Map();
  /** @type {Map<number, JsonObject[]>} */
  #parts = new Map();
  /** @type {WeakMap<JsonObject, number>} */
  #bytes = new WeakMap();
  /** @type {Map<number, string>} */
  #digests = new Map();

  /** @param {{ lists: readonly string[], entries: readonly Entry[], read: Json, first?: JsonObject }} answer */
  constructor({ lists, entries, read, first = {} }) {
    this.lists = lists;
    this.entries = entries;
    this.read = read;
    this.first = first;
  }

  // The page a call reads: the first, or the one `cursor` names, checked in rule 5's order; else the code the call is
  // refused with.
  /** @param {string | undefined} cursor @returns {{ page: JsonObject } | { refused: string }} */
  at(cursor) {
    if (cursor === undefined) return { page: this.from({ index: 0, part: 1 }) };
    const form = CURSOR.exec(cursor);
    if (form === null) return { refused: AbilityCodes.invalidInput };
    const position = { index: Number(form[1]), part: Number(form[2]) };
    if (form[3] !== this.digest(position)) return { refused: AbilityCodes.roadmapChanged };
    if (position.index >= this.entries.length || position.part > this.parts(position.index).length) return { refused: AbilityCodes.invalidInput };
    return { page: this.from(position) };
  }

  // Rule 4: the first 16 hexadecimal digits of the SHA-256 of what the pages stand on, with the object the position is
  // inside where it starts past that object's first part. Every part of one object shares its digest.
  /** @param {Position} position */
  digest({ index, part }) {
    const inside = part > 1 && index < this.entries.length ? index : -1;
    const known = this.#digests.get(inside);
    if (known) return known;
    const digest = hashText(jcs({ read: this.read, continues: inside < 0 ? null : this.value(inside) })).slice(0, 16);
    this.#digests.set(inside, digest);
    return digest;
  }

  // The page that starts at `start`. A part before its object's last takes the page alone (rule 2); otherwise whole
  // objects follow while the page stays within the cap (rule 1), and one that would not fit a page alone ends the page
  // before it or, first on its page, is sent in parts.
  /** @param {Position} start */
  from(start) {
    /** @type {Placed[]} */
    const taken = [];
    let index = start.index;
    if (start.part > 1) {
      const parts = this.parts(index);
      const piece = { under: this.under(index), value: /** @type {JsonObject} */ (parts[start.part - 1]) };
      if (start.part < parts.length) return this.page([piece], start, { index, part: start.part + 1 });
      taken.push(piece);
      index++;
    }
    for (; index < this.entries.length; index++) {
      const entry = { under: this.under(index), value: this.value(index) };
      if (this.bytes([entry], { index, part: 1 }, this.after(index)) > MAX_BYTES) {
        if (taken.length) return this.page(taken, start, { index, part: 1 });
        return this.page([{ under: entry.under, value: /** @type {JsonObject} */ (this.parts(index)[0]) }], start, { index, part: 2 });
      }
      if (this.bytes([...taken, entry], start, this.after(index)) > MAX_BYTES) return this.page(taken, start, { index, part: 1 });
      taken.push(entry);
    }
    return this.page(taken, start, null);
  }

  // Rules 2 and 3: the parts of the object at `index`, or the object alone where it fits a page. Every part names their
  // number, which changes how much each carries, so they are cut again until the number they name is the number they
  // come to.
  /** @param {number} index @returns {JsonObject[]} */
  parts(index) {
    const known = this.#parts.get(index);
    if (known) return known;
    let parts = [this.value(index)];
    if (this.bytes([{ under: this.under(index), value: this.value(index) }], { index, part: 1 }, this.after(index)) > MAX_BYTES) {
      for (let count = 2, cuts = 0; ; count = parts.length, cuts++) {
        if (cuts === RECUTS) throw new Error(`the parts of sequence object ${index} do not settle`);
        parts = this.cut(index, count);
        if (parts.length === count) break;
      }
    }
    this.#parts.set(index, parts);
    return parts;
  }

  // The object at `index` cut into parts that each name `count`. Each part but the last fills its page as far as whole
  // Unicode scalars of text and whole elements of a list allow, its long fields in key order; part 1 carries every field
  // of the object, a long one empty where none of it fits, and a later part its `id` and the rest of each long field
  // that goes on there. A part is measured as its frame, each long field empty, and the bytes of the pieces it carries,
  // so cutting it costs what it holds.
  /** @param {number} index @param {number} count @returns {JsonObject[]} */
  cut(index, count) {
    const value = this.value(index);
    const under = this.under(index);
    const fields = LONG.flatMap((key) => {
      const field = value[key];
      return typeof field === 'string' || Array.isArray(field) ? [new LongField(key, field)] : [];
    });
    const longKeys = new Set(fields.map((field) => field.key));
    // How many pieces of each field the parts before have carried.
    const sent = new Map(fields.map((field) => [field, 0]));
    /** @type {JsonObject[]} */
    const parts = [];
    for (let part = 1; ; part++) {
      const start = { index, part };
      /** @type {JsonObject} */
      const base = part === 1 ? Object.fromEntries(Object.entries(value).filter(([key]) => !longKeys.has(key)))
        : value.id === undefined ? {} : { id: value.id };
      Object.assign(base, { part, parts: count });
      /** @param {LongField[]} carrying @param {Position | null} next */
      const frame = (carrying, next) => this.bytes([{ under, value: { ...base, ...Object.fromEntries(carrying.map((field) => [field.key, field.empty])) } }],
        start, next);
      const going = fields.filter((field) => part === 1 || (sent.get(field) ?? 0) < field.length);
      const rest = going.reduce((bytes, field) => bytes + field.bytes(sent.get(field) ?? 0, field.length), 0);
      if (frame(going, this.after(index)) + rest <= MAX_BYTES) {
        return [...parts, { ...base, ...Object.fromEntries(going.map((field) => [field.key, field.piece(sent.get(field) ?? 0, field.length)])) }];
      }
      /** @type {{ field: LongField, from: number, to: number }[]} */
      const carried = [];
      let used = 0;
      for (const field of fields) {
        const from = sent.get(field) ?? 0;
        if (from === field.length) continue;
        const room = MAX_BYTES - used - frame(part === 1 ? fields : [...carried.map((run) => run.field), field], { index, part: part + 1 });
        const to = field.fit(from, room);
        if (to > from) {
          carried.push({ field, from, to });
          used += field.bytes(from, to);
          sent.set(field, to);
        }
        if (to < field.length) break;
      }
      if (!carried.length) throw new Error(`sequence object ${index} has a part that carries nothing`);
      parts.push({ ...base, ...(part === 1 ? Object.fromEntries(fields.map((field) => [field.key, field.empty])) : {}),
        ...Object.fromEntries(carried.map(({ field, from, to }) => [field.key, field.piece(from, to)])) });
    }
  }

  /** @param {number} index */
  value(index) {
    const known = this.#values.get(index);
    if (known) return known;
    const value = /** @type {Entry} */ (this.entries[index]).make();
    this.#values.set(index, value);
    return value;
  }

  /** @param {number} index */
  under(index) { return /** @type {Entry} */ (this.entries[index]).under; }

  // Where the sequence goes on after the object at `index` taken whole, or null where it ends there.
  /** @param {number} index @returns {Position | null} */
  after(index) { return index + 1 < this.entries.length ? { index: index + 1, part: 1 } : null; }

  // The page as it is sent: every list of the read with the entries that fall on it, the header under `tree`, the cursor
  // of `next`, and on the first page what it alone carries.
  /** @param {Placed[]} taken @param {Position} start @param {Position | null} next */
  page(taken, start, next) {
    const page = this.frame(taken, start);
    for (const list of this.lists) page[list] = taken.filter((entry) => entry.under === list).map((entry) => entry.value);
    if (next !== null) page.nextCursor = `${next.index}.${next.part}.${this.digest(next)}`;
    return page;
  }

  // The canonical bytes of the page: its frame, with every list empty and a cursor as long as `next`'s, and each list
  // entry's own bytes, since a list's text is its entries' texts joined by commas between its brackets.
  /** @param {Placed[]} taken @param {Position} start @param {Position | null} next */
  bytes(taken, start, next) {
    const frame = this.frame(taken, start);
    for (const list of this.lists) frame[list] = [];
    if (next !== null) frame.nextCursor = `${next.index}.${next.part}.${'0'.repeat(16)}`;
    let bytes = jcsBytes(frame).length;
    for (const list of this.lists) {
      const values = taken.filter((entry) => entry.under === list).map((entry) => entry.value);
      bytes += values.reduce((sum, value) => sum + this.valueBytes(value), Math.max(0, values.length - 1));
    }
    return bytes;
  }

  // What a page carries beside its lists: the header, and on the first page what it alone carries.
  /** @param {Placed[]} taken @param {Position} start @returns {JsonObject} */
  frame(taken, start) {
    /** @type {JsonObject} */
    const frame = start.index === 0 && start.part === 1 ? { ...this.first } : {};
    for (const entry of taken) if (!this.lists.includes(entry.under)) frame[entry.under] = entry.value;
    return frame;
  }

  /** @param {JsonObject} value */
  valueBytes(value) {
    const known = this.#bytes.get(value);
    if (known !== undefined) return known;
    const bytes = jcsBytes(value).length;
    this.#bytes.set(value, bytes);
    return bytes;
  }
}

// A long field of an object cut into parts: its pieces, whole Unicode scalars of a text or whole elements of a list, and
// the canonical bytes of every run of them, which a text's quotes and a list's brackets and commas frame.
class LongField {
  /** @param {string} key @param {string | Json[]} value */
  constructor(key, value) {
    this.key = key;
    this.text = typeof value === 'string';
    /** @type {Json[]} */
    this.pieces = this.text ? [...String(value)] : [.../** @type {Json[]} */ (value)];
    this.length = this.pieces.length;
    // The bytes of the first n pieces, by n; a scalar's own, its quotes left out.
    this.sums = new Float64Array(this.length + 1);
    for (const [at, piece] of this.pieces.entries()) this.sums[at + 1] = (this.sums[at] ?? 0) + jcsBytes(piece).length - (this.text ? 2 : 0);
  }

  // The bytes the pieces `from` to `to` add to the field held empty: their own, and a comma between two elements.
  /** @param {number} from @param {number} to */
  bytes(from, to) {
    if (to <= from) return 0;
    return (this.sums[to] ?? 0) - (this.sums[from] ?? 0) + (this.text ? 0 : to - from - 1);
  }

  // How far from `from` the pieces go within `room` bytes: the end of the longest run that fits.
  /** @param {number} from @param {number} room */
  fit(from, room) {
    let to = from;
    for (let high = this.length; to < high;) {
      const middle = (to + high + 1) >> 1;
      if (this.bytes(from, middle) <= room) to = middle;
      else high = middle - 1;
    }
    return to;
  }

  get empty() { return this.text ? '' : []; }

  /** @param {number} from @param {number} to @returns {Json} */
  piece(from, to) {
    const run = this.pieces.slice(from, to);
    return this.text ? run.join('') : run;
  }
}
