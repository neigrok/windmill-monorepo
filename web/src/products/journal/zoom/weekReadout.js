// The last seven days, read back as a small arc: how many you wrote, the mood and energy of each, and
// the words they came to. Pure over the pages and an explicit `today` (passed in, never read from the
// clock here), so the readout is deterministic and testable. Oldest of the seven first, so the arc
// reads left-to-right toward now.

import { daysBefore } from '../hlc.js';

function wordCount(body) {
  const trimmed = (body || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function weekReadout(pages, today) {
  const byDate = new Map(pages.map((page) => [page.day, page]));
  const days = [];
  let written = 0;
  let totalWords = 0;
  for (let back = 6; back >= 0; back--) {
    const date = daysBefore(today, back);
    const page = byDate.get(date);
    const words = wordCount(page?.body);
    if (page) written += 1;
    totalWords += words;
    days.push({ date, written: !!page, mood: page?.mood ?? null, energy: page?.energy ?? null, words });
  }
  return { written, of: 7, totalWords, days };
}
