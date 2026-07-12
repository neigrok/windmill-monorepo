// Marketing tree scenes — the live moat. Physics + staging lifted from the F4 playable
// demo. Motion cites motion-language.md: arrival = #14 (#3's constants, no toast),
// self-play unlock = #4 verbatim, reset = a downward change (plain 280ms dim, no beat).
// Ported from the design system's ui_kits/marketing/tree-scenes.js: the IIFE/window.WMScenes
// wrapper became ES exports, and the hero Fork CTA points at the real read-only demo route.

const PRM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const KIND = {
  gold:       { f: '#C4972F', r: '#A17822', g: '196,151,47'  },
  terracotta: { f: '#BC6C42', r: '#9D5330', g: '188,108,66'  },
  olive:      { f: '#7D8C43', r: '#616E33', g: '125,140,67'  },
  plum:       { f: '#8D4F83', r: '#6F3B67', g: '141,79,131'  },
  brick:      { f: '#A84E35', r: '#8A3A26', g: '168,78,53'   },
  sky:        { f: '#5F8494', r: '#4A6875', g: '95,132,148'  },
};
const EDGE_DORMANT = '#D3C2A0', EDGE_LIT = '#9C6B44';
const FORK_IC = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="4.6" r="2.5"></circle><circle cx="5.4" cy="19.4" r="2.5"></circle><circle cx="18.6" cy="19.4" r="2.5"></circle><path d="M12 7.1v3.2M12 10.3c0 3-6.6 3.4-6.6 6.6M12 10.3c0 3 6.6 3.4 6.6 6.6"></path></svg>';

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); return Math.abs(h); }
function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  parent.appendChild(e); return e;
}
function sv(tag, attrs, parent) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent.appendChild(e); return e;
}
const smooth = t => t * t * (3 - 2 * t);
function mkKit() {
  const K = { timers: [], rafs: [],
    T(ms, fn) { K.timers.push(setTimeout(fn, ms)); },
    clear() { K.timers.forEach(clearTimeout); K.rafs.forEach(cancelAnimationFrame); K.timers = []; K.rafs = []; } };
  return K;
}

// ---------- the sail tree (X5 world 780×940), staged per F4 ----------
const ND = {
  r:  { name: 'Learn to sail',       k: 'terracotta', x: 390, y: 490, ring: 0, crown: true },
  a:  { name: 'Knots & lines',       k: 'olive',      x: 282, y: 375, ring: 1 },
  b:  { name: 'Rig the mast',        k: 'terracotta', x: 502, y: 382, ring: 1 },
  c:  { name: 'Read the wind',       k: 'sky',        x: 238, y: 562, ring: 1 },
  d:  { name: 'Docking',             k: 'gold',       x: 540, y: 575, ring: 1 },
  e:  { name: 'Capsize drill',       k: 'brick',      x: 392, y: 665, ring: 1 },
  a1: { name: 'Whipping & splicing', k: 'olive',      x: 196, y: 268, ring: 2 },
  a2: { name: 'Cleats & hitches',    k: 'olive',      x: 332, y: 238, ring: 2 },
  b1: { name: 'Sail trim',           k: 'terracotta', x: 612, y: 286, ring: 2 },
  b2: { name: 'Points of sail',      k: 'terracotta', x: 486, y: 228, ring: 2 },
  c1: { name: 'Weather windows',     k: 'sky',        x: 112, y: 478, ring: 2 },
  d1: { name: 'Night docking',       k: 'gold',       x: 664, y: 660, ring: 2 },
  e1: { name: 'Man overboard drill', k: 'brick',      x: 298, y: 782, ring: 2 },
  b3: { name: 'Reefing',             k: 'terracotta', x: 680, y: 428, ring: 3 },
  c2: { name: 'Tides & currents',    k: 'sky',        x: 122, y: 648, ring: 3 },
  e2: { name: 'First aid afloat',    k: 'brick',      x: 478, y: 788, ring: 3 },
  m1: { name: 'First solo sail',     k: 'plum',       x: 706, y: 182, ring: 3 },
};
const ED = [['r','a'],['r','b'],['r','c'],['r','d'],['r','e'],['a','a1'],['a','a2'],['b','b1'],['b','b2'],
            ['b1','b3'],['b2','b3'],['b1','m1'],['c','c1'],['c1','c2'],['d','d1'],['e','e1'],['e1','e2']];
const STAGED = { r:'done', a:'done', c:'done', e:'done', a1:'done', a2:'done',
                 b:'avail', d:'avail', c1:'avail', e1:'avail',
                 b1:'dim', b2:'dim', b3:'dim', m1:'dim', d1:'dim', c2:'dim', e2:'dim' };

// ---------- world builder ----------
function qd(a, b, sign) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  const cx = (a[0] + b[0]) / 2 - dy / L * 0.14 * L * (sign || 1), cy = (a[1] + b[1]) / 2 + dx / L * 0.14 * L * (sign || 1);
  return `M${a[0]},${a[1]} Q${cx},${cy} ${b[0]},${b[1]}`;
}
// o: { w, h, s, ox, oy, states, nodes:ND, edges:ED, labels:'all'|'none'|[ids], pre, sizes, labelSizes }
function buildWorld(stage, o) {
  const NDS = o.nodes || ND, EDS = o.edges || ED;
  const P = {}; for (const id in NDS) P[id] = [NDS[id].x * o.s + o.ox, NDS[id].y * o.s + o.oy];
  const svg = sv('svg', { width: o.w, height: o.h, viewBox: `0 0 ${o.w} ${o.h}`,
    style: 'position:absolute;inset:0;overflow:visible;z-index:1;' }, stage);
  const edges = {};
  EDS.forEach(pair => {
    const [s0, s1] = pair, lit = o.states[s0] === 'done';
    const d = qd(P[s0], P[s1], (hashStr(s0 + s1) % 2 ? 1 : -1) * .6);
    edges[s0 + '-' + s1] = { d, ring: NDS[s1].ring, src: s0, dst: s1,
      base: sv('path', { class: 'eb', d, fill: 'none', 'stroke-linecap': 'round',
        stroke: lit ? EDGE_LIT : EDGE_DORMANT, 'stroke-width': lit ? 2.2 : 1.5,
        opacity: o.pre ? 0 : (lit ? .9 : .8) }, svg), svg };
  });
  const nodes = {};
  const sizes = o.sizes || [26, 21, 17, 15];
  const lsz = o.labelSizes || [13, 11, 10, 10];
  Object.keys(NDS).forEach(id => {
    const n = NDS[id], k = KIND[n.k], sz = sizes[n.ring];
    const st = o.states[id];
    const nd = el('div', `nd nd-${st}` + (o.pre ? ' pre' : ''), stage);
    nd.dataset.id = id;
    nd.style.cssText = `left:${P[id][0]}px; top:${P[id][1]}px; width:${sz}px; height:${sz}px;` +
      `--g:${k.g}; --ring:${k.r}; --fill:${k.f};`;
    if (n.crown && st === 'done' && !o.pre) {
      if (PRM) nd.style.boxShadow = `0 0 0 4px rgba(${k.g},.28), 0 0 26px 5px rgba(${k.g},.28)`;
      else nd.classList.add('nd--crown');
    }
    if (n.halo && !o.pre) nd.style.boxShadow = `0 0 0 3px rgba(${k.g},.22), 0 0 14px 3px rgba(${k.g},.2)`;
    const wantLabel = o.labels === 'all' || (Array.isArray(o.labels) && o.labels.includes(id));
    if (wantLabel) {
      const l = el('div', 'ndlabel' + (st === 'dim' ? ' ndlabel--dim' : '') + (o.pre ? ' pre' : ''), stage, n.name);
      l.style.cssText = `left:${P[id][0]}px; top:${P[id][1] + sz / 2 + 5}px; font-size:${lsz[n.ring]}px;`;
      nd._label = l;
    }
    nodes[id] = nd;
  });
  return { P, edges, nodes, svg, NDS,
    setSt(id, st) { const nd = nodes[id];
      nd.classList.remove('nd-dim', 'nd-avail', 'nd-done'); nd.classList.add('nd-' + st);
      if (nd._label) nd._label.classList.toggle('ndlabel--dim', st === 'dim'); } };
}

function travel(K, E, dur, onArrive) {
  const g = KIND[(E.NDS || ND)[E.src].k].g, f = KIND[(E.NDS || ND)[E.src].k].f;
  const lit = sv('path', { d: E.d, fill: 'none', stroke: EDGE_LIT, 'stroke-width': 2.2, 'stroke-linecap': 'round' }, E.svg);
  const len = lit.getTotalLength();
  lit.style.strokeDasharray = `${len} ${len}`; lit.style.strokeDashoffset = len;
  const halo = sv('circle', { r: 6, fill: `rgba(${g},.35)` }, E.svg);
  const head = sv('circle', { r: 3, fill: '#FFF6E0', stroke: f, 'stroke-width': 1 }, E.svg);
  const t0 = performance.now(); let fired = false;
  const step = now => {
    const t = Math.min(1, (now - t0) / dur), p = smooth(t);
    lit.style.strokeDashoffset = len * (1 - p);
    const pt = lit.getPointAtLength(len * p);
    halo.setAttribute('cx', pt.x); halo.setAttribute('cy', pt.y);
    head.setAttribute('cx', pt.x); head.setAttribute('cy', pt.y);
    if (!fired && p >= .85) { fired = true; onArrive && onArrive(); }
    if (t < 1) K.rafs.push(requestAnimationFrame(step));
    else { halo.remove(); head.remove(); E.base.setAttribute('stroke', EDGE_LIT); E.base.setAttribute('stroke-width', 2.2); lit.remove(); }
  };
  K.rafs.push(requestAnimationFrame(step));
}
function unlight(E) { E.base.setAttribute('stroke', EDGE_DORMANT); E.base.setAttribute('stroke-width', 1.5); E.base.style.opacity = .8; }

// ============================================================
//    HERO — the live moat. Arrival on load (#14, no toast), then
//    a calm self-playing loop: unlock #4 (with toast — the moment
//    being sold) → quiet un-do (plain dim) → idle → again.
//    Chrome (plaque, wordmark chip, Fork CTA, scrims, toast) sits
//    UNSCALED on the wrap; only the world scales (X5 floors).
// ============================================================
const HW = 980, HH = 560;
export function mountHero(wrap) {
  const K = mkKit();
  const o = { w: HW, h: HH, s: .55, ox: 290, oy: 22, labels: 'all' };
  const jit = id => (hashStr(id) % 81) - 40;
  let W, autoplay = !PRM, visible = false, unlocked = false, cycleT = null;

  wrap.classList.add('heroWrap');
  const stage = el('div', 'heroStage', wrap);
  stage.style.cssText = `width:${HW}px; height:${HH}px;`;

  // unscaled chrome — X5's pieces on the hosted surface
  el('div', 'scrim-t', wrap); el('div', 'scrim-b', wrap);
  const plq = el('div', 'plq', wrap,
    '<span class="kdot"></span><span><div class="tn">Learn to sail</div><div class="by"><b>Windmill demo</b> · <span class="ct">6</span>/17 done</div></span>');
  el('div', 'wmk', wrap, 'Windmill');
  const fcta = el('a', 'fcta', wrap, FORK_IC + '<span>Fork this tree</span>');
  fcta.href = '#/t/demo';
  fcta.tabIndex = -1;   // hero is aria-hidden; keep this injected link out of the tab order (the visible "Try the live demo" CTA covers it)
  const toast = el('div', 'toastp', wrap, 'Step unlocked: Rig the mast · <b>2 steps opened</b>');
  const ct = plq.querySelector('.ct');

  // scale-to-fit: world only; labels hide < 0.8× (X5 §5)
  const fit = () => {
    const w = wrap.clientWidth || HW;
    const s = Math.min(Math.max(w / HW, .60), 1.08);
    stage.style.transform = `translateX(-50%) scale(${s})`;
    wrap.style.height = Math.round(HH * s) + 'px';
    wrap.classList.toggle('labels-off', s < 0.8);
  };
  new ResizeObserver(fit).observe(wrap); fit();

  const io = new IntersectionObserver(en => { visible = en[0].isIntersecting; }, { threshold: .25 });
  io.observe(wrap);

  function build(pre) {
    K.clear(); stage.innerHTML = ''; unlocked = false;
    W = buildWorld(stage, Object.assign({ states: Object.assign({}, STAGED), pre }, o));
    W.nodes.b.addEventListener('click', () => fire());
    ct.textContent = '6';
  }
  function fire() {                                   // ceremony #4, verbatim constants
    if (unlocked || document.hidden) return; unlocked = true;
    clearTimeout(cycleT);
    const eB1 = W.edges['b-b1'], eB2 = W.edges['b-b2'];
    if (PRM) {
      W.setSt('b', 'done');
      [eB1, eB2].forEach(E => { E.base.setAttribute('stroke', EDGE_LIT); E.base.setAttribute('stroke-width', 2.2); });
      W.setSt('b1', 'avail'); W.setSt('b2', 'avail');
      K.T(460, () => { toast.classList.add('tin'); ct.textContent = '7'; });
      K.T(4460, () => toast.classList.remove('tin'));
      schedule(9000, reset);
      return;
    }
    W.setSt('b', 'done');                                              // ignite 0–280
    K.T(80, () => { W.nodes.b.classList.add('nd--blossom'); K.T(560, () => W.nodes.b.classList.remove('nd--blossom')); });
    K.T(280, () => {                                                   // travels depart at ignite end
      travel(K, eB1, 340, () => { W.setSt('b1', 'avail'); W.nodes.b1.classList.add('nd--wake'); K.T(520, () => W.nodes.b1.classList.remove('nd--wake')); });
      travel(K, eB2, 340, () => { W.setSt('b2', 'avail'); W.nodes.b2.classList.add('nd--wake'); K.T(520, () => W.nodes.b2.classList.remove('nd--wake')); });
    });
    K.T(1129, () => ['b1', 'b2'].forEach(id => { W.nodes[id].classList.add('nd--echo');   // frontier pulse ×2
      K.T(2450, () => W.nodes[id].classList.remove('nd--echo')); }));
    K.T(1249, () => { toast.classList.add('tin'); ct.textContent = '7'; });                // toast speaks last
    K.T(5249, () => toast.classList.remove('tin'));
    K.T(1650, () => { fcta.classList.add('fcta--echo'); K.T(2450, () => fcta.classList.remove('fcta--echo')); });
    schedule(9800, reset);
  }
  function reset() {                                  // downward change: plain 280ms dim, no beat, no toast
    if (!W) return;
    W.setSt('b', 'avail'); W.setSt('b1', 'dim'); W.setSt('b2', 'dim');
    unlight(W.edges['b-b1']); unlight(W.edges['b-b2']);
    ct.textContent = '6'; unlocked = false;
    schedule(4200, fire);
  }
  function schedule(ms, fn) {
    clearTimeout(cycleT);
    cycleT = setTimeout(() => {
      if (!autoplay) return;
      if (!visible || document.hidden) { schedule(1500, fn); return; } // wait for an audience
      fn();
    }, ms);
  }
  function arrival() {                                // #14 — #3's constants, no toast
    build(true);
    K.T(200, () => {
      W.nodes.r.classList.remove('pre'); W.nodes.r._label && W.nodes.r._label.classList.remove('pre');
      W.nodes.r.classList.add('nd--wake'); K.T(300, () => W.nodes.r.classList.add('nd--crown'));
      plq.classList.add('in');
    });
    for (const d of [1, 2, 3]) {
      const T0 = 200 + d * 320;                       // the 320ms cadence, ±60ms seeded jitter
      Object.keys(ND).forEach(id => { if (ND[id].ring !== d) return;
        K.T(T0 + jit(id), () => { const nd = W.nodes[id]; nd.classList.remove('pre');
          nd._label && nd._label.classList.remove('pre');
          nd.classList.add('nd--wake'); K.T(520, () => nd.classList.remove('nd--wake')); }); });
      for (const k in W.edges) { if (W.edges[k].ring === d) K.T(T0 - 60, () => W.edges[k].base.style.opacity =
        W.edges[k].base.getAttribute('stroke') === EDGE_LIT ? .9 : .8); }
    }
    schedule(4600, fire);                             // settle, breathe, then the moment
  }

  if (PRM) {                                          // reduced: no cascade, no loop; click still works
    build(false); plq.classList.add('in');
  } else {
    setTimeout(arrival, 500);
  }
  return {
    setAutoplay(b) {
      autoplay = b && !PRM;
      if (!autoplay) clearTimeout(cycleT);
      else if (!unlocked) schedule(2400, fire);
      else schedule(6000, reset);
    },
  };
}

// ============================================================
//    HOW-IT-WORKS beats — three small worlds, one beat each.
//    Play on scroll-into-view, replay on click. Finite always.
// ============================================================
const BEAT_W = 320, BEAT_H = 190;
const beatDefs = {
  plant: {  // ceremony #3 in miniature: rings enter on the cadence
    nodes: {
      r:  { name: '', k: 'terracotta', x: 160, y: 96, ring: 0, crown: true },
      a:  { name: '', k: 'olive', x: 92,  y: 52,  ring: 1 }, b: { name: '', k: 'sky',  x: 228, y: 50,  ring: 1 },
      c:  { name: '', k: 'gold',  x: 84,  y: 142, ring: 1 }, d: { name: '', k: 'brick', x: 234, y: 144, ring: 1 },
      a1: { name: '', k: 'olive', x: 40,  y: 92,  ring: 2 }, b1: { name: '', k: 'sky', x: 282, y: 92, ring: 2 },
      d1: { name: '', k: 'brick', x: 196, y: 178, ring: 2 },
    },
    edges: [['r','a'],['r','b'],['r','c'],['r','d'],['a','a1'],['b','b1'],['d','d1']],
    rest:  { r:'done', a:'avail', b:'avail', c:'avail', d:'avail', a1:'dim', b1:'dim', d1:'dim' },
    play(K, W, defs) {
      const jit = id => (hashStr(id) % 81) - 40;
      W.nodes.r.classList.remove('pre'); W.nodes.r.classList.add('nd--wake');
      K.T(300, () => W.nodes.r.classList.add('nd--crown'));
      for (const d of [1, 2]) {
        const T0 = d * 320;
        Object.keys(defs.nodes).forEach(id => { if (defs.nodes[id].ring !== d) return;
          K.T(T0 + jit(id), () => { W.nodes[id].classList.remove('pre');
            W.nodes[id].classList.add('nd--wake'); K.T(520, () => W.nodes[id].classList.remove('nd--wake')); }); });
        for (const k in W.edges) if (W.edges[k].ring === d) K.T(T0 - 60, () => W.edges[k].base.style.opacity =
          W.edges[k].base.getAttribute('stroke') === EDGE_LIT ? .9 : .8);
      }
    },
  },
  finish: { // the bloom: one step ripens
    nodes: {
      p: { name: 'Prime the walls', k: 'olive', x: 66,  y: 74,  ring: 0 },
      q: { name: 'Paint',           k: 'terracotta', x: 168, y: 96, ring: 1 },
      t: { name: 'Hang the shelf',  k: 'gold',  x: 268, y: 66,  ring: 2 },
    },
    edges: [['p','q'],['q','t']],
    rest: { p: 'done', q: 'avail', t: 'dim' },
    labels: ['p','q','t'],
    play(K, W) {
      K.T(500, () => {
        W.setSt('q', 'done');
        K.T(80, () => { W.nodes.q.classList.add('nd--blossom'); K.T(560, () => W.nodes.q.classList.remove('nd--blossom')); });
      });
    },
  },
  unlock: { // the travel: light runs the branch, the frontier wakes
    nodes: {
      p:  { name: 'Rig the mast',   k: 'terracotta', x: 84, y: 98, ring: 0 },
      c1: { name: 'Sail trim',      k: 'terracotta', x: 236, y: 46,  ring: 1 },
      c2: { name: 'Points of sail', k: 'terracotta', x: 248, y: 148, ring: 1 },
    },
    edges: [['p','c1'],['p','c2']],
    rest: { p: 'avail', c1: 'dim', c2: 'dim' },
    labels: ['p','c1','c2'],
    play(K, W) {
      K.T(500, () => {
        W.setSt('p', 'done');
        K.T(80, () => { W.nodes.p.classList.add('nd--blossom'); K.T(560, () => W.nodes.p.classList.remove('nd--blossom')); });
        K.T(280, () => ['p-c1', 'p-c2'].forEach(k =>
          travel(K, W.edges[k], 340, () => { const id = W.edges[k].dst; W.setSt(id, 'avail');
            W.nodes[id].classList.add('nd--wake'); K.T(520, () => W.nodes[id].classList.remove('nd--wake')); })));
        K.T(1130, () => ['c1', 'c2'].forEach(id => { W.nodes[id].classList.add('nd--echo');
          K.T(2450, () => W.nodes[id].classList.remove('nd--echo')); }));
      });
    },
  },
};
export function mountBeat(stage, kind) {
  const defs = beatDefs[kind];
  const K = mkKit();
  const o = { w: BEAT_W, h: BEAT_H, s: 1, ox: 0, oy: 0, nodes: defs.nodes, edges: defs.edges,
              sizes: [24, 19, 15, 13], labelSizes: [11.5, 11.5, 11, 11],
              labels: defs.labels || 'none' };
  stage.style.cssText += `position:relative; width:${BEAT_W}px; height:${BEAT_H}px;`;
  let W, played = false;
  function build(pre) {
    K.clear(); stage.innerHTML = '';
    W = buildWorld(stage, Object.assign({ states: Object.assign({}, defs.rest) }, o, { pre }));
    for (const k in W.edges) W.edges[k].NDS = defs.nodes;
  }
  function play() {
    if (PRM) { build(false); endState(); return; }
    build(kind === 'plant');
    defs.play(K, W, defs);
  }
  function endState() { // reduced motion: rest at the story's end
    if (kind === 'finish') W.setSt('q', 'done');
    if (kind === 'unlock') { W.setSt('p', 'done'); W.setSt('c1', 'avail'); W.setSt('c2', 'avail');
      for (const k in W.edges) { W.edges[k].base.setAttribute('stroke', EDGE_LIT); W.edges[k].base.setAttribute('stroke-width', 2.2); } }
  }
  const io = new IntersectionObserver(en => {
    if (en[0].isIntersecting && !played) { played = true; play(); }
    if (!en[0].isIntersecting) played = false;      // replay on return
  }, { threshold: .5 });
  build(true); io.observe(stage);
  stage.addEventListener('click', play);
}

// ============================================================
//    QUEST THUMBS — seed packets (F5 §2): the quest's layout,
//    fresh tiers — root haloed + first ring lit, the rest dim.
//    Static; nothing on the shelf animates at rest.
// ============================================================
const TH_W = 236, TH_H = 128;
function mkQuestWorld(seed, r1, r2, hues) {
  const nodes = { r: { name: '', k: hues[0], x: TH_W / 2, y: TH_H / 2, ring: 0, halo: true } };
  const edges = [];
  const rnd = n => (hashStr(seed + ':' + n) % 1000) / 1000;
  for (let i = 0; i < r1; i++) {
    const a = (i / r1) * Math.PI * 2 + rnd('a' + i) * .5 - .25;
    const rr = 34 + rnd('r' + i) * 8;
    nodes['p' + i] = { name: '', k: hues[(i + 1) % hues.length], ring: 1,
      x: TH_W / 2 + Math.cos(a) * rr * 1.55, y: TH_H / 2 + Math.sin(a) * rr };
    edges.push(['r', 'p' + i]);
  }
  for (let i = 0; i < r2; i++) {
    const pi = i % r1, p = nodes['p' + pi];
    const a = Math.atan2(p.y - TH_H / 2, (p.x - TH_W / 2) / 1.55) + (rnd('b' + i) - .5) * 1.1;
    const rr = 26 + rnd('s' + i) * 10;
    nodes['q' + i] = { name: '', k: hues[(i + 2) % hues.length], ring: 2,
      x: Math.max(12, Math.min(TH_W - 12, p.x + Math.cos(a) * rr * 1.35)),
      y: Math.max(10, Math.min(TH_H - 10, p.y + Math.sin(a) * rr)) };
    edges.push(['p' + pi, 'q' + i]);
  }
  const states = { r: 'avail' };
  for (let i = 0; i < r1; i++) states['p' + i] = 'avail';
  for (let i = 0; i < r2; i++) states['q' + i] = 'dim';
  return { nodes, edges, states };
}
const QUESTS = {
  frontend: { r1: 5, r2: 8, hues: ['terracotta', 'sky', 'gold'] },
  rust:     { r1: 5, r2: 7, hues: ['brick', 'olive', 'gold'] },
  ml:       { r1: 6, r2: 8, hues: ['plum', 'sky', 'olive'] },
  ship:     { r1: 4, r2: 6, hues: ['terracotta', 'sky', 'gold'] },
};
export function mountThumb(stage, quest) {
  const q = QUESTS[quest];
  const w = mkQuestWorld(quest, q.r1, q.r2, q.hues);
  stage.style.cssText += `position:relative; width:${TH_W}px; height:${TH_H}px;`;
  buildWorld(stage, { w: TH_W, h: TH_H, s: 1, ox: 0, oy: 0, nodes: w.nodes, edges: w.edges,
    states: w.states, sizes: [15, 10, 7, 6], labels: 'none' });
}

export { KIND };
