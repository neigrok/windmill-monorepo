// paste-import (F3): the deterministic plan grammar — plain text in, a wire-ready
// subgraph out. Pure and dependency-free on purpose: the same module runs under bare
// node for the contract tests, and the same text always yields the same tree (node
// ids seed the ceremony jitter, so Date.now/random may never leak in here).
//
// The 8 rules (design canon guidelines/paste-import.md §03), as an ordered pipeline:
//   scan → root → branches → depth→dependency → chain-vs-fan → status → notes → assemble.
// Parsing can never fail — the worst case is one root and a pile of ¶ notes, still
// plantable. Every liberty taken (clamp, note, rename) is visible in the gutter.

const PLAN_HUES = ['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum'];
const ROOT_LABEL_MAX = 200;
const KIND_LABEL_MAX = 24;

export function parsePlan(text, existingKinds = []) {
  const lines = scanLines(text);
  const root = takeRoot(lines);
  const grove = growNodes(lines, root, existingKinds);
  return assemble(root, grove, lines);
}

// One record per raw line: indent columns (tab = 2), a kind — blank | heading | item |
// text — and the stripped content. The indent unit is the first indented line's width,
// so 2-space, 4-space and tabbed documents all level the same way.
function scanLines(text) {
  const raws = String(text ?? '').split(/\r\n|\r|\n/);
  let unit = 0;
  const lines = raws.map((raw) => {
    const body = raw.replace(/^[ \t]+/, '');
    let cols = 0;
    for (const ch of raw.slice(0, raw.length - body.length)) cols += ch === '\t' ? 2 : 1;
    if (body.trim() === '') return { cols, kind: 'blank', content: '' };
    const heading = body.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (heading) return { cols, kind: 'heading', depth: heading[1].length, content: heading[2] };
    const item = body.match(/^([-*•]|\d+[.)])\s+(.*)$/);
    if (!item) {
      if (unit === 0 && cols > 0) unit = cols;
      return { cols, kind: 'text', content: body.trim() };
    }
    if (unit === 0 && cols > 0) unit = cols;
    const box = item[2].match(/^\[([ xX])\]\s*(.*)$/);
    return {
      cols,
      kind: 'item',
      ordered: /^\d/.test(item[1]),
      checked: box ? box[1] !== ' ' : false,
      content: (box ? box[2] : item[2]).trim(),
    };
  });
  const step = unit || 2;
  for (const line of lines) {
    line.level = Math.floor(line.cols / step);
    line.ragged = line.cols % step !== 0; // off the document's indent grid — flooring it is a liberty
  }
  return lines;
}

// Rule 1 — a leading `# Heading` or a first plain line is the root and the tree's
// name (clipped to 200). A document that opens with a list or a `##` has no name:
// the composer asks for one word, nothing else.
function takeRoot(lines) {
  const at = lines.findIndex((line) => line.kind !== 'blank');
  if (at === -1) return { title: '', missingRoot: true, line: -1 };
  const first = lines[at];
  if (first.kind === 'heading' && first.depth === 1) {
    return { title: first.content.slice(0, ROOT_LABEL_MAX), missingRoot: false, line: at };
  }
  if (first.kind === 'text') {
    return { title: first.content.slice(0, ROOT_LABEL_MAX), missingRoot: false, line: at };
  }
  return { title: '', missingRoot: true, line: -1 };
}

// The legend ledger for one parse (rule 6): a heading matching an existing kind's
// label binds (case-insensitive); otherwise it takes the next unclaimed existing kind
// in order and relabels it; then it mints free hues; past six it cycles — all
// deterministic, so the same text always paints the same legend.
class KindBook {
  constructor(existingKinds) {
    this.kinds = existingKinds.map((kind) => ({
      id: kind.id,
      hue: kind.hue,
      label: kind.label ?? '',
      description: kind.description ?? '',
      source: 'existing',
    }));
    this.claimed = new Set();
    this.overflow = 0;
  }

  firstHue() {
    return this.kinds[0]?.hue ?? PLAN_HUES[0];
  }

  claim(heading) {
    const label = heading.trim();
    const bound = this.kinds.find((kind) => kind.label !== '' && kind.label.trim().toLowerCase() === label.toLowerCase());
    if (bound) {
      this.claimed.add(bound.id);
      return bound;
    }
    const starter = this.kinds.find((kind) => kind.source === 'existing' && !this.claimed.has(kind.id));
    if (starter) {
      starter.label = label.slice(0, KIND_LABEL_MAX);
      starter.description = '';
      starter.source = 'relabeled';
      this.claimed.add(starter.id);
      return starter;
    }
    const taken = new Set(this.kinds.map((kind) => kind.hue));
    const hue = PLAN_HUES.find((candidate) => !taken.has(candidate));
    if (hue) {
      const minted = { id: this.mintId(label), hue, label: label.slice(0, KIND_LABEL_MAX), description: '', source: 'added' };
      this.kinds.push(minted);
      this.claimed.add(minted.id);
      return minted;
    }
    const reused = this.kinds[this.overflow % this.kinds.length];
    this.overflow += 1;
    return reused;
  }

  mintId(label) {
    const base = slug(label) || 'kind';
    if (!this.kinds.some((kind) => kind.id === base)) return base;
    let n = 2;
    while (this.kinds.some((kind) => kind.id === `${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }
}

// Rules 2–7 in one ordered walk. Draft nodes carry an index-parent; `marks` is the
// gutter's raw material, one per line that spoke.
function growNodes(lines, root, existingKinds) {
  const book = new KindBook(existingKinds);
  const nodes = [{ role: 'root', label: root.title, hue: book.firstHue(), parent: -1, checked: false, notes: [], links: [], line: root.line }];
  const marks = lines.map(() => null);
  if (root.line >= 0) marks[root.line] = { node: 0, glyph: '◉', liberties: [] };

  let branch = 0; // the index steps fall back to — the root until a heading opens a branch
  let hue = nodes[0].hue;
  const stack = []; // open steps, shallow → deep: { level, index, ordered, anchor }

  lines.forEach((line, at) => {
    if (at === root.line || line.kind === 'blank') return;

    // Rule 6 — a branch heading: claim a kind, reset the indent world under it.
    if (line.kind === 'heading') {
      hue = book.claim(line.content).hue;
      nodes.push({ role: 'branch', label: line.content, hue, parent: 0, checked: false, notes: [], links: [], line: at });
      branch = nodes.length - 1;
      stack.length = 0;
      marks[at] = { node: branch, glyph: '├', liberties: [] };
      return;
    }

    // Rules 2/3/4/5/8 — depth is dependency; numbers chain, bullets fan; [x] arrives
    // done; a level jump past the previous line clamps to the nearest real ancestor,
    // and an indent off the document's grid flattens just as visibly.
    if (line.kind === 'item') {
      const liberties = [];
      if (line.ragged) liberties.push({ type: 'clamp', detail: 'mixed indent clamped' });
      let level = line.level;
      const ceiling = (stack.length > 0 ? stack[stack.length - 1].level : -1) + 1;
      if (level > ceiling) {
        level = ceiling;
        liberties.push({ type: 'clamp', detail: 'indent clamped' });
      }
      let sibling = null;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        const popped = stack.pop();
        if (popped.level === level) sibling = popped;
      }
      const anchor = stack.length > 0 ? stack[stack.length - 1].index : branch;
      const chains = line.ordered && sibling !== null && sibling.ordered && sibling.anchor === anchor;
      nodes.push({ role: 'step', label: line.content, hue, parent: chains ? sibling.index : anchor, checked: line.checked, notes: [], links: [], line: at });
      stack.push({ level, index: nodes.length - 1, ordered: line.ordered, anchor });
      marks[at] = { node: nodes.length - 1, glyph: line.checked ? '✓' : '·', liberties };
      return;
    }

    // Rule 7 — anything else is a note on the nearest step; a bare URL becomes a link.
    // Nothing is ever dropped.
    const nearest = nodes.length - 1;
    if (/^https?:\/\/\S+$/.test(line.content)) nodes[nearest].links.push(line.content);
    else nodes[nearest].notes.push(line.content);
    marks[at] = { node: nearest, glyph: '¶', liberties: [{ type: 'note', detail: 'kept as a note' }] };
  });

  return { nodes, marks, kinds: book.kinds };
}

// Rule 8 and the wire shape: duplicate labels get " (2)" exhaustively, ids are
// slug + occurrence counter (never time, never random), parents become prerequisite
// arrays, and the gutter/readout/imperfections are laid down line-for-line.
function assemble(root, grove, lines) {
  const labels = new Set();
  const ids = new Set();
  const named = grove.nodes.map((draft, index) => {
    let label = draft.label;
    if (label !== '' && labels.has(label)) {
      let n = 2;
      while (labels.has(`${label} (${n})`)) n += 1;
      label = `${label} (${n})`;
      grove.marks[draft.line]?.liberties.push({ type: 'rename', detail: `renamed to "${label}"` });
    }
    if (label !== '') labels.add(label);
    const base = slug(label) || (index === 0 ? 'root' : 'step');
    let id = base;
    if (ids.has(id)) {
      let n = 2;
      while (ids.has(`${base}-${n}`)) n += 1;
      id = `${base}-${n}`;
    }
    ids.add(id);
    return { draft, id, label };
  });

  const nodes = named.map(({ draft, id, label }, index) => {
    const node = { id, label, color: draft.hue, prerequisites: index === 0 ? [] : [named[draft.parent].id] };
    if (index === 0) node.icon = 'sparkles'; // the root wears the birth spark, exactly like a hand-planted bud
    if (draft.checked) node.status = 'complete';
    if (draft.notes.length > 0) node.description = draft.notes.join('\n');
    if (draft.links.length > 0) node.links = [...draft.links];
    return node;
  });

  const gutter = lines.map((line, at) => {
    const mark = grove.marks[at];
    if (!mark) return { glyph: null, nodeId: null, liberty: null };
    return {
      glyph: mark.glyph,
      nodeId: nodes[mark.node].id,
      liberty: mark.liberties.length > 0 ? mark.liberties.map((liberty) => liberty.detail).join(' · ') : null,
    };
  });

  const imperfections = [];
  grove.marks.forEach((mark, at) => {
    if (!mark) return;
    for (const liberty of mark.liberties) imperfections.push({ line: at, type: liberty.type, detail: liberty.detail });
  });

  const readout = {
    steps: nodes.length,
    branches: grove.nodes.filter((draft) => draft.role === 'branch').length,
    done: nodes.filter((node) => node.status === 'complete').length,
  };

  const kinds = grove.kinds.map((kind) => ({
    id: kind.id,
    hue: kind.hue,
    label: kind.label,
    description: kind.description,
    source: kind.source,
  }));

  return { title: root.title, missingRoot: root.missingRoot, nodes, kinds, gutter, readout, imperfections };
}

function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

// serializePlan (F3, the inverse) — a TreeData back into plan-grammar markdown, the
// packing side of the settings "export your data" feature. It is BEST-EFFORT by
// construction, because the grammar it targets is strictly single-parent and colours a
// node by its enclosing `## section`, never per node. A general DAG therefore cannot
// round-trip, and the losses are deliberate and named:
//   • prerequisites[0] becomes the indent parent; every EXTRA prerequisite — and a
//     primary parent in another colour section that can't be indented under — is kept
//     as a `needs also: <label>, …` note. That note reparses harmlessly into the
//     node's description: a cross/multi edge preserved as prose, not as an edge.
//   • nodes are grouped by colour under `## <kind label>` headings, so kind
//     DESCRIPTIONS are lost on re-parse — parsePlan blanks a relabelled/added kind's
//     description (source 'relabeled'/'added' carry description '').
// What survives exactly: labels, single-parent prerequisite shape, node colours, and
// completion marks. Completion follows the app's own rule (HttpTreeRepository.loadProgress):
// the live per-user `progress` overlay wins when supplied; otherwise the document's own
// `status: 'complete'` seed answers.
//   • a link's label is NOT preserved: the grammar's only link syntax is a bare URL line
//     (parsePlan's URL rule is `^https?://\S+$`), so export emits the url and drops the label.

// The app carries links as { url, label } objects; parsePlan produces bare url strings.
// Normalize to the url string so a link never stringifies to "[object Object]" in the export.
const linkUrl = (link) => (typeof link === 'string' ? link : link?.url ?? '');
export function serializePlan(treeData, kinds, progress) {
  const nodes = treeData.nodes ?? [];
  const title = treeData.title ?? '';
  if (nodes.length === 0) return `# ${title}`;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const kindByHue = new Map((kinds ?? []).map((kind) => [kind.hue, kind]));
  const completed = completedNodeIds(treeData, progress);
  const root = nodes.find((node) => node.prerequisites.length === 0) ?? nodes[0];

  // Partition the non-root nodes by colour, in first-appearance order — each colour is
  // one `## section`, except the root's own colour, which stays loose (emitted under the
  // root before any heading) unless a branch node names it. This mirrors the grammar,
  // where pre-heading steps hang off the root and every heading owns exactly one colour.
  const order = [];
  const byColor = new Map();
  for (const node of nodes) {
    if (node === root) continue;
    if (!byColor.has(node.color)) { byColor.set(node.color, []); order.push(node.color); }
    byColor.get(node.color).push(node);
  }

  const branchNode = (color) => {
    const kind = kindByHue.get(color);
    if (!kind) return null;
    return (byColor.get(color) ?? []).find((node) => node.prerequisites[0] === root.id && node.label === kind.label) ?? null;
  };
  const looseColor = byColor.has(root.color) && branchNode(root.color) === null ? root.color : null;

  const out = [`# ${title}`];
  if (root.description) for (const line of String(root.description).split('\n')) out.push(line);
  if (root.links) for (const link of root.links) { const url = linkUrl(link); if (url) out.push(url); }

  if (looseColor !== null) renderForest(byColor.get(looseColor), root.id, completed, byId, out);

  for (const color of order) {
    if (color === looseColor) continue;
    const heading = branchNode(color);
    const kind = kindByHue.get(color);
    out.push(`## ${heading ? heading.label : kind ? kind.label : color}`);
    const content = heading ? byColor.get(color).filter((node) => node !== heading) : byColor.get(color);
    renderForest(content, heading ? heading.id : null, completed, byId, out);
  }

  return out.join('\n');
}

// The app's honest completion source: a live `progress` overlay (a Set, an array, or a
// Progress `{ completed }`) wins outright; with none, the document's seed statuses answer.
function completedNodeIds(treeData, progress) {
  if (progress == null) return new Set(treeData.nodes.filter((node) => node.status === 'complete').map((node) => node.id));
  if (progress instanceof Set) return progress;
  if (Array.isArray(progress)) return new Set(progress);
  if (progress.completed) return progress.completed instanceof Set ? progress.completed : new Set(progress.completed);
  return new Set();
}

// Emit one colour section as nested list items: prerequisites[0] is the indent parent
// when it lives in this same section, otherwise the node sits at the top (its container —
// the branch node or the root — becomes its reparsed parent). Notes ride under each step:
// its description, then the `needs also` line for the edges indentation can't carry, then
// bare-URL links.
function renderForest(content, containerId, completed, byId, out) {
  const contentIds = new Set(content.map((node) => node.id));
  const childrenOf = new Map();
  const roots = [];
  for (const node of content) {
    const parent = node.prerequisites[0];
    if (parent !== undefined && contentIds.has(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(node);
    } else {
      roots.push(node);
    }
  }

  const walk = (node, depth) => {
    const box = completed.has(node.id) ? '[x] ' : '';
    out.push(`${'  '.repeat(depth)}- ${box}${node.label}`);
    const noteIndent = '  '.repeat(depth + 1);
    if (node.description) for (const line of String(node.description).split('\n')) out.push(noteIndent + line);
    const also = strandedPrereqs(node, contentIds, containerId, byId);
    if (also) out.push(noteIndent + also);
    if (node.links) for (const link of node.links) { const url = linkUrl(link); if (url) out.push(noteIndent + url); }
    for (const child of childrenOf.get(node.id) ?? []) walk(child, depth + 1);
  };
  for (const node of roots) walk(node, 0);
}

// The crux of the lossiness: every prerequisite that indentation can't express — the
// extras beyond the first, and a primary parent that lives outside this section — kept as
// a plain note that reparses into the description rather than vanishing.
function strandedPrereqs(node, contentIds, containerId, byId) {
  const stranded = node.prerequisites.filter((id, index) => !(index === 0 && (contentIds.has(id) || id === containerId)));
  if (stranded.length === 0) return null;
  return `needs also: ${stranded.map((id) => byId.get(id)?.label ?? id).join(', ')}`;
}
