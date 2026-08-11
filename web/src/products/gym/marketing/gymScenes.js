// The gym landing's four vignettes, lifted from the static page's inline <script>. Unlike the
// roadmap's tree, gym's scenes are a fixed instrument panel with a timeline over it — so the
// markup stays declarative in GymLanding.jsx and these drive it through data-gy handles.
// Under reduced motion every mount returns without touching anything, which leaves the markup's
// own rest state on screen: the still moat panel, the drawn e1RM line, the remembered card.
// A scene borrows the markup, it never owns it: every teardown hands it back exactly as React
// rendered it, so a remount — a route change, StrictMode's second pass — starts from rest.

const PRM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const NOOP = () => {};

const handle = (root, name) => root.querySelector(`[data-gy="${name}"]`);

function timers() {
  const ids = [];
  return {
    at(ms, fn) { ids.push(setTimeout(fn, ms)); },
    clear() { ids.forEach(clearTimeout); ids.length = 0; },
  };
}

// The hero moat: one set logged, then next Tuesday opening with that number already in the
// field. The page's only infinite loop, so it costs nothing when nobody is watching.
export function mountMoat(root) {
  if (PRM) return NOOP;

  const still = handle(root, 'still');
  const live = handle(root, 'live');
  const session = handle(root, 'session');
  const weight = handle(root, 'weight');
  const note = handle(root, 'note');
  const reps = handle(root, 'reps');
  const pr = handle(root, 'pr');
  const row4 = handle(root, 'row4');
  const fine = handle(root, 'fine');
  const logSet = handle(root, 'log');

  // React renders the still panel and keeps the live one folded away; the timeline borrows the
  // swap and the teardown gives it back, so a remount finds the moat as it was rendered.
  const stillAtRest = still.style.display;
  const liveAtRest = live.style.display;

  still.style.display = 'none';
  live.style.display = 'block';

  const T = timers();
  let running = false;
  let visible = false;

  const press = (el, ms) => {
    el.classList.add('gym-pressed');
    T.at(ms, () => el.classList.remove('gym-pressed'));
  };

  const reset = () => {
    session.textContent = 'Tuesday · week 6';
    weight.textContent = '97.5';
    note.textContent = 'last week · 97.5 × 5';
    reps.textContent = '—';
    pr.style.display = 'none';
    row4.style.display = 'none';
    fine.classList.remove('gym-pressed');
    logSet.classList.remove('gym-pressed');
    live.style.opacity = '';
  };

  const play = () => {
    T.clear();
    reset();
    // Every beat waits for an audience: a hidden tab or a scrolled-past moat re-queues the
    // step instead of burning the timeline where nobody can see it.
    const go = (ms, fn) => T.at(ms, () => {
      if (!running) return;
      if (document.hidden || !visible) { go(800, fn); return; }
      fn();
    });
    const tick = (n) => go(0, () => {
      reps.textContent = String(n);
      if (n < 5) T.at(150, () => tick(n + 1));
    });
    go(1100, () => press(fine, 240));
    go(1300, () => { weight.textContent = '100'; });
    go(2100, () => tick(1));
    go(3300, () => press(logSet, 280));
    go(3600, () => { row4.style.display = 'flex'; });
    go(5200, () => { live.style.opacity = '0'; });
    go(5500, () => {
      session.textContent = 'Next session · Tuesday · week 7';
      weight.textContent = '100';
      note.textContent = 'last session · 100 × 5 — already in the field';
      reps.textContent = '5';
      row4.style.display = 'none';
      live.style.opacity = '1';
    });
    go(6600, () => { pr.style.display = 'block'; });
    go(11200, () => { live.style.opacity = '0'; });
    go(11500, () => { if (running) play(); });
  };

  const io = new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible && !running) { running = true; play(); }
    if (!visible) { running = false; T.clear(); reset(); }
  }, { threshold: 0.35 });
  io.observe(root);

  return () => {
    io.disconnect();
    T.clear();
    reset();
    live.style.display = liveAtRest;
    still.style.display = stillAtRest;
  };
}

// Beat 01 — the fine step IS the program step, so next week is one tap. Finite, and only on a
// click: nothing below the hero plays by itself.
export function mountSetLogger(root) {
  if (PRM) return NOOP;

  const weight = handle(root, 's1w');
  const reps = handle(root, 's1r');
  const fine = handle(root, 's1fine');
  const T = timers();
  const weightAtRest = weight.textContent;
  const repsAtRest = reps.textContent;

  const replay = () => {
    T.clear();
    weight.textContent = '97.5';
    reps.textContent = '—';
    T.at(500, () => {
      fine.classList.add('gym-pressed');
      T.at(240, () => fine.classList.remove('gym-pressed'));
    });
    T.at(700, () => { weight.textContent = '100'; });
    for (let n = 1; n <= 5; n += 1) T.at(1100 + n * 150, () => { reps.textContent = String(n); });
  };

  root.addEventListener('click', replay);
  return () => {
    root.removeEventListener('click', replay);
    T.clear();
    fine.classList.remove('gym-pressed');
    weight.textContent = weightAtRest;
    reps.textContent = repsAtRest;
  };
}

// Beat 02 — next session's card arriving with last time's numbers. Pulling the card and
// putting it back restarts its own CSS rise.
export function mountRemembered(root) {
  if (PRM) return NOOP;

  const card = handle(root, 's2card');
  const T = timers();
  const cardAtRest = card.style.display;

  const replay = () => {
    T.clear();
    card.style.display = 'none';
    T.at(240, () => { card.style.display = ''; });
  };

  root.addEventListener('click', replay);
  return () => {
    root.removeEventListener('click', replay);
    T.clear();
    card.style.display = cardAtRest;
  };
}

// Beat 03 — twelve weeks of e1RM drawn left to right, the dot and the caption landing after it.
export function mountE1rmLine(root) {
  if (PRM) return NOOP;

  const line = handle(root, 's3line');
  const dot = handle(root, 's3dot');
  const cap = handle(root, 's3cap');
  const T = timers();

  const replay = () => {
    T.clear();
    const len = line.getTotalLength();
    line.style.transition = 'none';
    line.style.strokeDasharray = `${len} ${len}`;
    line.style.strokeDashoffset = String(len);
    dot.style.transition = 'none';
    dot.style.opacity = '0';
    cap.style.transition = 'none';
    cap.style.opacity = '0';
    T.at(60, () => {
      line.style.transition = 'stroke-dashoffset 1400ms var(--ease-standard)';
      line.style.strokeDashoffset = '0';
    });
    T.at(1400, () => { dot.style.transition = 'opacity 280ms var(--ease-standard)'; dot.style.opacity = '1'; });
    T.at(1650, () => { cap.style.transition = 'opacity 280ms var(--ease-standard)'; cap.style.opacity = '1'; });
  };

  root.addEventListener('click', replay);
  return () => {
    root.removeEventListener('click', replay);
    T.clear();
    line.style.transition = '';
    line.style.strokeDasharray = '';
    line.style.strokeDashoffset = '';
    dot.style.transition = '';
    dot.style.opacity = '';
    cap.style.transition = '';
    cap.style.opacity = '';
  };
}
