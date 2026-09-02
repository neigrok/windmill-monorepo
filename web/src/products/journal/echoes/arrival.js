// An arrival is news the journal now holds, drawn where the news belongs. It is neither of the two
// classes the motion language names: no act of the reader's caused it, and it fires the moment it
// lands, mid-sentence included. It survives being fired mid-sentence by carrying no transient at all
// — one channel (luminance), one clock, gradual on both edges — and by not flashing and vanishing:
// it lights and STAYS lit until there is evidence the writer has surfaced.
//
// This file is the whole of the arming rule, and it is pure, because the alternative is a judgement
// about time that can only be checked by opening a browser and waiting fifteen seconds.

// Half --duration-glow, and the canon PULSE cycle. The rise is slow enough that it is SEEN without
// CAPTURING: attention is yanked by the transient — the abrupt onset — never by the size of the
// change, so noticeability is bought with duration and area instead of with speed and amplitude.
export const KINDLE_MS = 1200;
// The full --duration-glow. A fall slow enough to go unnoticed has to outlast the rise that earned
// the glance, and it runs on `linear`: any easing gives a disappearance one moment where it moves
// fastest, which is the only part of it a peripheral eye can catch.
export const SETTLE_MS = 2400;
// The pause threshold keystroke-logging research puts a sentence boundary at, far above the 200-300ms
// between keys in ordinary prose, so it does not trip between two words.
export const PAUSE_MS = 2000;
// A backstop, not a rule. Like every other way the dwell ends, it only spends the light while the tab
// is on screen — a light fired into an empty room is never spent, it waits.
export const CEILING_MS = 90000;

// Which page an arrival lights, and everything the reader has now been shown. `shown` is the whole
// memory: a passage inside it has been presented at rest and is not news, whatever a later read, a
// poll beat or a re-derivation says about it.
//
// A passage is identified by the day it came from AND its words. Two passages out of one past day
// are two pieces of news, and a memory keyed by the day alone would present the second one for free
// the moment the first was shown.
//
// THE MOUNT'S FIRST COMPLETED READ IS NOT SEEN HERE AT ALL: that read seeds `shown` with its own
// reply as it lands, so a page that was already there when the journal opened is already presented
// by the time this runs. Deliberately not a flag — a latch read one commit later is a latch that two
// reads landing in one batch walk straight past, and a tab return starts exactly two.
export function armArrival({ shown, pages, openDay = null, nearest = null, today = null }) {
  const next = new Map(shown);
  const fresh = [];
  for (const page of pages) {
    // ARM ON `verified`, NOT ON PRESENCE. The echo the client holds is the one whose quotes have been
    // re-located in the live bodies — that is what makes the count and the card agree, and a page
    // re-location kills never fired a light at all, which is correct. An unverified page is not
    // folded in either: it has not been presented, so it is still news when it comes back verified.
    if (!page.verified) continue;
    const passages = page.passages || [];
    const seen = next.get(page.day) ?? new Set();
    const added = passages.filter((passage) => !seen.has(passage));
    // Unioned AT THE MOMENT OF ARMING, so no re-read and no poll beat can arm the same news twice.
    // A page carrying nothing has been shown nothing, and writing it here would say otherwise — the
    // same memory now also decides whether a tab is a new object, so an empty write would suppress
    // a ramp as well as a light.
    if (passages.length) next.set(page.day, new Set([...seen, ...passages]));
    // Retirement, dismissal and a shrinking match set arm nothing: `added` is empty for all three.
    // Nor does a page whose ink is open — the tab is the close control then, and the new row's own
    // entrance is the event.
    if (!added.length || page.day === openDay) continue;
    fresh.push(page.day);
  }
  if (!fresh.length) return { shown: next, arrival: null };
  // THE CALM CEILING: one tab lights, never three. A repair pass dropping echoes onto three old
  // pages in one read lights tonight's if it is among them, else the page nearest the reading
  // waterline; the rest take their resting face silently.
  const pick = fresh.includes(today) ? today
    : (fresh.includes(nearest) ? nearest : [...fresh].sort().pop());
  const page = pages.find((each) => each.day === pick);
  return {
    shown: next,
    // The count is what the tab SAYS, not what is new about it: the light is the whole sentence, and
    // nothing anywhere counts the fresh ones out loud. Whether the TAB is new is not decided here —
    // that is a fact about an element on screen, and only the element knows it.
    arrival: { day: pick, count: (page.passages || []).length },
  };
}

// A tab that mounts into a dwell already under way must resume, never re-kindle: the light is spent
// by the writer surfacing, and a scroll that remounts the page is not that.
export function resumedOnMount(kindledAt, now) {
  return Boolean(kindledAt) && now - kindledAt > KINDLE_MS;
}
