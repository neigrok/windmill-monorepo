// @ts-check

import assert from 'node:assert/strict';
import { ActDecision, ActIDSource, ActReader } from '../../../src/platform/domain-kit/acts.js';
import { IDSource, decision } from '../../../src/platform/domain-kit/actions.js';
import { Draft } from '../../../src/platform/domain-kit/drafts.js';
import { Fields } from '../../../src/platform/domain-kit/entities.js';
import { Reader, Views } from '../../../src/platform/domain-kit/reading.js';
import { translate } from '../../../src/platform/domain-kit/translation.js';
import { Valid } from '../../../src/platform/domain-kit/validation.js';
import { CountSpec, Fault, Path, Violation } from '../../../src/platform/domain-kit/values.js';
import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { applySpec, momentOf, viewRecords } from './vectors.js';

/** @typedef {import('../../../src/platform/domain-kit/values.js').Json} Json */
/** @typedef {import('./vectors.js').Vector} Vector */

export class ProductCorpus {
  /**
   * @param {import('../../../src/platform/domain-kit/rules.js').RuleBook} book
   * @param {(path: string) => import('../../../src/platform/domain-kit/values.js').ValueSpec | null} spec
   */
  constructor(book, spec) {
    this.book = book;
    this.spec = spec;
  }

  /** @param {Vector} vector */
  value(vector) {
    const input = vector.input;
    try {
      if (input.spec) {
        const spec = this.spec(input.spec.path);
        assert.ok(spec, `${vector.file}: no declared spec ${input.spec.path}`);
        assert.equal(jcs(spec.json), jcs(input.spec), `${input.spec.path}: vector and declaration differ`);
        assert.ok(this.book.rules.some((rule) => rule.spec !== null && jcs(rule.spec) === jcs(spec.json)), `${spec.path}: spec absent from book`);
        const at = new Path(input.at ?? spec.path.split('.').at(-1) ?? spec.path);
        if (spec instanceof CountSpec) return { items: input.items === null ? null : spec.apply(input.items, at, (item) => item) };
        return { value: applySpec(spec, input.value, at, input.as === 'int') };
      }
      const type = this.book.entity(input.entity);
      assert.ok(type?.isWritable, `no writable declaration ${input.entity}`);
      return { fields: new Valid(type.decode(Fields.values(type.type, input.id, input.fields)), momentOf(input)).value.fields() };
    } catch (error) {
      if (error instanceof Violation) return { violation: error.json };
      throw error;
    }
  }

  // A case's records in one scope: its `records`, or, in a scene of several scopes, `scopes[scope]`, with the
  // scene's device rows; `stored` defaults to `drawn`, and `ids` are minted in order.
  /** @param {Vector} vector @param {string} scope @param {(type: string) => import('../../../src/platform/domain-kit/entities.js').RecordID} mintId */
  views(vector, scope, mintId) {
    const { records: single, scopes, device = {}, firstPullComplete = true } = vector.input;
    const records = scopes === undefined ? single : scopes[scope] ?? { drawn: [] };
    const stored = viewRecords(records.stored ?? records.drawn);
    return Views.ofRecords(this.book.registry, { drawn: viewRecords(records.drawn), stored, confirmed: stored, devices: device, firstPullComplete, mintId });
  }

  /** @param {Vector} vector */
  mints(vector) {
    const left = [...(vector.input.ids ?? [])];
    return (/** @type {string} */ type) => {
      const id = left.shift();
      if (id === undefined) throw new Fault(`no vector id left for ${type}`);
      return id;
    };
  }

  /** @param {Vector} vector @param {string} scope */
  reader(vector, scope) {
    return new Reader(this.views(vector, scope, this.mints(vector)), scope, momentOf(vector.input));
  }

  // An act's case (§9.5): its load through an act reader over each scope's records, one decision, and each segment
  // translated in its scope: `{write: {segments: [{scope, gesture}], result}}`, `{unchanged: {result}}` or `{refuse}`.
  /**
   * @template L,T,R
   * @param {import('../../../src/platform/domain-kit/acts.js').ActAction<L,T,R>} action
   * @param {Vector} vector
   * @param {(result: T) => Json} resultForm
   * @param {(refusal: R) => Json} refusalForm
   */
  act(action, vector, resultForm, refusalForm) {
    const mint = this.mints(vector);
    const moment = momentOf(vector.input);
    /** @type {import('../../../src/platform/domain-kit/acts.js').ActContext} */
    const context = {
      now: moment.now.ms,
      finishLoad() {},
      inScope: (scope, body) => {
        const views = this.views(vector, scope, mint);
        return body({ drawn: views.drawn, stored: views.stored, confirmed: views.confirmed, devices: views.devices, firstPullComplete: views.firstPullComplete, now: moment.now.ms });
      },
      mintID: (type) => mint(type),
      opaqueID: () => { throw new Fault('an act case mints no opaque id'); },
    };
    const reader = new ActReader(context, this.book.registry, moment);
    const loaded = action.load(reader);
    reader.end();
    /** @type {import('../../../src/platform/domain-kit/acts.js').ActDecision<T, R>} */
    let decided;
    try {
      decided = action.decide(loaded, new ActIDSource(context));
    } catch (error) {
      if (!(error instanceof Violation)) throw error;
      decided = ActDecision.refuse(action.refusals.ofViolation(error));
    }
    if (decided.kind === 'refuse') return { decision: { refuse: refusalForm(decided.refusal) } };
    if (decided.kind === 'unchanged') return { decision: { unchanged: { result: resultForm(decided.result) } } };
    const segments = decided.plan.segments.map((segment) => ({ scope: segment.scope, gesture: /** @type {Json} */ (/** @type {unknown} */ (translate(segment.plan, segment.scope, this.book.registry))) }));
    return { decision: { write: { segments, result: resultForm(decided.result) } } };
  }

  /**
   * @template L,T,R
   * @param {import('../../../src/platform/domain-kit/actions.js').Decider<L,T,R>} action
   * @param {Vector} vector
   * @param {(result: T) => Json} resultForm
   * @param {(refusal: R) => Json} refusalForm
   */
  decision(action, vector, resultForm, refusalForm) {
    const read = this.reader(vector, action.scope);
    const result = decision(action, action.load(read), new IDSource(read.views));
    if (result.kind === 'refuse') return { decision: { refuse: refusalForm(result.refusal) } };
    if (result.kind === 'unchanged') return { decision: { unchanged: { result: resultForm(result.result) } } };
    return { decision: { write: { gesture: translate(result.plan, action.scope, this.book.registry), result: resultForm(result.result) } } };
  }

  /**
   * @template {import('../../../src/platform/domain-kit/entities.js').Writable<any>} E
   * @template L,T,R
   * @param {(draft: Draft<E>) => import('../../../src/platform/domain-kit/actions.js').Decider<L,T,R>} save
   * @param {Vector} vector
   * @param {E} blank
   * @param {(value: E) => E} edit
   * @param {(result: T) => Json} resultForm
   * @param {(refusal: R) => Json} refusalForm
   * @param {string} [scope]
   */
  save(save, vector, blank, edit, resultForm, refusalForm, scope = blank.id.entity.boundScope()) {
    const type = blank.id.entity;
    const existing = this.reader(vector, type.boundScope(scope)).repository(type).find(blank.id, 'drawn');
    const draft = (existing === null ? Draft.new(blank, null, scope) : Draft.opening(existing, scope)).edit(edit);
    return this.decision(save(draft), vector, resultForm, refusalForm);
  }

  /** @param {Vector} vector @param {string} scope @param {(read: Reader) => Json} body */
  read(vector, scope, body) {
    return { result: body(this.reader(vector, scope)) };
  }
}
