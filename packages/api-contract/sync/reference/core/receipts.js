import { CONSTANTS } from './constants.js';
import { compareBytes, utf8 } from './encoding.js';
import { jcs, sameJson } from './jcs.js';
import { Registry } from './registry.js';
import { compareRecords } from './rows.js';
import { holdsNul } from './wire.js';
import { Stamp } from './stamp.js';
import { checkId } from './values.js';

export const compareScopeRefs = (a, b) => compareBytes(utf8(a), utf8(b));
export function orderedScopes(origin, scopes) {
  return [origin, ...[...new Set(scopes)].filter((scope) => scope !== origin).sort(compareScopeRefs)];
}

// Receipt slots contain versions only. The committed row supplies text revisions after staging.
export function receiptRow(before, after) {
  const slots = [];
  const stampSlot = (slot, stamp) => slots.push({ slot, version: { kind: 'stamp', stamp } });
  if (after.born !== undefined && after.born !== before?.born) stampSlot({ kind: 'born' }, after.born);
  if (after.life && !sameJson(after.life, before?.life ?? null)) stampSlot({ kind: 'life' }, after.life[1]);
  for (const name of Object.keys(after.f ?? {}).sort(compareScopeRefs)) {
    if (!sameJson(after.f[name], before?.f?.[name] ?? null)) stampSlot({ kind: 'field', name }, after.f[name][1]);
  }
  for (const name of Object.keys(after.x ?? {}).sort(compareScopeRefs)) {
    if (!sameJson(after.x[name], before?.x?.[name] ?? null)) slots.push({ slot: { kind: 'text', name }, version: { kind: 'text', revision: after.x[name].rev } });
  }
  return { t: after.t, id: after.id, beforeRowSeq: before?.seq ?? null, rowSeq: after.seq, slots };
}

export function remappedScope(registry, scope, write = [], targets = []) {
  const governing = registry.governingType;
  if (!governing || registry.scopeKindOf(scope)?.startsWith('product:')) return scope;
  const id = scope.split('/').pop();
  const mapping = write.find((item) => item.t === governing.type && (item.from === id
    || targets.some((target) => target.t === item.t && sameJson(target.from, item.from ?? item.id) && target.id === id)));
  return mapping ? scope.slice(0, scope.length - id.length) + mapping.id : scope;
}

export class ReceiptError extends Error {}

export function scopedResponseBytes(result, epoch, account) {
  const max = Number.MAX_SAFE_INTEGER;
  return utf8(jcs({ serverTime: max, epoch, as: account, lastN: max, results: [{ n: max, ...result }], retry: { n: max, retryAfterMs: max } })).length;
}

// Preflight before any ACK mutation; an extra discovered target is valid but every prediction is required.
export function receiptEffects(registry, entry, result) {
  const fail = () => { throw new ReceiptError('invalid scoped receipt'); };
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exact = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
  const seq = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!object(result.detail) || Object.keys(result.detail).some((key) => !['windmillKit', 'command'].includes(key))) fail();
  const kit = result.detail.windmillKit;
  if (!exact(kit, ['v', 'effects']) || kit.v !== 1 || !Array.isArray(kit.effects) || holdsNul(kit)
    || utf8(jcs(kit)).length > CONSTANTS.RECEIPT_MAX_BYTES) fail();
  const seen = new Set();
  for (const effect of kit.effects) {
    if (!exact(effect, ['scope', 'beforeSeq', 'seq', 'rows']) || typeof effect.scope !== 'string' || seen.has(effect.scope)) fail();
    const kind = registry.scopeKindOf(effect.scope);
    if (!kind || kind === 'device') fail();
    if ((kind === 'tree' || kind === 'overlay') && (!registry.governingType || checkId(registry, registry.governingType, effect.scope.split('/').pop()))) fail();
    if ((effect.beforeSeq !== null && !seq(effect.beforeSeq)) || (effect.seq !== null && !seq(effect.seq))
      || (effect.seq === null && effect.beforeSeq !== null)
      || (effect.beforeSeq !== null && effect.seq < effect.beforeSeq) || !Array.isArray(effect.rows)) fail();
    seen.add(effect.scope);
    let prior;
    for (const row of effect.rows) {
      if (!exact(row, ['t', 'id', 'beforeRowSeq', 'rowSeq', 'slots'])) fail();
      const type = registry.type(row.t);
      if (!type || type.scope !== kind || checkId(registry, type, row.id) || (prior && compareRecords(prior, row) >= 0)) fail();
      if (!seq(row.rowSeq) || row.rowSeq === 0 || row.rowSeq !== effect.seq || effect.beforeSeq === effect.seq
        || (row.beforeRowSeq !== null && (!seq(row.beforeRowSeq) || row.beforeRowSeq >= row.rowSeq || row.beforeRowSeq > effect.beforeSeq))
        || (effect.beforeSeq === null && row.beforeRowSeq !== null) || !Array.isArray(row.slots)) fail();
      prior = row;
      let previous = '';
      for (const item of row.slots) {
        if (!exact(item, ['slot', 'version']) || !object(item.slot) || !object(item.version)) fail();
        const { slot, version } = item;
        let key;
        if (slot.kind === 'born' || slot.kind === 'life') {
          if (!exact(slot, ['kind']) || (slot.kind === 'born' ? !type.hasBorn : !type.life)) fail();
          key = slot.kind === 'born' ? '0' : '1';
        } else {
          if (!exact(slot, ['kind', 'name']) || typeof slot.name !== 'string') fail();
          const field = type.field(slot.name);
          if (slot.kind === 'field' ? !field || !Registry.isLattice(field.kind) : slot.kind !== 'text' || field?.kind !== 'text') fail();
          key = `${slot.kind === 'field' ? '2' : '3'}${slot.name}`;
        }
        if (compareScopeRefs(previous, key) >= 0) fail();
        previous = key;
        if (slot.kind === 'text') {
          if (!exact(version, ['kind', 'revision']) || version.kind !== 'text' || !seq(version.revision) || version.revision === 0 || version.revision > row.rowSeq) fail();
        } else if (!exact(version, ['kind', 'stamp']) || version.kind !== 'stamp' || !Stamp.isValid(version.stamp) || version.stamp === Stamp.UNSET) fail();
      }
      if (row.beforeRowSeq === null) {
        if (type.hasBorn && !row.slots.some(({ slot }) => slot.kind === 'born')) fail();
        if (type.life && !row.slots.some(({ slot }) => slot.kind === 'life')) fail();
      }
    }
    if (effect.seq === null && effect.rows.length) fail();
  }
  const origin = kit.effects[0];
  if (!origin || origin.scope !== entry.scope || origin.beforeSeq === null || origin.seq !== result.seq) fail();
  if (!sameJson(kit.effects.map(({ scope }) => scope), orderedScopes(entry.scope, seen))) fail();
  for (const prediction of entry.predictions) if (!seen.has(remappedScope(registry, prediction.scope, result.write, entry.writeTargets))) fail();
  return kit.effects;
}
