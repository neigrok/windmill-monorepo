// The activity log — a chronological record of what happened to the tree: steps
// started, completed (and the unlocks those cause), added, renamed, removed.
// Pure domain (no React, no WebGL): the view records one event at each edit seam
// and reads back grouped or per-node slices. An event snapshots its object's
// label + kind at emit time, so a row still renders (struck through) after the
// node is deleted; while the node lives, surfaces resolve its current label from
// the tree instead of trusting the snapshot.

export const VERBS = ['started', 'completed', 'unlocked', 'added', 'renamed', 'removed'];

export class ActivityEvent {
  constructor({ id, actor, verb, nodeId, label, kind, at }) {
    this.id = id;
    this.actor = actor ?? null; // null → the tree itself (an unlock has no person)
    this.verb = verb;
    this.nodeId = nodeId ?? null;
    this.label = label ?? ''; // snapshot at emit — survives a later rename/delete
    this.kind = kind ?? null; // snapshot kind hue
    this.at = at; // epoch ms
  }
}

const DAY_MS = 86400000;
const SEED_GAP_MS = 2.6 * 60 * 60 * 1000; // spacing between historical completions

export class ActivityLog {
  constructor(events = []) {
    this.events = [...events]; // chronological, oldest first
  }

  record(event) {
    this.events.push(event);
    return event;
  }

  get size() {
    return this.events.length;
  }

  recent(limit = Infinity) {
    const start = Math.max(0, this.events.length - limit);
    return this.events.slice(start).reverse();
  }

  forNode(nodeId) {
    return this.events.filter((event) => event.nodeId === nodeId).reverse();
  }

  groupedByDay(now) {
    const groups = [];
    let current = null;
    for (const event of this.recent()) {
      const label = dayLabel(event.at, now);
      if (!current || current.label !== label) {
        current = { label, events: [] };
        groups.push(current);
      }
      current.events.push(event);
    }
    return groups;
  }

  // Seed the resting feed from the roadmap's real build history: one `completed`
  // event per already-complete node, in dependency order, spaced back from `now`
  // so the newest sit under Today and older ones fall to earlier days.
  static fromTree(tree, states, now) {
    const completed = tree.topoOrder().filter((id) => states.get(id) === 'complete');
    const log = new ActivityLog();
    completed.forEach((id, index) => {
      const node = tree.nodesById.get(id);
      log.record(new ActivityEvent({
        id: `seed-${id}`,
        actor: 'You',
        verb: 'completed',
        nodeId: id,
        label: node.label,
        kind: node.color,
        at: now - (completed.length - 1 - index) * SEED_GAP_MS,
      }));
    });
    return log;
  }
}

function dayLabel(at, now) {
  const startOfDay = (ms) => {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
