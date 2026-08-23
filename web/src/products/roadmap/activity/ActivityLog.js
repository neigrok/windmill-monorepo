export class ActivityEvent {
  constructor({ id, actor, verb, nodeId, label, kind, at, summary }) {
    this.id = id;
    this.actor = actor ?? null; // null → the tree itself (an unlock has no person)
    this.verb = verb;
    this.nodeId = nodeId ?? null;
    this.label = label ?? ''; // snapshot at emit
    this.kind = kind ?? null; // snapshot kind hue
    this.at = at ?? null; // epoch ms; null = no stamp
    this.summary = summary ?? null; // server-composed sentence for structural verbs
  }
}

const DAY_MS = 86400000;

// Undated deeds first, then real instants ascending.
function chronological(a, b) {
  if (a.at == null && b.at == null) return 0;
  if (a.at == null) return -1;
  if (b.at == null) return 1;
  return a.at - b.at;
}

export class ActivityLog {
  constructor(events = []) {
    this.events = [...events].sort(chronological);
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

  static fromTree(tree, states, completedAt = {}) {
    const completed = tree.topoOrder().filter((id) => states.get(id) === 'complete');
    return new ActivityLog(completed.map((id) => {
      const node = tree.nodesById.get(id);
      return new ActivityEvent({
        id: `seed-${id}`,
        actor: 'You',
        verb: 'completed',
        nodeId: id,
        label: node.label,
        kind: node.color,
        at: completedAt[id] ?? null,
      });
    }));
  }
}

function dayLabel(at, now) {
  if (at == null) return 'Earlier';
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
