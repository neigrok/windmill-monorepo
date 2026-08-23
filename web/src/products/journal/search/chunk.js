// A page's body split into passages — roughly sentences — each with its half-open [lo, hi) char range
// into the body. Span-exact: body.slice(lo, hi) === passage.text for every passage returned.

export function chunk(body) {
  const passages = [];
  let start = 0;

  const flush = (end) => {
    let lo = start;
    let hi = end;
    while (lo < hi && /\s/.test(body[lo])) lo++;
    while (hi > lo && /\s/.test(body[hi - 1])) hi--;
    const text = body.slice(lo, hi);
    if (text.length >= 2) passages.push({ text, lo, hi });
    start = end;
  };

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '.' || c === '!' || c === '?' || c === '\n') flush(i + 1);
  }
  if (start < body.length) flush(body.length);
  return passages;
}
