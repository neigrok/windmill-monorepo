// One continuous Markdown file, oldest first. Scales are written as fractions ("mood 4/10"), never words,
// and at full precision — a zero is an answer and prints; unset omits the line.

import { journalApi } from '../journalApi.js';
import { isWritten, normalizePage } from '../pageCache.js';

export function journalMarkdown(pages) {
  const written = pages.map(normalizePage).filter(isWritten).sort((a, b) => (a.day < b.day ? -1 : 1));
  const blocks = written.map((page) => {
    const scales = [];
    if (page.mood != null) scales.push(`mood ${page.mood}/10`);
    if (page.energy != null) scales.push(`energy ${page.energy}/10`);
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
