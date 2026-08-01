// WHICH MOVEMENTS THE PICKER OFFERS — and, when it offers none, which of the three different
// silences it is looking at. They used to share one sentence, so a lifter who typed a letter the
// catalog does not hold was told their signal was out: the app reported a failure that had not
// happened and pointed them at the wrong thing to fix.
//
// Only an empty catalog may mention signal. A catalog that is entirely in the session says so, and
// a query that matched nothing says only that — the copy never sends the lifter to a door phase 0
// does not have (there is no create-a-movement endpoint, and routines are phase 2).

export const PICKER_MATCHES = 7;

export function movementOptions({ catalog = [], order = [], query = '' }) {
  const term = query.trim().toLowerCase();
  const available = catalog.filter((each) => !order.includes(each.id));
  const matches = available
    .filter((each) => each.name.toLowerCase().includes(term))
    .slice(0, PICKER_MATCHES);
  if (matches.length > 0) return { matches, empty: null };
  if (catalog.length === 0) return { matches, empty: 'The catalog didn’t load. It comes back when you have signal.' };
  if (available.length === 0) return { matches, empty: 'Every movement in the catalog is already in this session.' };
  return { matches, empty: `Nothing in the catalog matches “${query.trim()}”.` };
}
