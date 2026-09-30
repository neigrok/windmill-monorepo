// §6.11 the text merge. An edit script is the lexicographically least shortest script under
// keep < delete < insert: equal tokens are kept early, and a deletion precedes an insertion.

import { CONSTANTS } from '../core/constants.js';

const TOKEN = /\s+|\S+/g;

export function tokenize(text) {
  return text.match(TOKEN) ?? [];
}

export function editScript(a, b) {
  const n = a.length;
  const m = b.length;
  const rest = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n; i >= 0; i -= 1) {
    for (let j = m; j >= 0; j -= 1) {
      if (i === n) rest[i][j] = m - j;
      else if (j === m) rest[i][j] = n - i;
      else if (a[i] === b[j]) rest[i][j] = rest[i + 1][j + 1];
      else rest[i][j] = 1 + Math.min(rest[i + 1][j], rest[i][j + 1]);
    }
  }
  const script = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      script.push({ op: 'keep', token: a[i] });
      i += 1;
      j += 1;
    } else if (i < n && rest[i + 1][j] + 1 === rest[i][j]) {
      script.push({ op: 'delete', token: a[i] });
      i += 1;
    } else {
      script.push({ op: 'insert', token: b[j] });
      j += 1;
    }
  }
  return script;
}

// Maximal runs of edits, as base ranges [start, end) with the tokens that replace them.
export function hunksOf(script) {
  const hunks = [];
  let position = 0;
  let open = null;
  for (const step of script) {
    if (step.op === 'keep') {
      if (open) hunks.push(open);
      open = null;
      position += 1;
      continue;
    }
    open ??= { start: position, end: position, tokens: [] };
    if (step.op === 'delete') {
      position += 1;
      open.end = position;
    } else {
      open.tokens.push(step.token);
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

const WHITESPACE = /^\s+$/;

// A hunk whose every deleted and inserted token is whitespace.
function isWhitespaceOnly(base, hunk) {
  return [...base.slice(hunk.start, hunk.end), ...hunk.tokens].every((token) => WHITESPACE.test(token));
}

function touches(x, y) {
  return x.start <= y.end && y.start <= x.end;
}

function sideText(base, lo, hi, hunks) {
  const out = [];
  let position = lo;
  for (const hunk of hunks) {
    out.push(...base.slice(position, hunk.start), ...hunk.tokens);
    position = hunk.end;
  }
  out.push(...base.slice(position, hi));
  return out.join('');
}

// §6.11: each script diff3 builds, base→head and base→mine, takes (base tokens + 1) × (side tokens + 1)
// cells. When either would take over MERGE_WORK_CELLS, the whole text is one conflict region.
export function diff3(baseText, headText, mineText, limits = CONSTANTS) {
  const base = tokenize(baseText);
  const head = tokenize(headText);
  const mine = tokenize(mineText);
  const cells = (side) => (base.length + 1) * (side.length + 1);
  if (cells(head) > limits.MERGE_WORK_CELLS || cells(mine) > limits.MERGE_WORK_CELLS) {
    return { text: `${headText.trimEnd()}\n\n${mineText.trimStart()}`, conflict: true };
  }
  const tagged = [
    ...hunksOf(editScript(base, head)).map((hunk) => ({ ...hunk, side: 'head' })),
    ...hunksOf(editScript(base, mine)).map((hunk) => ({ ...hunk, side: 'mine' })),
  ].sort((x, y) => x.start - y.start || x.end - y.end || (x.side === 'head' ? -1 : 1));

  const regions = [];
  for (const hunk of tagged) {
    const last = regions[regions.length - 1];
    if (last && touches(last, hunk)) {
      last.end = Math.max(last.end, hunk.end);
      last.hunks.push(hunk);
    } else {
      regions.push({ start: hunk.start, end: hunk.end, hunks: [hunk] });
    }
  }

  const out = [];
  let conflict = false;
  let position = 0;
  for (const region of regions) {
    out.push(...base.slice(position, region.start));
    position = region.end;
    const heads = region.hunks.filter((hunk) => hunk.side === 'head');
    const mines = region.hunks.filter((hunk) => hunk.side === 'mine');
    const H = sideText(base, region.start, region.end, heads);
    const M = sideText(base, region.start, region.end, mines);
    const headBlank = heads.every((hunk) => isWhitespaceOnly(base, hunk));
    const mineBlank = mines.every((hunk) => isWhitespaceOnly(base, hunk));
    if (mines.length === 0) out.push(H);
    else if (heads.length === 0) out.push(M);
    else if (H === M) out.push(H);
    else if (headBlank && mineBlank) out.push(H);
    else if (headBlank) out.push(M);
    else if (mineBlank) out.push(H);
    else if (H === '') out.push(M);
    else if (M === '') out.push(H);
    else {
      out.push(`${H.trimEnd()}\n\n${M.trimStart()}`);
      conflict = true;
    }
  }
  out.push(...base.slice(position));
  return { text: out.join(''), conflict };
}

function extendsTokens(x, y) {
  const xs = tokenize(x);
  const ys = tokenize(y);
  return ys.length <= xs.length && ys.every((token, index) => token === xs[index]);
}

// `stored`: {text, rev, merged} of the field ('' at rev 0 when never written). `base`: {rev} or {text}.
// `revisionText(rev)`: a kept superseded head, or undefined. Answers {refuse} or {text, conflict, baseText}.
export function mergeText({ stored, base, mine, revisionText, limits = CONSTANTS }) {
  const head = stored.text;
  let baseText;
  if (Object.hasOwn(base, 'rev')) {
    baseText = base.rev === stored.rev ? head : revisionText(base.rev);
    if (baseText === undefined) return { refuse: 'base-unknown' };
  } else {
    baseText = base.text;
    if (baseText === '' && extendsTokens(mine, head)) baseText = head;
    else if (baseText === '' && extendsTokens(head, mine)) baseText = mine;
  }
  if (mine === head) return { text: head, conflict: false, baseText };
  if (baseText === head) return { text: mine, conflict: false, baseText };
  if (baseText === mine) return { text: head, conflict: false, baseText };
  return { ...diff3(baseText, head, mine, limits), baseText };
}

export function mergedFlag(stored, merge) {
  return merge.conflict || (stored.merged && merge.baseText !== stored.text);
}
