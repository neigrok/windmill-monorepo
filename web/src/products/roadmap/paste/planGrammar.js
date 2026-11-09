// The deterministic plan grammar: plain text in, a wire-ready subgraph out. The same text must
// always yield the same tree — node ids seed the ceremony jitter, so Date.now and random may never
// leak in here. Parsing can never fail; the worst case is one root and a pile of ¶ notes, and
// every liberty taken is visible in the gutter.

import { t } from '../i18n/index.js';

const PLAN_HUES = ['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum'];
const ROOT_LABEL_MAX = 200;
const KIND_LABEL_MAX = 24;
const EXPORT_MARKER = '<!-- windmill:roadmap -->';

// `bindOnly`: a heading matching no existing kind mints a fresh hue instead of relabeling one.
export function parsePlan(text, existingKinds = [], { bindOnly = false } = {}) {
  const lines = scanLines(text);
  const root = takeRoot(lines);
  const marker = lines.findIndex((line, at) => at > root.line && line.kind !== 'blank');
  root.exported = root.line >= 0 && lines[marker]?.content === EXPORT_MARKER;
  if (root.exported) {
    lines[marker].kind = 'blank';
    if (lines[root.line].kind === 'text' && root.title === '#') root.title = '';
  }
  const grove = growNodes(lines, root, existingKinds, bindOnly);
  return assemble(root, grove, lines);
}

// One record per raw line: indent columns (tab = 2), a kind — blank | heading | item | text — and
// the stripped content. The indent unit is the first indented line's width.
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
    line.ragged = line.cols % step !== 0; // off the document's indent grid
  }
  return lines;
}

// A leading `# Heading` or a first plain line is the root and the tree's name; a document opening
// with a list or a `##` has none, and missingRoot says so.
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

// The legend ledger for one parse: a heading matching an existing kind's label binds
// case-insensitively, else it relabels the next unclaimed kind, mints a free hue, then cycles.
class KindBook {
  constructor(existingKinds, bindOnly = false) {
    this.kinds = existingKinds.map((kind) => ({
      id: kind.id,
      hue: kind.hue,
      label: kind.label ?? '',
      description: kind.description ?? '',
      source: 'existing',
    }));
    this.claimed = new Set();
    this.overflow = 0;
    this.bindOnly = bindOnly; // never relabel an existing kind, only bind or mint
  }

  firstHue() {
    return this.kinds[0]?.hue ?? PLAN_HUES[0];
  }

  claim(heading, exportHue) {
    const label = heading.trim();
    const bound = this.kinds.find((kind) => kind.label !== '' && kind.label.trim().toLowerCase() === label.toLowerCase() && (!exportHue || kind.hue === exportHue));
    if (bound) {
      this.claimed.add(bound.id);
      return bound;
    }
    if (exportHue && this.bindOnly && this.kinds.some((kind) => kind.hue === exportHue)) return this.claim(heading);
    if (!this.bindOnly) {
      const starter = exportHue
        ? this.kinds.find((kind) => kind.hue === exportHue)
        : this.kinds.find((kind) => kind.source === 'existing' && !this.claimed.has(kind.id));
      if (starter) {
        starter.label = label.slice(0, KIND_LABEL_MAX);
        starter.description = '';
        starter.source = 'relabeled';
        this.claimed.add(starter.id);
        return starter;
      }
    }
    const taken = new Set(this.kinds.map((kind) => kind.hue));
    const hue = exportHue ?? PLAN_HUES.find((candidate) => !taken.has(candidate));
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

// Draft nodes carry an index-parent; `marks` is the gutter's raw material, one per line that spoke.
function growNodes(lines, root, existingKinds, bindOnly = false) {
  const book = new KindBook(existingKinds, bindOnly);
  const nodes = root.exported ? [] : [{ role: 'root', label: root.title, hue: book.firstHue(), parent: -1, checked: false, notes: [], links: [], line: root.line }];
  const marks = lines.map(() => null);
  if (root.line >= 0 && !root.exported) marks[root.line] = { node: 0, glyph: '◉', liberties: [] };

  let branch = root.exported ? -1 : 0;
  let hue = book.firstHue();
  const stack = []; // open steps, shallow → deep: { level, index, ordered, anchor }

  lines.forEach((line, at) => {
    if (at === root.line || line.kind === 'blank') return;

    // Export headings only switch kind; ordinary paste headings also open a branch.
    if (line.kind === 'heading') {
      const exportedKind = root.exported && line.content.match(/^(?:(.*?) )?<!-- windmill:kind (terracotta|olive|gold|brick|sky|plum) -->$/);
      if (exportedKind) {
        hue = exportedKind[1] ? book.claim(exportedKind[1], exportedKind[2]).hue : exportedKind[2];
      } else {
        hue = book.claim(line.content).hue;
      }
      if (root.exported) return;
      nodes.push({ role: 'branch', label: line.content, hue, parent: 0, checked: false, notes: [], links: [], line: at });
      branch = nodes.length - 1;
      stack.length = 0;
      marks[at] = { node: branch, glyph: '├', liberties: [] };
      return;
    }

    // Depth is dependency, numbers chain, bullets fan, [x] arrives done. A level jump past the
    // previous line clamps to the nearest real ancestor.
    if (line.kind === 'item') {
      const exportedKind = root.exported && line.content.match(/^(.*?) <!-- windmill:kind (terracotta|olive|gold|brick|sky|plum)(?: (.*?))? -->$/);
      if (exportedKind) {
        line.content = exportedKind[1];
        hue = exportedKind[3] ? book.claim(unescapeExportText(exportedKind[3]), exportedKind[2]).hue : exportedKind[2];
      }
      if (root.exported) line.content = unescapeExportText(line.content);
      const liberties = [];
      if (line.ragged) liberties.push({ type: 'clamp', detail: t('roadmap.paste.mixedIndentClamped') });
      let level = line.level;
      const ceiling = (stack.length > 0 ? stack[stack.length - 1].level : -1) + 1;
      if (level > ceiling) {
        level = ceiling;
        liberties.push({ type: 'clamp', detail: t('roadmap.paste.indentClamped') });
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

    // Anything else is a note on the nearest step; a bare URL becomes a link. Nothing is dropped.
    const nearest = nodes.length - 1;
    if (nearest < 0) return;
    if (/^https?:\/\/\S+$/.test(line.content)) nodes[nearest].links.push(line.content);
    else nodes[nearest].notes.push(line.content);
    marks[at] = { node: nearest, glyph: '¶', liberties: [{ type: 'note', detail: t('roadmap.paste.keptAsNote') }] };
  });

  return { nodes, marks, kinds: book.kinds };
}

// Ordinary pastes rename duplicate labels; exports retain them. IDs use a slug and occurrence
// counter, and parents become prerequisite arrays.
function assemble(root, grove, lines) {
  const labels = new Set();
  const ids = new Set();
  const named = grove.nodes.map((draft, index) => {
    let label = draft.label;
    if (!root.exported && label !== '' && labels.has(label)) {
      let n = 2;
      while (labels.has(`${label} (${n})`)) n += 1;
      label = `${label} (${n})`;
      grove.marks[draft.line]?.liberties.push({ type: 'rename', detail: t('roadmap.paste.renamedTo', { label }) });
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
    const node = { id, label, color: draft.hue, prerequisites: draft.parent < 0 ? [] : [named[draft.parent].id] };
    if (index === 0) node.icon = 'sparkles'; // the root wears the birth spark
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

function escapeExportText(text, comment = false) {
  return text.replace(comment ? /[&<>\r\n-]/g : /[&<>\r\n]/g, (character) => `&#${character.charCodeAt(0)};`);
}

function unescapeExportText(text) {
  return text.replace(/&#(38|60|62|13|10|45);/g, (_, code) => String.fromCharCode(Number(code)));
}

// Export list items preserve primary dependencies; extra prerequisites become `needs also` notes.
// Kind descriptions and link labels are not represented in Markdown.

// The app carries links as { url, label } objects; parsePlan produces bare url strings.
const linkUrl = (link) => (typeof link === 'string' ? link : link?.url ?? '');
export function serializePlan(treeData, kinds, progress) {
  const nodes = treeData.nodes ?? [];
  const title = treeData.title ?? '';
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const kindByHue = new Map((kinds ?? []).map((kind) => [kind.hue, kind]));
  const completed = completedNodeIds(treeData, progress);
  const out = [`# ${title}`, EXPORT_MARKER];
  const childrenOf = new Map();
  const roots = [];
  for (const node of nodes) {
    const parent = node.prerequisites[0];
    if (parent !== undefined && byId.has(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(node);
    } else {
      roots.push(node);
    }
  }

  let hue = null;
  const walk = (node, depth) => {
    const kind = kindByHue.get(node.color);
    const kindLabel = kind?.label ? ` ${escapeExportText(kind.label, true)}` : '';
    const kindMarker = node.color === hue ? '' : ` <!-- windmill:kind ${node.color}${kindLabel} -->`;
    hue = node.color;
    const box = completed.has(node.id) ? '[x] ' : '';
    out.push(`${'  '.repeat(depth)}- ${box}${escapeExportText(node.label)}${kindMarker}`);
    const noteIndent = '  '.repeat(depth + 1);
    if (node.description) for (const line of String(node.description).split('\n')) out.push(noteIndent + line);
    const also = node.prerequisites.filter((id, index) => index > 0 || !byId.has(id));
    if (also.length > 0) out.push(`${noteIndent}needs also: ${also.map((id) => byId.get(id)?.label ?? id).join(', ')}`);
    if (node.links) for (const link of node.links) { const url = linkUrl(link); if (url) out.push(noteIndent + url); }
    for (const child of childrenOf.get(node.id) ?? []) walk(child, depth + 1);
  };
  for (const node of roots) walk(node, 0);
  return out.join('\n');
}

// A live overlay wins; with none, the document's seed statuses answer.
function completedNodeIds(treeData, progress) {
  if (progress == null) return new Set((treeData.nodes ?? []).filter((node) => node.status === 'complete').map((node) => node.id));
  if (progress instanceof Set) return progress;
  if (Array.isArray(progress)) return new Set(progress);
  if (progress.completed) return progress.completed instanceof Set ? progress.completed : new Set(progress.completed);
  return new Set();
}
