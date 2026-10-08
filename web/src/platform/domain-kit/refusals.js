// @ts-check
// §12 refusals and notices: one refusal as the engine states it, the product's total mapping of it,
// and an engine notice read as a domain event.

import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { compareText } from './entities.js';

/** @typedef {import('./values.js').Json} Json */
/** @typedef {import('./values.js').Violation} Violation */
/** @typedef {import('./entities.js').RecordID} RecordID */
/** @typedef {import('./entities.js').RecordRef} RecordRef */
/** @typedef {'predicted' | 'notice'} RefusalPath */
/**
 * A product's refusal type, built from a Violation or a Refused by one total mapping (§12.2).
 * @template R
 * @typedef {{ ofViolation(violation: Violation): R, ofRefused(refused: Refused): R, isGeneric(refusal: R): boolean }} Refusals
 */
/**
 * The engine's notice (engine D-17): its content holds the refused deltas, the command and the
 * dependents that folded into it.
 * @typedef {{ d?: NoticeDelta[], cmd?: { name: string, args: Record<string, Json> }, dependents?: NoticeContent[] }} NoticeContent
 * @typedef {{ t: string, id: RecordID, f?: Record<string, [Json, string]>, x?: Record<string, string | { text: string }> }} NoticeDelta
 * @typedef {{ id: string, scope: string, code: string, detail?: Json, content: NoticeContent, at: number }} Notice
 */

export class Refused {
  /**
   * @param {string} code
   * @param {RecordRef | null} subject
   * @param {Json | null} detail
   * @param {RefusalPath} path
   */
  constructor(code, subject, detail, path) {
    this.code = code;
    this.subject = subject;
    this.detail = detail;
    this.path = path;
    Object.freeze(this);
  }

  // §12.1 rule 3: the notice's first delta, else the first ref argument of its command.
  /**
   * @param {Notice} notice
   * @param {import('../../../../packages/api-contract/sync/reference/core/registry.js').Registry} registry
   */
  static ofNotice(notice, registry) {
    const first = notice.content.d?.[0];
    const subject = first ? { t: first.t, id: first.id } : commandSubject(notice.content.cmd, registry);
    return new Refused(notice.code, subject, notice.detail ?? null, 'notice');
  }

  // A cap refusal's detail `{type, cap}`, or null.
  get cap() {
    if (this.code !== 'cap' || this.detail === null || typeof this.detail !== 'object' || Array.isArray(this.detail)) return null;
    const { type, cap } = this.detail;
    if (typeof type !== 'string' || !Number.isSafeInteger(cap)) return null;
    return { type, cap: /** @type {number} */ (cap) };
  }
}

// The first `ref<t>` argument of a command, in the JCS order of its registry arguments.
/**
 * @param {{ name: string, args: Record<string, Json> } | undefined} command
 * @param {import('../../../../packages/api-contract/sync/reference/core/registry.js').Registry} registry
 * @returns {RecordRef | null}
 */
export function commandSubject(command, registry) {
  const definition = command ? registry.command(command.name) : undefined;
  if (!definition) return null;
  for (const name of Object.keys(definition.args).sort(compareText)) {
    const type = /^ref<(.+)>$/u.exec(definition.args[name].type)?.[1];
    const value = command?.args[name];
    if (type === undefined || value === undefined || (typeof value !== 'string' && !Array.isArray(value))) continue;
    return { t: type, id: value };
  }
  return null;
}

/** @template R */
export class DomainNotice {
  /**
   * @param {Notice} notice
   * @param {import('../../../../packages/api-contract/sync/reference/core/registry.js').Registry} registry
   * @param {Refusals<R>} refusals
   */
  constructor(notice, registry, refusals) {
    const refused = Refused.ofNotice(notice, registry);
    this.id = notice.id;
    this.gestureId = DomainNotice.gestureIdOf(notice.id);
    this.subject = refused.subject;
    this.refusal = refusals.ofRefused(refused);
    this.notice = notice;
    Object.freeze(this);
  }

  // The text between `notice:` and the last slash (engine §7.7 step 4).
  /** @param {string} id */
  static gestureIdOf(id) {
    const local = id.startsWith('notice:') ? id.slice('notice:'.length) : id;
    const slash = local.lastIndexOf('/');
    return slash < 0 ? local : local.slice(0, slash);
  }

  // What the refused content wrote to one record, a text field as its text: the deltas, then each
  // dependent's depth first, a later write replacing an earlier one.
  /**
   * @param {RecordRef} record
   * @returns {Record<string, Json>}
   */
  values(record) {
    /** @type {Record<string, Json>} */
    const values = {};
    const key = jcs([record.t, record.id]);
    /** @param {NoticeContent} content */
    const fold = (content) => {
      for (const delta of content.d ?? []) {
        if (jcs([delta.t, delta.id]) !== key) continue;
        for (const [name, register] of Object.entries(delta.f ?? {})) values[name] = register[0];
        for (const [name, text] of Object.entries(delta.x ?? {})) values[name] = typeof text === 'string' ? text : text.text;
      }
      for (const dependent of content.dependents ?? []) fold(dependent);
    };
    fold(this.notice.content);
    return values;
  }
}
