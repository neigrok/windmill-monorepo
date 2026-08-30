// Where the links are in a page of writing. One grammar, painted twice: as anchors in a past day's
// prose, and under the composer's own caret while today is still being written.
//
// Conservative on purpose. A journal is prose, and a false link in the middle of a sentence is worse
// than a missed one — so only an explicit scheme or a `www.` counts, never a bare `whatever.com`.

const LINK = /(?:https?:\/\/|www\.)[^\s<>"'` ]+/gi;

// Punctuation a sentence puts after a URL, never inside one.
const TAIL = '.,;:!?…*_\'"’”';

const CLOSERS = { ')': '(', ']': '[', '}': '{' };

export function findLinks(text) {
  if (!text) return [];
  const found = [];
  for (const match of text.matchAll(LINK)) {
    const lo = match.index;
    if (/[\p{L}\p{N}@]/u.test(text[lo - 1] ?? '')) continue;   // not a link glued to the end of a word
    const raw = trimTail(match[0]);
    const scheme = /^https?:\/\//i.test(raw);
    if (!hasHost(raw, scheme)) continue;
    found.push({ lo, hi: lo + raw.length, href: scheme ? raw : `https://${raw}` });
  }
  return found;
}

// A run of the text with everything decided about it: whether it is inside a link, and whether the
// search hit lights it. Cutting at every boundary is what lets the two overlap without special cases.
export function proseRuns(text, { highlight = null, links = findLinks(text) } = {}) {
  const cuts = new Set([0, text.length]);
  for (const link of links) {
    cuts.add(link.lo);
    cuts.add(link.hi);
  }
  if (highlight) {
    cuts.add(highlight.lo);
    cuts.add(highlight.hi);
  }
  const points = [...cuts].filter((at) => at > 0 && at < text.length).sort((a, b) => a - b);
  const edges = [0, ...points, text.length];

  const runs = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const [lo, hi] = [edges[i], edges[i + 1]];
    if (hi <= lo) continue;
    const link = links.find((span) => span.lo <= lo && hi <= span.hi) ?? null;
    runs.push({
      lo,
      hi,
      text: text.slice(lo, hi),
      href: link ? link.href : null,
      marked: highlight != null && highlight.lo <= lo && hi <= highlight.hi,
    });
  }
  return runs;
}

function trimTail(raw) {
  let out = raw;
  for (;;) {
    const last = out[out.length - 1];
    if (last === undefined) return out;
    if (last in CLOSERS) {
      // A closer the URL opened itself stays — /wiki/Windmill_(machine) is the whole link.
      if (opensIts(out, CLOSERS[last], last)) return out;
      out = out.slice(0, -1);
      continue;
    }
    if (!TAIL.includes(last)) return out;
    out = out.slice(0, -1);
  }
}

function opensIts(raw, open, close) {
  let depth = 0;
  for (const ch of raw) {
    if (ch === open) depth += 1;
    else if (ch === close) depth -= 1;
  }
  return depth >= 0;
}

// With a scheme the writer said it was a link, so any host will do — including a bare `localhost`.
// Without one, `www.` alone is not enough: the host has to end in something that looks like a TLD.
function hasHost(raw, scheme) {
  const host = raw.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].split('@').pop().split(':')[0];
  if (!host) return false;
  return scheme || /\.[a-z]{2,}$/i.test(host);
}
