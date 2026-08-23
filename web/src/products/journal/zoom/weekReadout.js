// The last seven days, oldest first. Pure over the pages and an explicit `today`, never the clock.

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
