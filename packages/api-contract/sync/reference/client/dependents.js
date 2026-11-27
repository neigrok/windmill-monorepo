// §7.7 step 3 dependents: later deltas and commands that touch or name a record a source created, that
// carry a life register a source wrote, or that target a scope its governing record creates; by
// (scope, t, id), and transitive through absorb(). A reference names the record its compiled leaf
// resolves to (E-8), and a command's proposed creation names none. The refusal fold (§7.7), the silent
// fold of an undo, a retire and a supersede (§7.3), and held-back numbering (§7.4) all use it.

import { moveEntry } from '../core/machines.js';
import { recordKey } from '../core/rows.js';
import { Stamp } from '../core/stamp.js';
import { effectsOf, predictionsOf } from './projections.js';

export function deltasOf(entry) {
  return effectsOf(entry).flatMap(({ d }) => d);
}

// The command an entry runs of its own, or undefined: a capture command is the ordinary deltas' own (§7.3 Undo of an
// act, Capture), so an entry carrying one folds, retires and empties as an ordinary entry does.
export function ownCommandOf(registry, entry) {
  const { cmd } = entry.intent;
  return cmd === undefined || registry.command(cmd.name)?.engine === 'capture' ? undefined : cmd;
}

export function scopedKey(scope, t, id) {
  return `${scope}|${recordKey(t, id)}`;
}

function lifeKey(scope, delta) {
  return `${scopedKey(scope, delta.t, delta.id)}|${delta.life.join('@')}`;
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

  names(references) {
    return references.some(({ scope, t, id }) => this.created.has(scopedKey(scope, t, id)));
  }

  absorbEntry(entry, selected) {
    for (const { scope, d } of effectsOf(entry)) this.absorb(scope, selected ? d.filter((delta) => selected.includes(delta)) : d, entry.stamp);
  }

  // One later entry's dependent part: the dependent deltas, whether its command is dependent, whether
  // nothing of the entry is independent, and, when the sources are being replaced, its guards on what
  // they created: a replacement is numbered after the entry, so the record it read is not there yet.
  of(entry, { replaced = false } = {}) {
    const deltas = entry.intent.d ?? [];
    const { references } = this.registry;
    const removed = deltas.filter((delta) => this.governed.has(entry.scope)
      || this.created.has(scopedKey(entry.scope, delta.t, delta.id))
      || (delta.life !== undefined && this.lives.has(lifeKey(entry.scope, delta)))
      || this.names(references.ofRecord(entry.scope, delta)));
    const cmd = entry.intent.cmd;
    const cmdGone = cmd !== undefined
      && (this.governed.has(entry.scope)
        || this.names(references.ofCommand(entry.scope, cmd))
        || (entry.predictions && predictionsOf(entry).some(({ scope, d }) => this.governed.has(scope)
          || d.some((delta) => this.created.has(scopedKey(scope, delta.t, delta.id))
            || (delta.life && this.lives.has(lifeKey(scope, delta)))
            || this.names(references.ofRecord(scope, delta)))))
        || (entry.predict ?? []).some((delta) => delta.life !== undefined && this.lives.has(lifeKey(entry.scope, delta))));
    const guards = replaced ? (entry.intent.guard ?? []).filter((guard) => this.created.has(scopedKey(entry.scope, guard.t, guard.id))) : [];
    return { removed, cmdGone, guards, any: removed.length > 0 || cmdGone || guards.length > 0,
      whole: removed.length === deltas.length && (ownCommandOf(this.registry, entry) === undefined || cmdGone) };
  }

  // A dependent part joins the sources, so dependency is transitive through the records it creates.
  absorbPart(entry, { removed, cmdGone }) {
    this.absorb(entry.scope, removed, entry.stamp);
    if (cmdGone) for (const { scope, d } of predictionsOf(entry)) this.absorb(scope, d, entry.stamp);
  }
}

// Removes a queued entry's dependent part: the deltas, the guards on their records and those the part
// names, and a dependent command with its prediction. Answers the removed content, a snapshot; the entry
// may be left empty.
export function removeDependent(entry, { removed, cmdGone, guards = [] }) {
  const content = {};
  if (removed.length) content.d = structuredClone(removed);
  if (cmdGone) {
    content.cmd = structuredClone(entry.intent.cmd);
    if (entry.predictions) content.predictions = structuredClone(entry.predictions);
  }
  const kept = (entry.intent.d ?? []).filter((delta) => !removed.includes(delta));
  const removedKeys = new Set(removed.map((delta) => recordKey(delta.t, delta.id)));
  if (kept.length) entry.intent.d = kept;
  else delete entry.intent.d;
  if (entry.intent.guard) {
    entry.intent.guard = entry.intent.guard.filter((guard) => !removedKeys.has(recordKey(guard.t, guard.id)) && !guards.includes(guard));
    if (entry.intent.guard.length === 0) delete entry.intent.guard;
  }
  if (cmdGone) {
    delete entry.intent.cmd;
    delete entry.predict;
    delete entry.predictions;
    delete entry.acceptedEffects;
  }
  return content;
}

// An entry left with no delta and no command of its own: a fold that leaves it so ends it.
export function isEmpty(registry, entry) {
  return entry.intent.d === undefined && ownCommandOf(registry, entry) === undefined;
}

// The silent fold of an undo, a retire and a supersede (§7.3), planned before anything moves: `sources`
// are `[{entry, deltas}]`, each with the deltas it gives up, and the answer is each later entry's
// dependent part, `[{entry, part}]`. `replaced` says a replacement takes the sources' place. Sources are
// held or never sent, and §7.4 numbers no entry that depends on a held one, so a numbered dependent is a
// broken invariant.
export function silentFoldOf(replica, registry, sources, { replaced = false } = {}) {
  const dependents = new Dependents(registry);
  const parts = [];
  for (const entry of replica.entries()) {
    const source = sources.find((candidate) => candidate.entry === entry);
    if (source) {
      dependents.absorbEntry(entry, source.deltas);
      continue;
    }
    const part = dependents.of(entry, { replaced });
    if (!part.any) continue;
    if (entry.state !== 'held' && entry.state !== 'ready') throw new Error(`${entry.localId} is ${entry.state} and depends on a held entry`);
    dependents.absorbPart(entry, part);
    parts.push({ entry, part });
  }
  return parts;
}

// Applies a silent fold: no notice, and an entry left empty ends undone.
export function foldSilently(replica, registry, ended, parts) {
  for (const { entry, part } of parts) {
    removeDependent(entry, part);
    if (isEmpty(registry, entry)) moveEntry(replica, ended, entry, 'silent-fold');
  }
}
