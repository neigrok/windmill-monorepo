import { DEFAULT_NODE_COLOR } from '../theme.js';

export { kindOptions } from '../model/Legend.js';
export { gateOf } from '../model/UnlockRules.js';

const SNIPPET_PAD = 40; // characters kept either side of a description hit

// A section survives when its head or one of its rows match; it keeps its head either way. `matches`
// counts exactly what the body will render, the root included, so zero IS the empty state.
export function filterOutline(outline, nodesById, { query = '', kind = null, revealed = null } = {}) {
  const needle = query.trim().toLowerCase();
  const finder = needle === '' ? null : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const look = (id) => {
    const node = nodesById.get(id);
    if (!node) return null;
    if (kind && (node.color ?? DEFAULT_NODE_COLOR) !== kind) return null;
    if (!finder) return { snippet: null };
    if ((node.label ?? '').toLowerCase().includes(needle)) return { snippet: null };
    const description = node.description ?? '';
    const hit = finder.exec(description); // against the ORIGINAL — lowercasing is not length-preserving
    if (!hit) return null;
    const from = Math.max(0, hit.index - SNIPPET_PAD);
    const to = Math.min(description.length, hit.index + hit[0].length + SNIPPET_PAD);
    const cutBefore = description.slice(0, from).trim() !== '';
    const cutAfter = description.slice(to).trim() !== '';
    return { snippet: `${cutBefore ? '…' : ''}${description.slice(from, to).trim()}${cutAfter ? '…' : ''}` };
  };

  const rootHit = outline.rootId ? look(outline.rootId) : null;
  const sections = [];
  let matches = rootHit ? 1 : 0;
  for (const section of outline.sections) {
    const head = look(section.head);
    const matched = [];
    for (const row of section.rows) {
      const found = look(row.id);
      if (found) matched.push({ id: row.id, depth: row.depth, snippet: found.snippet });
    }
    if (!head && matched.length === 0) continue;
    matches += matched.length + (head ? 1 : 0);
    const snippets = new Map(matched.map((row) => [row.id, row.snippet]));
    const rows = revealed?.has(section.head)
      ? section.rows.map((row) => ({ id: row.id, depth: row.depth, snippet: snippets.get(row.id) ?? null }))
      : matched;
    sections.push({
      head: section.head,
      headMatches: !!head,
      headSnippet: head?.snippet ?? null,
      rows,
      hidden: section.rows.length - rows.length,
    });
  }
  return { root: rootHit ? { id: outline.rootId, snippet: rootHit.snippet } : null, sections, matches };
}
