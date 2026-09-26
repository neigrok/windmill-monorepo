// §7.7 step 3 dependents: later deltas and commands that touch or name a record a source created, or
// that target a scope its governing record creates; by (scope, t, id), and transitive through absorb().
// The refusal fold (§7.7) and the create/delete cancel (§7.2) both use it.

import { recordKey } from '../core/rows.js';

function scopedKey(scope, t, id) {
  return `${scope}|${recordKey(t, id)}`;
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
  constructor(registry, scope, deltas) {
    this.registry = registry;
    this.created = new Set();
    this.governed = new Set();
    this.absorb(scope, deltas);
  }

  // The records these deltas create (a life made alive at its born) join the source's, with the scopes
  // their governing records create.
  absorb(scope, deltas) {
    for (const delta of deltas) {
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
      || refsOf(this.registry, delta).some((ref) => this.names(entry.scope, ref.t, ref.id)));
    const cmd = entry.intent.cmd;
    const cmdGone = cmd !== undefined
      && (this.governed.has(entry.scope) || commandRefs(this.registry, cmd).some((ref) => this.names(entry.scope, ref.t, ref.id)));
    return { removed, cmdGone, any: removed.length > 0 || cmdGone, whole: removed.length === deltas.length && (cmd === undefined || cmdGone) };
  }
}

// Removes a queued entry's dependent part: the deltas, the guards on their records, and a dependent
// command with its prediction. Answers the removed content; the entry may be left empty.
export function removeDependent(entry, { removed, cmdGone }) {
  const content = {};
  if (removed.length) content.d = removed;
  if (cmdGone) content.cmd = entry.intent.cmd;
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
