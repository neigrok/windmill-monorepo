// The activity log — a chronological record of what happened to the tree: steps
// started, completed (and the unlocks those cause), added, renamed, removed.
// Pure domain (no React, no WebGL): the view records one event at each edit seam
// and reads back grouped or per-node slices. An event snapshots its object's
// label + kind at emit time, so a row still renders (struck through) after the
// node is deleted; while the node lives, surfaces resolve its current label from
// the tree instead of trusting the snapshot. An event's `at` is a real instant or
// null — a deed we hold no stamp for is undated ("Earlier", no relative time)
// rather than given a plausible-looking made-up one. The verbs themselves are enumerated
// once, in activity/grammar.jsx's VERB_STYLE — the one place that has to know them,
// because it is the one place that renders them.

export class ActivityEvent {
  constructor({ id, actor, verb, nodeId, label, kind, at, summary }) {
    this.id = id;
    this.actor = actor ?? null; // null → the tree itself (an unlock has no person)
    this.verb = verb;
    this.nodeId = nodeId ?? null;
    this.label = label ?? ''; // snapshot at emit — survives a later rename/delete
    this.kind = kind ?? null; // snapshot kind hue
    this.at = at ?? null; // epoch ms, or null when we hold no stamp for this deed
    this.summary = summary ?? null; // server-composed sentence for structural verbs
  }
}

const DAY_MS = 86400000;

// The one order every surface reads the log in: undated deeds are the oldest (we know
// they happened before anything we can date), then real instants ascending.
function chronological(a, b) {
  if (a.at == null && b.at == null) return 0;
  if (a.at == null) return -1;
  if (b.at == null) return 1;
  return a.at - b.at;
}

export class ActivityLog {
  constructor(events = []) {
    this.events = [...events].sort(chronological); // chronological, oldest first
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

  // Seed the resting feed from the roadmap's real build history: one `completed` event
  // per already-complete node, in dependency order, each carrying the instant this device
  // actually recorded the completion. A node completed before we kept stamps (or on another
  // device) has none, and stays undated — the feed says "Earlier", never a guess.
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
