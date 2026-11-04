export const SEARCH_THRESHOLD = 8;

export function roadmapMatch(title, query) {
  const search = query.trim().toLowerCase();
  if (!search) return { start: 0, end: 0 };
  const foldedTitle = title.toLowerCase();
  const matchStart = foldedTitle.indexOf(search);
  if (matchStart < 0) return null;
  const matchEnd = matchStart + search.length;
  let originalOffset = 0;
  let foldedOffset = 0;
  let start = 0;
  for (const character of title) {
    const originalEnd = originalOffset + character.length;
    const foldedEnd = foldedOffset + character.toLowerCase().length;
    if (foldedOffset <= matchStart && matchStart < foldedEnd) start = originalOffset;
    if (foldedOffset < matchEnd && matchEnd <= foldedEnd) return { start, end: originalEnd };
    originalOffset = originalEnd;
    foldedOffset = foldedEnd;
  }
  return null;
}
