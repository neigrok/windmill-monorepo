// The journal's "your data" export. GET /v1/journal/export has been live on the backend since the
// product shipped and journalApi.exportAll() has been written against it since — with no caller, so
// nothing in the product could reach it. This is the caller.
//
// Roadmap's export is a zip because roadmap has many trees; the journal is ONE continuous canvas, so
// its archive is one continuous Markdown file, oldest first — the same shape the product is. The
// scales are written as the fractions they are ("mood 4/5"), never as words: the canvas grades
// nothing, and an export that translated a step into "good" would be the product saying something
// it has never said.

import { journalApi } from '../journalApi.js';
import { isWritten, normalizePage } from '../pageCache.js';

export function journalMarkdown(pages) {
  const written = pages.map(normalizePage).filter(isWritten).sort((a, b) => (a.day < b.day ? -1 : 1));
  const blocks = written.map((page) => {
    const scales = [];
    if (page.mood != null) scales.push(`mood ${page.mood}/5`);
    if (page.energy != null) scales.push(`energy ${page.energy}/3`);
    const lines = [`## ${page.day}`];
    if (scales.length) lines.push(`_${scales.join(' · ')}_`);
    if (page.body.trim()) lines.push(page.body.trim());
    return `${lines.join('\n\n')}\n`;
  });
  return `# Windmill journal\n\n${blocks.join('\n')}`;
}

export async function buildJournalArchive() {
  const pages = await journalApi.exportAll();
  const text = journalMarkdown(pages);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'windmill-journal.md';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { count: pages.filter((page) => isWritten(normalizePage(page))).length };
}
