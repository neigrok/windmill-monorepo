// Every month from the first thing written to the last, each day a cell. Pure over the pages: no dates
// invented, no today assumed. Oldest month first.

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();   // month is 1-based; day 0 rolls back to the last of it
}

export function buildYear(pages) {
  const byDate = new Map(pages.map((page) => [page.day, page]));
  const written = pages.map((page) => page.day).filter(Boolean).sort();
  if (written.length === 0) return [];

  const [firstYear, firstMonth] = written[0].split('-').map(Number);
  const [lastYear, lastMonth] = written[written.length - 1].split('-').map(Number);
  const months = [];
  let year = firstYear;
  let month = firstMonth;
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const days = [];
    for (let day = 1; day <= daysInMonth(year, month); day++) {
      const date = `${key}-${String(day).padStart(2, '0')}`;
      const page = byDate.get(date);
      days.push({ date, written: !!page, mood: page?.mood ?? null, energy: page?.energy ?? null });
    }
    months.push({ key, year, month, days });
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}
