// §7.7 step 3 dependents: later deltas and commands that touch or name a record a source created, that
// carry a life register a source wrote, or that target a scope its governing record creates; by
// (scope, t, id), and transitive through absorb(). The refusal fold (§7.7), the silent fold of an undo
// and a retire (§7.3), and held-back numbering (§7.4) all use it.

import { moveEntry } from '../core/machines.js';
import { recordKey } from '../core/rows.js';
import { Stamp } from '../core/stamp.js';

export function deltasOf(entry) {
  return [...(entry.intent.d ?? []), ...(entry.predict ?? [])];
}

export function scopedKey(scope, t, id) {
  return `${scope}|${recordKey(t, id)}`;
}

function lifeKey(scope, delta) {
  return `${scopedKey(scope, delta.t, delta.id)}|${delta.life.join('@')}`;
}

// A reference names a record in the scope its type lives in: a product scope, or the tree and overlay
// scopes of the referencing scope's tree.
function scopeOfType(registry, fromScope, t) {
  const kind = registry.type(t)?.scope;
  if (kind?.startsWith('product:')) return `self/${kind.slice('product:'.length)}`;
  const tree = fromScope.split('/').pop();
  return kind === 'tree' ? `tree/${tree}` : `self/overlay/${tree}`;
}

function refsOf(registry, delta) {
  const values = Object.fromEntries(Object.entries(delta.f ?? {}).map(([name, register]) => [name, register[0]]));
  return registry.type(delta.t).referencesOf(delta.id, values);
}

export function commandRefs(registry, cmd) {
  const def = registry.command(cmd.name);
  const refs = [];
  for (const [name, arg] of Object.entries(def?.args ?? {})) {
    const t = /^ref<(.+)>$/.exec(arg.type)?.[1];
    if (t && typeof cmd.args[name] === 'string') refs.push({ t, id: cmd.args[name], name });
  }
  return refs;
}

export class Dependents {
  constructor(registry) {
    this.registry = registry;
    this.created = new Set();
    this.governed = new Set();
    this.lives = new Set();
  }

  // A source's deltas, written at `stamp`: the records they create (a life made alive at its born),
  // the scopes their governing records create, and the life registers they wrote (stamped at or after
  // `stamp`), which a later keyed put may carry unchanged (§7.1 step 4).
  absorb(scope, deltas, stamp) {
    for (const delta of deltas) {
      if (delta.life && Stamp.compare(delta.life[1], stamp) >= 0) this.lives.add(lifeKey(scope, delta));
      if (delta.life?.[0] !== 'alive' || delta.born === undefined || delta.life[1] !== delta.born) continue;
      this.created.add(scopedKey(scope, delta.t, delta.id));
      if (this.registry.type(delta.t)?.governs === 'tree') {
        this.governed.add(`tree/${delta.id}`);
        this.governed.add(`self/overlay/${delta.id}`);
      }
    }
  }

  names(fromScope, t, id) {
    return this.created.has(scopedKey(scopeOfType(this.registry, fromScope, t), t, id));
  }

  // One later entry's dependent part: the dependent deltas, whether its command is dependent, and
  // whether nothing of the entry is independent.
  of(entry) {
    const deltas = entry.intent.d ?? [];
    const removed = deltas.filter((delta) => this.governed.has(entry.scope)
      || this.created.has(scopedKey(entry.scope, delta.t, delta.id))
      || (delta.life !== undefined && this.lives.has(lifeKey(entry.scope, delta)))
      || refsOf(this.registry, delta).some((ref) => this.names(entry.scope, ref.t, ref.id)));
    const cmd = entry.intent.cmd;
    const cmdGone = cmd !== undefined
      && (this.governed.has(entry.scope)
        || commandRefs(this.registry, cmd).some((ref) => this.names(entry.scope, ref.t, ref.id))
        || (entry.predict ?? []).some((delta) => delta.life !== undefined && this.lives.has(lifeKey(entry.scope, delta))));
    return { removed, cmdGone, any: removed.length > 0 || cmdGone, whole: removed.length === deltas.length && (cmd === undefined || cmdGone) };
  }

  // A dependent part joins the sources, so dependency is transitive through the records it creates.
  absorbPart(entry, { removed, cmdGone }) {
    this.absorb(entry.scope, [...removed, ...(cmdGone ? entry.predict ?? [] : [])], entry.stamp);
  }
}

// Removes a queued entry's dependent part: the deltas, the guards on their records, and a dependent
// command with its prediction. Answers the removed content, a snapshot; the entry may be left empty.
export function removeDependent(entry, { removed, cmdGone }) {
  const content = {};
  if (removed.length) content.d = structuredClone(removed);
  if (cmdGone) content.cmd = structuredClone(entry.intent.cmd);
  const kept = (entry.intent.d ?? []).filter((delta) => !removed.includes(delta));
  const removedKeys = new Set(removed.map((delta) => recordKey(delta.t, delta.id)));
  if (kept.length) entry.intent.d = kept;
  else delete entry.intent.d;
  if (entry.intent.guard) {
    entry.intent.guard = entry.intent.guard.filter((guard) => !removedKeys.has(recordKey(guard.t, guard.id)));
    if (entry.intent.guard.length === 0) delete entry.intent.guard;
  }
  if (cmdGone) {
    delete entry.intent.cmd;
    delete entry.predict;
  }
  return content;
}

export function isEmpty(entry) {
  return entry.intent.d === undefined && entry.intent.cmd === undefined;
}

// The silent fold of an undo and a retire (§7.3), planned before anything moves: `sources` are
// `[{entry, deltas}]`, each with the deltas it gives up, and the answer is each later entry's dependent
// part, `[{entry, part}]`. Sources are held, and §7.4 numbers no entry that depends on a held one, so a
// numbered dependent is a broken invariant.
export function silentFoldOf(replica, registry, sources) {
  const dependents = new Dependents(registry);
  const parts = [];
  for (const entry of replica.entries()) {
    const source = sources.find((candidate) => candidate.entry === entry);
    if (source) {
      dependents.absorb(entry.scope, source.deltas, entry.stamp);
      continue;
    }
    const part = dependents.of(entry);
    if (!part.any) continue;
    if (entry.state !== 'held' && entry.state !== 'ready') throw new Error(`${entry.localId} is ${entry.state} and depends on a held entry`);
    dependents.absorbPart(entry, part);
    parts.push({ entry, part });
  }
  return parts;
}

// Applies a silent fold: no notice, and an entry left empty ends undone.
export function foldSilently(replica, ended, parts) {
  for (const { entry, part } of parts) {
    removeDependent(entry, part);
    if (isEmpty(entry)) moveEntry(replica, ended, entry, 'silent-fold');
  }
}
