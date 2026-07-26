// The share "score" — what makes a frame worth posting (X2 spec, note 5). Counts
// done vs. total steps and elects the tree's dominant kind: the most common kind
// among DONE nodes (ties resolve to terracotta, the brand hue). The dominant kind
// is the only place a frame takes color — it tints the rule, the title dot and the
// panel edge; everything else stays neutral so the family reads as one identity.

import { KIND_ORDER } from './palette.js';
import { DEFAULT_NODE_COLOR } from '../theme.js';

export class ShareStats {
  constructor({ done, total, dominantKind }) {
    this.done = done;
    this.total = total;
    this.dominantKind = dominantKind;
    this.percent = total === 0 ? 0 : Math.round((done / total) * 100);
    this.fraction = total === 0 ? 0 : done / total;
  }

  static from(tree, states) {
    const tally = new Map();
    let done = 0;
    for (const node of tree.nodes) {
      if (states.get(node.id) !== 'complete') continue;
      done += 1;
      const kind = node.color ?? DEFAULT_NODE_COLOR;
      tally.set(kind, (tally.get(kind) ?? 0) + 1);
    }
    return new ShareStats({ done, total: tree.nodes.length, dominantKind: ShareStats.dominant(tally) });
  }

  // A sole highest count wins its kind; a shared maximum (or no done nodes at
  // all) is a tie and falls to terracotta, the brand hue (spec S3).
  static dominant(tally) {
    let best = 0;
    for (const count of tally.values()) if (count > best) best = count;
    if (best === 0) return DEFAULT_NODE_COLOR;
    const leaders = KIND_ORDER.filter((kind) => (tally.get(kind) ?? 0) === best);
    return leaders.length === 1 ? leaders[0] : DEFAULT_NODE_COLOR;
  }
}
