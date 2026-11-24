// The deterministic plan grammar: plain text in, a wire-ready subgraph out. The same text must
// always yield the same tree — node ids seed the ceremony jitter, so Date.now and random may never
// leak in here. Parsing can never fail; the worst case is one root and a pile of notes, and every
// liberty taken is a value in the gutter. packages/api-contract/roadmap/plan/ holds its cases.

const PLAN_HUES = ['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum'];
// The domain's bounds, in its unit: characters, each a Unicode scalar value.
const BOUNDS = Object.freeze({ title: 200, label: 200, kindLabel: 24, description: 16000, link: 2048, links: 32 });
const ID_MAX = 40;
// A file the grammar wrote, of the first edition (notes and links as they are) or the second (notes quoted, links in
// angle brackets, the name and every text escaped where the read would take it for something else).
const MARKERS = Object.freeze({ '<!-- windmill:roadmap -->': 1, '<!-- windmill:roadmap 2 -->': 2 });
const EDITION = 2;
// An export carries the tree's guide as a quote between these two lines; a replant plants steps, so it reads past them.
const GUIDE_OPEN = '<!-- windmill:guide -->';
const GUIDE_CLOSE = '<!-- /windmill:guide -->';
const KIND_MARKER = /^(?:(.*?) )??<!-- windmill:kind (terracotta|olive|gold|brick|sky|plum)(?: (.*?))? -->$/;
// The domain kit's whitespace (§4.3), which ECMAScript's `\s` is, one character at a time.
const WHITESPACE = [0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
// The characters a file writes as entities, `&#` and the decimal and `;`, and the read reads back: `&`, `<`, `>`, `-`,
// `[` and the whitespace. No other entity is read.
const ENTITY = new RegExp(`&#(${[0x26, 0x3c, 0x3e, 0x2d, 0x5b, ...WHITESPACE].join('|')});`, 'g');

// `bindOnly`: a heading matching no existing kind mints a fresh hue instead of relabeling one.
export function parsePlan(text, existingKinds = [], { bindOnly = false } = {}) {
  const lines = scanLines(String(text ?? '').replaceAll('\u0000', ''));
  const root = takeRoot(lines);
  const marker = lines.findIndex((line, at) => at > root.line && line.kind !== 'blank');
  root.edition = root.line >= 0 ? MARKERS[lines[marker]?.content] ?? 0 : 0;
  if (root.edition > 0) {
    lines[marker].kind = 'blank';
    const named = lines[root.line];
    if (named.kind === 'text' && named.content === '#') root.title = '';
    else if (root.edition >= 2) root.title = clip(unescapeExportText(named.content), BOUNDS.title);
    const opening = lines.findIndex((line, at) => at > marker && line.kind !== 'blank');
    const closing = lines.findIndex((line, at) => at > opening && line.content === GUIDE_CLOSE);
    if (lines[opening]?.content === GUIDE_OPEN && closing !== -1) {
      for (let at = opening; at <= closing; at += 1) lines[at].kind = 'blank';
    }
  }
  const grove = growNodes(lines, root, existingKinds, bindOnly);
  return assemble(root, grove);
}

// The roadmap New Roadmap plants from a parse: a typed name names it, and the node that stands for the name where one
// does; with none typed, the plan's own name stands; with neither, null.
export function plantedRoadmap(parse, typedName) {
  const kinds = parse.kinds.map(({ id, hue, label, description }) => ({ id, hue, label, description }));
  const title = clip(typedName.replaceAll('\u0000', '').trim(), BOUNDS.title);
  if (title === '' && parse.missingRoot) return null;
  if (title === '') return { title: parse.title, nodes: parse.nodes, kinds };
  const standsForName = parse.missingRoot || parse.gutter.some((entry) => entry.mark === 'root');
  const named = standsForName ? parse.nodes.map((node, index) => (index === 0 ? { ...node, label: title } : node)) : parse.nodes;
  return { title, nodes: named, kinds };
}

// One record per raw line: indent columns (tab = 2), a kind — blank | heading | item | text — the
// stripped content, and the body as it stands. The indent unit is the first indented line's width.
function scanLines(text) {
  const raws = text.split(/\r\n|\r|\n/);
  let unit = 0;
  const lines = raws.map((raw) => {
    const body = raw.replace(/^[ \t]+/, '');
    let cols = 0;
    for (const ch of raw.slice(0, raw.length - body.length)) cols += ch === '\t' ? 2 : 1;
    if (body.trim() === '') return { cols, kind: 'blank', content: '', body };
    const heading = body.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (heading) return { cols, kind: 'heading', depth: heading[1].length, content: heading[2], body };
    const item = body.match(/^([-*•]|\d+[.)])\s+(.*)$/);
    if (!item) {
      if (unit === 0 && cols > 0) unit = cols;
      return { cols, kind: 'text', content: body.trim(), body };
    }
    if (unit === 0 && cols > 0) unit = cols;
    const box = item[2].match(/^\[([ xX])\]\s*(.*)$/);
    return {
      cols,
      kind: 'item',
      ordered: /^\d/.test(item[1]),
      checked: box ? box[1] !== ' ' : false,
      content: (box ? box[2] : item[2]).trim(),
      body,
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
  if ((first.kind === 'heading' && first.depth === 1) || first.kind === 'text') {
    return { title: clip(first.content, BOUNDS.title), missingRoot: false, line: at };
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

  // `label` as it stands: a heading's is trimmed already, and a file's marker keeps the padding its kind was written with.
  claim(label, exportHue) {
    const bound = this.kinds.find((kind) => kind.label !== '' && kind.label.trim().toLowerCase() === label.trim().toLowerCase() && (!exportHue || kind.hue === exportHue));
    if (bound) {
      this.claimed.add(bound.id);
      return bound;
    }
    if (exportHue && this.bindOnly && this.kinds.some((kind) => kind.hue === exportHue)) return this.claim(label);
    if (!this.bindOnly) {
      const starter = exportHue
        ? this.kinds.find((kind) => kind.hue === exportHue)
        : this.kinds.find((kind) => kind.source === 'existing' && !this.claimed.has(kind.id));
      if (starter) {
        starter.label = clip(label, BOUNDS.kindLabel);
        starter.description = '';
        starter.source = 'relabeled';
        this.claimed.add(starter.id);
        return starter;
      }
    }
    const taken = new Set(this.kinds.map((kind) => kind.hue));
    const hue = exportHue ?? PLAN_HUES.find((candidate) => !taken.has(candidate));
    if (hue) {
      const minted = { id: this.mintId(label), hue, label: clip(label, BOUNDS.kindLabel), description: '', source: 'added' };
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

// What a text line under a node gives it: a note, or an address that is one of its links. A file of the second edition
// writes a note as a quote and a link between angle brackets, each with its entities, so neither reads as anything else.
function noteOf(line, edition) {
  if (edition >= 2 && line.body.startsWith('>')) return { note: unescapeExportText(line.body.replace(/^> ?/, '')) };
  const bracketed = edition >= 2 && line.content.match(/^<([^\s<>]+)>$/);
  if (bracketed) return { link: unescapeExportText(bracketed[1]) };
  if (/^https?:\/\/\S+$/.test(line.content)) return { link: line.content };
  return { note: line.content };
}

// Draft nodes carry an index-parent; `marks` is the gutter's raw material, one per line that spoke.
function growNodes(lines, root, existingKinds, bindOnly = false) {
  const exported = root.edition > 0;
  const book = new KindBook(existingKinds, bindOnly);
  const nodes = exported ? [] : [{ role: 'root', label: root.title, hue: book.firstHue(), parent: -1, checked: false, notes: [], links: [], line: root.line }];
  const marks = lines.map(() => null);
  if (root.line >= 0 && !exported) marks[root.line] = { node: 0, mark: 'root', liberties: [] };
  // In a file the grammar wrote, the text before its first step, which the first step takes.
  const loose = [];

  let branch = exported ? -1 : 0;
  let hue = book.firstHue();
  const stack = []; // open steps, shallow → deep: { level, index, ordered, anchor }

  const takeText = (index, line, at) => {
    const node = nodes[index];
    const { note, link } = noteOf(line, root.edition);
    if (link !== undefined && node.links.length < BOUNDS.links && [...link].length <= BOUNDS.link) node.links.push(link);
    else node.notes.push({ text: note ?? link, line: at });
    marks[at] = { node: index, mark: 'note', liberties: [{ type: 'note' }] };
  };

  lines.forEach((line, at) => {
    if (at === root.line || line.kind === 'blank') return;

    // Export headings only switch kind; ordinary paste headings also open a branch.
    if (line.kind === 'heading') {
      const exportedKind = exported && line.content.match(/^(?:(.*?) )?<!-- windmill:kind (terracotta|olive|gold|brick|sky|plum) -->$/);
      if (exportedKind) {
        hue = exportedKind[1] ? book.claim(exportedKind[1].trim(), exportedKind[2]).hue : exportedKind[2];
      } else {
        hue = book.claim(line.content).hue;
      }
      if (exported) return;
      const label = clip(line.content, BOUNDS.label);
      nodes.push({ role: 'branch', label, hue, parent: 0, checked: false, notes: [], links: [], line: at });
      branch = nodes.length - 1;
      stack.length = 0;
      marks[at] = { node: branch, mark: 'branch', liberties: label === line.content ? [] : [{ type: 'clip' }] };
      return;
    }

    // Depth is dependency, numbers chain, bullets fan, [x] arrives done. A level jump past the
    // previous line clamps to the nearest real ancestor.
    if (line.kind === 'item') {
      let name = line.content;
      const exportedKind = exported && name.match(KIND_MARKER);
      if (exportedKind) {
        name = exportedKind[1] ?? '';
        hue = exportedKind[3] ? book.claim(unescapeExportText(exportedKind[3]), exportedKind[2]).hue : exportedKind[2];
      }
      if (exported) name = unescapeExportText(name);
      const label = clip(name, BOUNDS.label);
      const liberties = [];
      if (line.ragged) liberties.push({ type: 'clamp', indent: 'ragged' });
      let level = line.level;
      const ceiling = (stack.length > 0 ? stack[stack.length - 1].level : -1) + 1;
      if (level > ceiling) {
        level = ceiling;
        liberties.push({ type: 'clamp', indent: 'jump' });
      }
      if (label !== name) liberties.push({ type: 'clip' });
      let sibling = null;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        const popped = stack.pop();
        if (popped.level === level) sibling = popped;
      }
      const anchor = stack.length > 0 ? stack[stack.length - 1].index : branch;
      const chains = line.ordered && sibling !== null && sibling.ordered && sibling.anchor === anchor;
      nodes.push({ role: 'step', label, hue, parent: chains ? sibling.index : anchor, checked: line.checked, notes: [], links: [], line: at });
      stack.push({ level, index: nodes.length - 1, ordered: line.ordered, anchor });
      marks[at] = { node: nodes.length - 1, mark: line.checked ? 'done' : 'step', liberties };
      for (const held of loose.splice(0)) takeText(nodes.length - 1, held.line, held.at);
      return;
    }

    // Anything else is a note on the node made last, a bare URL a link; an export's text before its first step waits for
    // that step.
    if (nodes.length === 0) loose.push({ line, at });
    else takeText(nodes.length - 1, line, at);
  });

  // An export whose text has no step after it: one unnamed step takes the text.
  if (loose.length > 0) {
    nodes.push({ role: 'step', label: '', hue, parent: -1, checked: false, notes: [], links: [], line: -1 });
    for (const held of loose) takeText(0, held.line, held.at);
  }

  return { nodes, marks, kinds: book.kinds };
}

// Ordinary pastes rename duplicate labels; exports retain them. IDs use a slug and occurrence
// counter, and parents become prerequisite arrays. A description keeps what fits its bound, and every note line it
// does not keep whole says so.
function assemble(root, grove) {
  const exported = root.edition > 0;
  const labels = new Set();
  const ids = new Set();
  const named = grove.nodes.map((draft, index) => {
    let label = draft.label;
    if (!exported && label !== '' && labels.has(label)) {
      let n = 2;
      while (labels.has(renamed(label, n))) n += 1;
      label = renamed(label, n);
      grove.marks[draft.line]?.liberties.push({ type: 'rename', label });
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
    if (draft.notes.length > 0) {
      node.description = clip(draft.notes.map((note) => note.text).join('\n'), BOUNDS.description);
      let end = -1;
      for (const note of draft.notes) {
        end += 1 + [...note.text].length;
        if (end > BOUNDS.description) grove.marks[note.line].liberties.push({ type: 'clip' });
      }
    }
    if (draft.links.length > 0) node.links = [...draft.links];
    return node;
  });

  const gutter = grove.marks.map((spoken) => (spoken
    ? { mark: spoken.mark, nodeId: nodes[spoken.node].id, liberties: spoken.liberties }
    : { mark: null, nodeId: null, liberties: [] }));

  const liberties = gutter.flatMap((entry) => entry.liberties);
  const imperfections = {
    notes: liberties.filter((liberty) => liberty.type === 'note').length,
    clamps: liberties.filter((liberty) => liberty.type === 'clamp').length,
    renames: liberties.filter((liberty) => liberty.type === 'rename').length,
    clips: liberties.filter((liberty) => liberty.type === 'clip').length,
  };

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

// A label renamed `label (n)`, keeping as much of it as leaves the count room within its bound.
function renamed(label, n) {
  const suffix = ` (${n})`;
  return `${clip(label, BOUNDS.label - suffix.length)}${suffix}`;
}

function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, ID_MAX).replace(/-+$/, '');
}

// At most `max` characters, each a Unicode scalar value, as the domain counts them.
function clip(text, max) {
  const characters = [...text];
  return characters.length <= max ? text : characters.slice(0, max).join('');
}

// A name or a kind's label as a file writes it, so the read takes it back whole: `&`, `<`, `>`, line breaks and the two
// separators that would end its line as entities, `[` where it would begin a checkbox, whitespace at either end, which a
// read trims, and in a kind's label `-`, which could close its marker.
function escapeName(text, kind = false) {
  const characters = [...text];
  const blank = (character) => /^\s$/.test(character);
  let start = 0;
  while (start < characters.length && blank(characters[start])) start += 1;
  let end = characters.length;
  while (end > start && blank(characters[end - 1])) end -= 1;
  const inside = kind ? /[&<>\r\n\u2028\u2029-]/ : /[&<>\r\n\u2028\u2029]/;
  return characters.map((character, at) => {
    const entity = `&#${character.codePointAt(0)};`;
    if (at < start || at >= end || inside.test(character)) return entity;
    if (at === start && character === '[') return entity;
    return character;
  }).join('');
}

// A line of a description, or the note of the steps a step also follows, as a quote: `&` and line breaks as entities.
function quoted(text) {
  const escaped = text.replace(/[&\r\n]/g, (character) => `&#${character.charCodeAt(0)};`);
  return escaped === '' ? '>' : `> ${escaped}`;
}

// A link's address between angle brackets: `&`, the brackets and whitespace as entities.
function bracketed(url) {
  return `<${[...url].map((character) => (/[&<>\s]/.test(character) ? `&#${character.codePointAt(0)};` : character)).join('')}>`;
}

function unescapeExportText(text) {
  return text.replace(ENTITY, (_, code) => String.fromCodePoint(Number(code)));
}

// The app carries links as { url, label } objects; parsePlan produces bare url strings.
const linkUrl = (link) => (typeof link === 'string' ? link : link?.url ?? '');

// A roadmap as a file of the grammar's second edition, which reads back to the same steps, links, kinds and marks.
// Each step stands under the first step it follows, the rest named in a note, and a step no first step reaches, as on a
// loop, is written after them as a first step of its own. Kind descriptions and link labels are not written.
export function serializePlan(treeData, kinds, progress) {
  const nodes = treeData.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const kindByHue = new Map((kinds ?? []).map((kind) => [kind.hue, kind]));
  const completed = completedNodeIds(treeData, progress);
  const out = [`# ${escapeName(treeData.title ?? '')}`, Object.keys(MARKERS).find((marker) => MARKERS[marker] === EDITION)];
  if (/\S/.test(treeData.guide ?? '')) {
    out.push(GUIDE_OPEN, ...treeData.guide.split(/\r\n|\r|\n/).map((line) => (line ? `> ${line}` : '>')), GUIDE_CLOSE);
  }
  const childrenOf = new Map();
  for (const node of nodes) {
    const parent = node.prerequisites[0];
    if (parent === undefined || !byId.has(parent)) continue;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(node);
  }

  const written = new Set();
  let hue = null;
  const walk = (node, depth, under) => {
    written.add(node.id);
    const kind = kindByHue.get(node.color);
    const kindLabel = kind?.label ? ` ${escapeName(kind.label, true)}` : '';
    const kindMarker = node.color === hue ? '' : ` <!-- windmill:kind ${node.color}${kindLabel} -->`;
    hue = node.color;
    const box = completed.has(node.id) ? '[x] ' : '';
    out.push(`${'  '.repeat(depth)}- ${box}${escapeName(node.label)}${kindMarker}`);
    const noteIndent = '  '.repeat(depth + 1);
    if (node.description) for (const line of String(node.description).split('\n')) out.push(noteIndent + quoted(line));
    const also = node.prerequisites.filter((id, index) => index > 0 || id !== under);
    if (also.length > 0) out.push(noteIndent + quoted(`needs also: ${also.map((id) => byId.get(id)?.label ?? id).join(', ')}`));
    for (const link of node.links ?? []) { const url = linkUrl(link); if (url) out.push(noteIndent + bracketed(url)); }
    for (const child of childrenOf.get(node.id) ?? []) if (!written.has(child.id)) walk(child, depth + 1, node.id);
  };
  for (const node of nodes) if (!byId.has(node.prerequisites[0])) walk(node, 0, null);
  for (const node of nodes) if (!written.has(node.id)) walk(node, 0, null);
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
