// The journal landing's five vignettes, ported from the static page's inline script with every
// timing intact. Each mounts on the element React hands it and returns a teardown, the way
// treeScenes does for roadmap. The markup React renders IS the settled end state, so a scene's
// first act is to wind it back and replay — and a teardown puts it back the way React rendered
// it, so a remount finds its end state again. Under prefers-reduced-motion nothing is wired and
// nothing is wound back: the page is already at rest, which is the legible end state.
// Behaviour hooks are data-* attributes on purpose — journalLanding.css paints none of them.

const PRM = matchMedia('(prefers-reduced-motion: reduce)').matches;

// A line rests a beat on punctuation. A flat pace reads as a machine typing; this reads as someone
// thinking between clauses.
const PUNCTUATION = /[.,;—]/;

function timers() {
  const live = new Set();
  return {
    after(ms, run) { const id = setTimeout(() => { live.delete(id); run(); }, ms); live.add(id); },
    clear() { live.forEach(clearTimeout); live.clear(); },
  };
}

// One typewriter for all three typed lines. It holds rather than racing through a scene in a tab
// nobody is looking at.
function typeOut(kit, target, text, pace, settled) {
  target.textContent = '';
  let written = 0;
  const step = () => {
    if (document.hidden) { kit.after(500, step); return; }
    if (written >= text.length) { settled?.(); return; }
    const character = text.charAt(written);
    written += 1;
    target.textContent = text.slice(0, written);
    kit.after(PUNCTUATION.test(character) ? pace.rest : pace.char, step);
  };
  kit.after(pace.lead, step);
}

// The moat — the window of night. Tonight's line types itself, rests, and the echo blooms under
// it. This is the page's one infinite-motion budget, so it is spent only where it can be seen:
// it plays on entry, rests when it scrolls away, and picks up again on the way back.
export function mountNightWindow(root) {
  if (PRM) return () => {};
  const kit = timers();
  const typed = root.querySelector('[data-typed]');
  const echo = root.querySelector('[data-echo]');
  const line = typed.textContent;
  let playing = false;

  const rewind = () => {
    kit.clear();
    typed.textContent = '';
    echo.classList.remove('jn-echo-in');
    echo.style.opacity = '0';
  };
  const play = () => {
    rewind();
    typeOut(kit, typed, line, { lead: 700, char: 84, rest: 380 }, () => {
      kit.after(1500, () => { echo.style.opacity = ''; echo.classList.add('jn-echo-in'); });
    });
  };

  const eye = new IntersectionObserver(([band]) => {
    if (band.isIntersecting && !playing) { playing = true; play(); return; }
    if (!band.isIntersecting) { playing = false; rewind(); }
  }, { threshold: 0.35 });
  eye.observe(root);

  return () => {
    eye.disconnect();
    kit.clear();
    typed.textContent = line;
    echo.classList.remove('jn-echo-in');
    echo.style.opacity = '';
  };
}

// Loop scene 01 — retype today's line on click.
export function mountWriteBeat(root) {
  if (PRM) return () => {};
  const kit = timers();
  const typed = root.querySelector('[data-typed]');
  const line = typed.textContent;
  const replay = () => {
    kit.clear();
    typeOut(kit, typed, line, { lead: 300, char: 74, rest: 320 });
  };
  root.addEventListener('click', replay);
  return () => { root.removeEventListener('click', replay); kit.clear(); typed.textContent = line; };
}

// Loop scene 02 — the read view for a beat, then the canvas pinches down to the year.
export function mountLookBackBeat(root) {
  if (PRM) return () => {};
  const kit = timers();
  const read = root.querySelector('[data-read]');
  const year = root.querySelector('[data-year]');
  const readAtRest = read.style.display;
  const yearAtRest = year.style.display;
  const replay = () => {
    kit.clear();
    year.classList.remove('jn-rise');
    year.style.display = 'none';
    read.style.display = '';
    kit.after(1100, () => {
      read.style.display = 'none';
      year.style.display = '';
      year.classList.add('jn-rise');
    });
  };
  root.addEventListener('click', replay);
  return () => {
    root.removeEventListener('click', replay);
    kit.clear();
    year.classList.remove('jn-rise');
    read.style.display = readAtRest;
    year.style.display = yearAtRest;
  };
}

// Loop scene 03 — the week's columns arrive one by one, then the word that survived them.
export function mountHearBackBeat(root) {
  if (PRM) return () => {};
  const kit = timers();
  const days = root.querySelectorAll('.jn-weekday');
  const word = root.querySelector('[data-word]');
  const wordAtRest = word.style.display;
  const replay = () => {
    kit.clear();
    word.classList.remove('jn-rise');
    word.style.display = 'none';
    days.forEach((day) => { day.style.opacity = '0'; });
    let lit = 0;
    const tick = () => {
      if (lit < days.length) { days[lit].style.opacity = '1'; lit += 1; kit.after(140, tick); return; }
      word.style.display = '';
      word.classList.add('jn-rise');
    };
    kit.after(250, tick);
  };
  root.addEventListener('click', replay);
  return () => {
    root.removeEventListener('click', replay);
    kit.clear();
    word.classList.remove('jn-rise');
    word.style.display = wordAtRest;
    days.forEach((day) => { day.style.opacity = ''; });
  };
}

// The search sheet — retype the query, then the passage that never used those words rises in.
export function mountSearchSheet(root) {
  if (PRM) return () => {};
  const kit = timers();
  const typed = root.querySelector('[data-typed]');
  const hit = root.querySelector('[data-hit]');
  const query = typed.textContent;
  const hitAtRest = hit.style.display;
  const replay = () => {
    kit.clear();
    hit.classList.remove('jn-rise');
    hit.style.display = 'none';
    typeOut(kit, typed, query, { lead: 300, char: 90, rest: 90 }, () => {
      kit.after(400, () => { hit.style.display = 'flex'; hit.classList.add('jn-rise'); });
    });
  };
  root.addEventListener('click', replay);
  return () => {
    root.removeEventListener('click', replay);
    kit.clear();
    typed.textContent = query;
    hit.classList.remove('jn-rise');
    hit.style.display = hitAtRest;
  };
}
