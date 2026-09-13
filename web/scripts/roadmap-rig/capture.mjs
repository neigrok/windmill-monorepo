// Raw-CDP headless Chrome driver for the roadmap readability rig. No dependencies; Node 20 needs
// `--experimental-websocket`.
//
//   node --experimental-websocket capture.mjs --origin http://localhost:5173 --tree <id> --cookie <wm_session> --out <dir>
//        [--width 1440 --height 900] [--phone] [--select <nodeId>] [--reduced-motion] [--chrome <path>] [--port 9222]
//        [--keep]   (leave Chrome running for inspection)
//        [--layout <name>]  open the app with ?layout=<name> before the hash, so that engine lays the tree out
//        [--focus]  the working capture presses the Focus control (.st-view-action "Focus"), else calls
//              scene.focusWorking(); the selected capture first brings <select> on screen (--select-focus);
//              allsteps.png follows after All steps. Shorthand for
//              --focus-selector .st-view-action --focus-text Focus --focus-api focusWorking --select-focus
//   The session cookie may also come from WM_RIG_COOKIE; the cookie and user id files never live in the repo.
//        [--focus-selector <css> [--focus-text <text>]]  click that DOM control (real pointer/touch) for the
//              working capture instead of scene.focusNode — for builds that ship a Focus button
//        [--focus-api <sceneMethod>]  e.g. focusSteps: call scene.<method>() for the working capture when the
//              selector matched nothing (or no selector was given) — the build's own Focus path, sans button
//        [--select-focus]  before the selected click, scene.focusNode(<select>) so the node is on screen
//              at the build's working zoom (needed when Focus centres somewhere else)
//        [--caption-mode scaled|fixed]  scaled (default, main): caption px = 56×0.23×zoom, so
//              zoomFromCaptionFont is meaningful; fixed: captions are CSS-px constants, zoom is
//              read from scene.camera.zoom only and the main-only label offsets are nulled
//
// Writes into <out>: overview.png + overview.json (initial camera), working.png + working.json (the
// build's readable camera — on main that is scene.focusNode(<select>), the API behind the Next-up
// glide / camera.focus, zoom = max(current, FOCUS_MIN_ZOOM 0.6)), selected.png + selected.json (a real
// pointer click / touch tap on <select> at that working camera, so the app's own selection path
// runs), with --focus allsteps.png + allsteps.json (after All steps, plus `taps`: a real tap on
// <select>'s dot at the fit and one 8 px beside it, each recorded as selected / zoomed / missed),
// measures.json (every capture), error.txt when the tree failed to load, and settle.json (how the
// wait for a painted, settled scene went).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) { args[a.slice(2)] = next; i += 1; } else args[a.slice(2)] = true;
}
const need = (k) => { if (!args[k]) { console.error(`--${k} is required`); process.exit(2); } return args[k]; };
const origin = need('origin').replace(/\/$/, '');
const treeId = need('tree');
const cookie = args.cookie ?? process.env.WM_RIG_COOKIE ?? need('cookie');
const outDir = need('out');
const phone = !!args.phone;
const width = Number(args.width ?? (phone ? 390 : 1440));
const height = Number(args.height ?? (phone ? 844 : 900));
const dpr = Number(args.dpr ?? (phone ? 3 : 1));
const selectId = args.select ?? 'skilltree-scene';
const reducedMotion = !!args['reduced-motion'];
const chromePath = args.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const debugPort = Number(args.port ?? 9222);
const layoutName = args.layout ?? null;
const focusVerb = !!args.focus;
const focusSelector = args['focus-selector'] ?? (focusVerb ? '.st-view-action' : null);
const focusText = args['focus-text'] ?? (focusVerb ? 'Focus' : null);
const focusApi = args['focus-api'] ?? (focusVerb ? 'focusWorking' : null); // called on the scene when no DOM control matched (or no selector given)
const selectFocus = !!args['select-focus'] || focusVerb;
const captionMode = args['caption-mode'] ?? 'scaled';
if (!['scaled', 'fixed'].includes(captionMode)) { console.error('--caption-mode must be scaled or fixed'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(path.join(outDir, 'error.txt'), { force: true }); // a stale failure must never sit beside a complete capture
const profileDir = fs.mkdtempSync(path.join(outDir, '.chrome-profile-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Chrome ------------------------------------------------------------------------------------
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeLog = '';
chrome.stdout.on('data', (d) => { chromeLog += d; });
chrome.stderr.on('data', (d) => { chromeLog += d; });
process.on('exit', () => { if (!args.keep) chrome.kill('SIGKILL'); });

async function pageTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`Chrome did not expose a page target on ${debugPort}\n${chromeLog}`);
}

// ---- minimal CDP client -----------------------------------------------------------------------
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { res, rej } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`)); else res(msg.result);
      } else if (msg.method) {
        for (const fn of cdp.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
  waitFor(method, timeoutMs = 20000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeoutMs);
      this.on(method, (p) => { clearTimeout(t); res(p); });
    });
  }
  close() { this.ws.close(); }
}

// Everything the page returns comes back as a JSON string (returnByValue chokes on DOM objects).
async function evalJson(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression: `(() => { try { return JSON.stringify((${expression})()); } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description ?? '')}`);
  const v = r.result.value;
  return v === undefined ? undefined : JSON.parse(v);
}

// ---- page-side helpers (injected once) --------------------------------------------------------
const PAGE_HELPERS = `
window.__rig = window.__rig || {};
// The live scene through the React fiber of the canvas: walk up the fiber tree, scanning each
// component's hook chain for a useState value or a useRef current that looks like SkillTreeScene.
window.__rig.findScene = function () {
  const canvas = document.querySelector('canvas.st-canvas');
  if (!canvas) return { scene: null, method: 'no canvas' };
  const key = Object.keys(canvas).find((k) => k.startsWith('__reactFiber$'));
  if (!key) return { scene: null, method: 'no fiber key on canvas' };
  const looksLikeScene = (v) => v && typeof v === 'object' && v.camera && typeof v.camera.zoom === 'number' && v.renderModel !== undefined;
  let fiber = canvas[key];
  let hops = 0;
  while (fiber && hops < 60) {
    let hook = fiber.memoizedState;
    let guard = 0;
    while (hook && typeof hook === 'object' && 'memoizedState' in hook && guard < 200) {
      const v = hook.memoizedState;
      if (looksLikeScene(v)) return { scene: v, method: 'fiber useState (' + hops + ' hops up)' };
      if (v && typeof v === 'object' && looksLikeScene(v.current)) return { scene: v.current, method: 'fiber useRef (' + hops + ' hops up)' };
      hook = hook.next; guard += 1;
    }
    fiber = fiber.return; hops += 1;
  }
  return { scene: null, method: 'not found in ' + hops + ' fiber hops' };
};
window.__rig.scene = function () { return window.__rig.findScene().scene; };
`;

async function installHelpers(cdp) {
  await cdp.send('Runtime.evaluate', { expression: PAGE_HELPERS, returnByValue: true });
}

// ---- measurement ------------------------------------------------------------------------------
const NODE_SIZE = 56; // theme.js — a node is NODE_SIZE world units across
const LABEL_FONT_FRACTION = 0.23; // NodeOverlay.js LABEL_FONT_FRACTION (caption px = NODE_SIZE * 0.23 * zoom on main)
const BODY_EDGE = 0.84; // NodeBatch.js EDGE — body radius in centered space, i.e. body diameter = NODE_SIZE * 0.84 * zoom
const CROWN_EMPHASIS = 1.55; // NodeBatch vertex: size *= 1 + emphasis * 0.55 for the crowned root

const MEASURE = `() => {
  const out = { viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio } };
  out.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = document.querySelector('canvas.st-canvas');
  const canvasRect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  out.canvas = canvas ? { cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, backing: [canvas.width, canvas.height], left: canvasRect.left, top: canvasRect.top } : null;
  const err = document.querySelector('.st-load-error');
  out.errorText = err ? err.textContent.trim() : null;
  const found = window.__rig.findScene();
  out.sceneMethod = found.method;
  const scene = found.scene;
  const vw = window.innerWidth, vh = window.innerHeight;

  // Captions: every pooled .st-label the eye can see (main toggles display; this build toggles visibility + opacity
  // through st-label--shown) whose rect touches the viewport.
  const visible = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 && el.offsetParent !== null; };
  const labelEls = [...document.querySelectorAll('.st-label')].filter(visible);
  const labels = labelEls.map((el) => {
    const r = el.getBoundingClientRect();
    return { text: el.textContent, font: parseFloat(getComputedStyle(el).fontSize), x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  }).filter((l) => l.w > 0 && l.right > 0 && l.bottom > 0 && l.x < vw && l.y < vh);
  const fonts = labels.map((l) => l.font).sort((a, b) => a - b);
  const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : null;
  out.captions = { count: labels.length, pooled: labelEls.length, fontMin: fonts[0] ?? null, fontMedian: q(fonts, 0.5), fontMax: fonts[fonts.length - 1] ?? null,
    containerOpacity: (document.querySelector('.st-labels') || {}).style?.opacity ?? null,
    summaryCount: labelEls.filter((el) => el.classList.contains('st-label--summary')).length,
    anchorCount: labelEls.filter((el) => el.classList.contains('st-label--anchor')).length,
    selectedStyled: labelEls.filter((el) => el.classList.contains('st-label--selected')).map((el) => el.textContent),
    twoLine: labels.filter((l) => l.text.includes('\\n')).length,
    poolElements: document.querySelectorAll('.st-label').length };
  const overlaps = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
  let captionPairs = 0; const pairSamples = [];
  for (let i = 0; i < labels.length; i += 1) for (let j = i + 1; j < labels.length; j += 1) if (overlaps(labels[i], labels[j])) { captionPairs += 1; if (pairSamples.length < 8) pairSamples.push([labels[i].text, labels[j].text]); }
  out.captions.overlappingPairs = captionPairs;
  out.captions.overlapSamples = pairSamples;
  out.captions.samples = labels.slice(0, 6).map((l) => ({ text: l.text, font: l.font, w: Math.round(l.w), h: Math.round(l.h) }));

  if (!scene || !scene.renderModel) { out.scene = null; return out; }
  const cam = scene.camera;
  out.camera = { x: cam.x, y: cam.y, zoom: cam.zoom, viewportWidth: cam.viewportWidth, viewportHeight: cam.viewportHeight, gliding: !!cam.glide };
  out.zoomSource = 'scene.camera.zoom (read directly off the live Camera2D)';
  out.zoomFromCaptionFont = ${captionMode === 'scaled'} && fonts.length ? q(fonts, 0.5) / (${NODE_SIZE} * ${LABEL_FONT_FRACTION}) : null;
  out.captionMode = ${JSON.stringify(captionMode)};
  out.director = { busy: scene.director ? scene.director.busy() : null };
  out.settleActive = !!(scene.settle && (scene.settle.moves?.length || scene.settle.active));
  const z = cam.zoom;
  const bodyPx = ${NODE_SIZE} * ${BODY_EDGE} * z;
  out.bodyDiameterPx = { ordinary: bodyPx, crownedRoot: bodyPx * ${CROWN_EMPHASIS}, selected: bodyPx * 1.14,
    labelOffsetPx: ${captionMode === 'scaled'} ? ${NODE_SIZE} * 0.62 * z : null,
    labelGapAboveCaptionPx: ${captionMode === 'scaled'} ? (${NODE_SIZE} * 0.62 - ${NODE_SIZE} * ${BODY_EDGE} / 2) * z : null };

  // Every node in screen space.
  // Viewport coordinates (canvas offset added), so they compare with the caption rects.
  const nodes = scene.renderModel.nodes.map((n) => ({ id: n.id, label: n.label, state: n.state, emphasis: n.emphasis, sx: (n.x - cam.x) * z + cam.viewportWidth / 2 + canvasRect.left, sy: (n.y - cam.y) * z + cam.viewportHeight / 2 + canvasRect.top }));
  const onScreen = nodes.filter((n) => n.sx >= -bodyPx && n.sx <= vw + bodyPx && n.sy >= -bodyPx && n.sy <= vh + bodyPx);
  out.nodes = { total: nodes.length, onScreen: onScreen.length, states: {} };
  for (const n of nodes) out.nodes.states[n.state] = (out.nodes.states[n.state] || 0) + 1;
  const selectedId = scene.selectedId ?? null;
  out.selectedId = selectedId;
  const sel = selectedId ? nodes.find((n) => n.id === selectedId) : null;
  out.selected = sel ? { id: sel.id, label: sel.label, sx: sel.sx, sy: sel.sy, onScreen: sel.sx >= 0 && sel.sx <= vw && sel.sy >= 0 && sel.sy <= vh,
    captionVisible: labels.some((l) => l.text === sel.label) } : null;

  // Captions overlapping a node body (another node's disc; own disc counted separately).
  const byLabel = new Map(); for (const n of nodes) { if (!byLabel.has(n.label)) byLabel.set(n.label, []); byLabel.get(n.label).push(n); }
  const rectHitsDisc = (l, n, r) => { const cx = Math.max(l.x, Math.min(n.sx, l.right)); const cy = Math.max(l.y, Math.min(n.sy, l.bottom)); return (cx - n.sx) ** 2 + (cy - n.sy) ** 2 < r * r; };
  let captionOverOtherBody = 0, captionOverOwnBody = 0;
  for (const l of labels) {
    const owners = byLabel.get(l.text) ?? [];
    let other = false, own = false;
    for (const n of onScreen) {
      const r = (bodyPx / 2) * (n.emphasis === 1 ? ${CROWN_EMPHASIS} : 1) * (n.id === selectedId ? 1.14 : 1);
      if (!rectHitsDisc(l, n, r)) continue;
      if (owners.includes(n)) own = true; else other = true;
    }
    if (other) captionOverOtherBody += 1;
    if (own) captionOverOwnBody += 1;
  }
  out.captions.overlappingOtherBody = captionOverOtherBody;
  out.captions.overlappingOwnBody = captionOverOwnBody;

  // Nearest-neighbour distance in screen px: among labelled on-screen nodes, and among all on-screen nodes.
  const nn = (set, pool) => {
    const d = [];
    for (const a of set) { let best = Infinity; for (const b of pool) { if (b === a) continue; const dd = Math.hypot(a.sx - b.sx, a.sy - b.sy); if (dd < best) best = dd; } if (best < Infinity) d.push(best); }
    d.sort((x, y) => x - y);
    return { count: d.length, p10: q(d, 0.1), median: q(d, 0.5), p90: q(d, 0.9), min: d[0] ?? null };
  };
  const labelTexts = new Set(labels.map((l) => l.text));
  const labelled = onScreen.filter((n) => labelTexts.has(n.label));
  out.nearestNeighbourPx = { labelledToLabelled: nn(labelled, labelled), labelledToAny: nn(labelled, onScreen), anyToAny: nn(onScreen, onScreen), inBodyDiameters: null };
  if (out.nearestNeighbourPx.anyToAny.median != null) out.nearestNeighbourPx.inBodyDiameters = { anyMedian: out.nearestNeighbourPx.anyToAny.median / bodyPx, labelledMedian: out.nearestNeighbourPx.labelledToLabelled.median == null ? null : out.nearestNeighbourPx.labelledToLabelled.median / bodyPx };

  // Tree screen bounds vs viewport.
  const b = scene.renderModel.bounds;
  const bx0 = (b.minX - cam.x) * z + cam.viewportWidth / 2 + canvasRect.left, bx1 = (b.maxX - cam.x) * z + cam.viewportWidth / 2 + canvasRect.left;
  const by0 = (b.minY - cam.y) * z + cam.viewportHeight / 2 + canvasRect.top, by1 = (b.maxY - cam.y) * z + cam.viewportHeight / 2 + canvasRect.top;
  const ix = Math.max(0, Math.min(bx1, vw) - Math.max(bx0, 0)), iy = Math.max(0, Math.min(by1, vh) - Math.max(by0, 0));
  out.treeBounds = { world: b, screen: { x0: bx0, y0: by0, x1: bx1, y1: by1, w: bx1 - bx0, h: by1 - by0 }, viewportFractionCovered: (ix * iy) / (vw * vh), treeFractionInsideViewport: (ix * iy) / Math.max(1, (bx1 - bx0) * (by1 - by0)) };
  return out;
}`;

// ---- wait for a painted, settled scene --------------------------------------------------------
async function waitForScene(cdp, label) {
  const t0 = Date.now();
  const log = [];
  let last = null;
  let stableSince = null;
  for (let i = 0; i < 600; i += 1) {
    const s = await evalJson(cdp, `() => {
      const err = document.querySelector('.st-load-error');
      const found = window.__rig.findScene();
      const scene = found.scene;
      return { error: err ? err.textContent.trim() : null, hasCanvas: !!document.querySelector('canvas.st-canvas'), method: found.method,
        nodes: scene && scene.renderModel ? scene.renderModel.nodes.length : 0,
        busy: scene && scene.director ? scene.director.busy() : null,
        gliding: scene ? !!scene.camera.glide : null,
        camera: scene ? [scene.camera.x, scene.camera.y, scene.camera.zoom] : null,
        settling: scene && scene.settle ? !!(scene.settle.moves && scene.settle.moves.length) : false,
        listView: !!document.querySelector('.st-list, .lv-root, [data-view="list"]') };
    }`);
    if (s.error) { fs.writeFileSync(path.join(outDir, 'error.txt'), s.error); log.push({ t: Date.now() - t0, ...s }); return { ok: false, error: s.error, log }; }
    const ready = s.hasCanvas && s.nodes > 0 && s.busy === false && !s.gliding && !s.settling;
    const same = last && s.camera && last.camera && s.camera.every((v, k) => Math.abs(v - last.camera[k]) < 1e-6);
    if (ready && same) { if (stableSince === null) stableSince = Date.now(); } else stableSince = null;
    if (i % 5 === 0 || ready) log.push({ t: Date.now() - t0, nodes: s.nodes, busy: s.busy, gliding: s.gliding, settling: s.settling, camera: s.camera });
    if (ready && stableSince !== null && Date.now() - stableSince >= 600) {
      const waited = Date.now() - t0;
      return { ok: true, waitedMs: waited, method: s.method, log };
    }
    last = s;
    await sleep(200);
  }
  return { ok: false, error: 'timeout: scene never settled', log };
}

// After a camera gesture: no glide, no settle, director idle, camera byte-stable for `stableMs`.
async function waitStable(cdp, stableMs = 600, timeoutMs = 10000) {
  const t0 = Date.now();
  let last = null;
  let stableSince = null;
  while (Date.now() - t0 < timeoutMs) {
    const s = await evalJson(cdp, `() => { const sc = window.__rig.scene(); return sc === null ? null : { gliding: !!sc.camera.glide, busy: sc.director ? sc.director.busy() : false, settling: !!(sc.settle && sc.settle.moves && sc.settle.moves.length), camera: [sc.camera.x, sc.camera.y, sc.camera.zoom] }; }`);
    if (!s || !s.camera) return { ok: false, waitedMs: Date.now() - t0, error: 'the scene went away mid-wait', camera: last };
    const idle = !s.gliding && !s.busy && !s.settling;
    const same = last && s.camera.every((v, k) => Math.abs(v - last[k]) < 1e-6);
    if (idle && same) { if (stableSince === null) stableSince = Date.now(); } else stableSince = null;
    if (idle && stableSince !== null && Date.now() - stableSince >= stableMs) return { ok: true, waitedMs: Date.now() - t0, camera: s.camera };
    last = s.camera;
    await sleep(100);
  }
  return { ok: false, waitedMs: Date.now() - t0, camera: last };
}

// A real pointer click / touch tap at the centre of the first VISIBLE element matching the selector (and text, when given).
async function clickControl(cdp, selector, text) {
  const target = await evalJson(cdp, `() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => {
      if (${JSON.stringify(text)} !== null && el.textContent.trim() !== ${JSON.stringify(text)}) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    });
    if (!els.length) return { found: 0 };
    const r = els[0].getBoundingClientRect();
    return { found: els.length, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, text: els[0].textContent.trim(), tag: els[0].tagName, className: els[0].className };
  }`);
  if (!target.found) return { clicked: false, target };
  const tap = await pointerTap(cdp, target.x, target.y);
  return { clicked: true, ...tap, target };
}

// One real touch tap (phone) or mouse click (desktop) at a viewport point, through the browser's own input path.
async function pointerTap(cdp, atX, atY) {
  const x = Math.round(atX), y = Math.round(atY);
  if (phone) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return { kind: 'touch tap', x, y };
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { kind: 'mouse click', x, y };
}

// The screen position of a node at the current camera, in viewport px; null when the model lacks it.
async function nodeScreenPosition(cdp, nodeId) {
  return evalJson(cdp, `() => { const s = window.__rig.scene(); const n = s.nodesById.get(${JSON.stringify(nodeId)}); if (!n) return null; const c = s.camera; const r = document.querySelector('canvas.st-canvas').getBoundingClientRect(); return { x: (n.x - c.x) * c.zoom + c.viewportWidth / 2 + r.left, y: (n.y - c.y) * c.zoom + c.viewportHeight / 2 + r.top, zoom: c.zoom }; }`);
}

// A tap on the tree at the whole-tree fit must select the step under it or zoom in toward it — never miss.
// `dx` offsets the tap from the node's centre, the way a finger lands beside a dot.
async function fitTap(cdp, nodeId, dx) {
  const before = await evalJson(cdp, `() => { const s = window.__rig.scene(); s.select(null); s.fitToView(); return { zoom: s.camera.zoom, selectedId: s.selectedId ?? null }; }`);
  await waitStable(cdp);
  const pos = await nodeScreenPosition(cdp, nodeId);
  if (!pos) return { outcome: 'no such node' };
  const tap = await pointerTap(cdp, pos.x + dx, pos.y);
  await sleep(400);
  const stable = await waitStable(cdp);
  const after = await evalJson(cdp, `() => { const s = window.__rig.scene(); return { zoom: s.camera.zoom, selectedId: s.selectedId ?? null }; }`);
  const outcome = after.selectedId !== null ? 'selected' : after.zoom > before.zoom * 1.01 ? 'zoomed' : 'missed';
  return { ...tap, offsetPx: dx, before, after, stable, outcome };
}

async function shot(cdp, name) {
  // Two animation frames so the GPU canvas has painted the camera we just set.
  await evalJson(cdp, `() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  const png = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(png.data, 'base64'));
  const m = await evalJson(cdp, MEASURE);
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(m, null, 2));
  return m;
}

// ---- run ---------------------------------------------------------------------------------------
const measures = { build: { origin, treeId, layout: layoutName, viewport: { width, height, dpr, phone }, selectId, reducedMotionEmulated: reducedMotion, chromeVersion: null } };
try {
  const target = await pageTarget();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const version = await cdp.send('Browser.getVersion');
  measures.build.chromeVersion = version.product;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  const consoleLog = [];
  const stamp = () => new Date().toISOString();
  cdp.on('Runtime.consoleAPICalled', (p) => consoleLog.push({ at: stamp(), source: 'console', type: p.type, text: p.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 2000) }));
  cdp.on('Runtime.exceptionThrown', (p) => consoleLog.push({ at: stamp(), source: 'exception', text: (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text ?? '').slice(0, 4000), url: p.exceptionDetails.url, line: p.exceptionDetails.lineNumber }));
  cdp.on('Log.entryAdded', (p) => consoleLog.push({ at: stamp(), source: p.entry.source, level: p.entry.level, text: String(p.entry.text).slice(0, 2000), url: p.entry.url }));
  const flushConsole = () => fs.writeFileSync(path.join(outDir, 'console.json'), JSON.stringify(consoleLog, null, 2));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: phone, screenWidth: width, screenHeight: height });
  if (phone) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  if (reducedMotion) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Network.setCookie', { name: 'wm_session', value: cookie, domain: 'localhost', path: '/' });

  // Load the app route once (a real document load from about:blank), write the per-tree view
  // preference so the phone opens the canvas rather than the owner's default list, clear any saved
  // camera, then reload so the route decides with those prefs in place. The profile is fresh, so
  // there is no saved place to begin with; the removeItem is belt and braces.
  const appUrl = `${origin}/${layoutName ? `?layout=${encodeURIComponent(layoutName)}` : ''}#/app/${treeId}`;
  const firstLoad = cdp.waitFor('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: appUrl });
  await firstLoad;
  await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('windmill:view:last', JSON.stringify({ ${JSON.stringify(treeId)}: 'tree' })); localStorage.removeItem('windmill:last-place');`, returnByValue: true });
  const secondLoad = cdp.waitFor('Page.loadEventFired');
  await cdp.send('Page.reload', { ignoreCache: false });
  await secondLoad;
  await sleep(300);
  const hashNow = await evalJson(cdp, `() => location.href`);
  if (!hashNow.includes(`#/app/${treeId}`)) throw new Error(`page is at ${hashNow}, not the app route`);
  await installHelpers(cdp);
  const settle = await waitForScene(cdp, 'overview');
  fs.writeFileSync(path.join(outDir, 'settle.json'), JSON.stringify(settle, null, 2));
  if (!settle.ok) {
    const body = await evalJson(cdp, `() => document.body.innerText`);
    fs.writeFileSync(path.join(outDir, 'error.txt'), `${settle.error}\n\n--- body text ---\n${body}`);
    await shot(cdp, 'overview');
    console.error('tree did not load:', settle.error);
    process.exitCode = 1;
  } else {
    measures.settle = { waitedMs: settle.waitedMs, sceneMethod: settle.method, note: reducedMotion ? 'prefers-reduced-motion emulated: ceremony snaps' : 'waited for director.busy()===false, no glide, no settle, camera stable 600ms' };
    measures.overview = await shot(cdp, 'overview');

    if (focusSelector || focusApi) {
      // A build with a Focus control: press it for real and let its own camera path (glide) run out.
      const before = await evalJson(cdp, `() => { const s = window.__rig.scene(); return { zoom: s.camera.zoom, inOverview: s.inOverview ?? null, selectedId: s.selectedId ?? null }; }`);
      let press = focusSelector ? await clickControl(cdp, focusSelector, focusText) : { clicked: false, target: { found: 0, reason: 'no --focus-selector given' } };
      if (!press.clicked && focusApi) {
        const called = await evalJson(cdp, `() => { const s = window.__rig.scene(); if (typeof s[${JSON.stringify(focusApi)}] !== 'function') return { called: false, reason: 'no such scene method' }; s[${JSON.stringify(focusApi)}](); return { called: true }; }`);
        press = { ...press, api: `scene.${focusApi}()`, ...called, clicked: !!called.called, viaApi: true };
      }
      const stable = press.clicked ? await waitStable(cdp) : null;
      const after = await evalJson(cdp, `() => { const s = window.__rig.scene(); const c = s.camera; return { zoom: c.zoom, x: c.x, y: c.y, insets: c.insets ?? null, inOverview: s.inOverview ?? null, sceneSelectedId: s.selectedId ?? null, labelContextSelected: s.labelOverlay?.selectedId ?? null }; }`);
      measures.working = await shot(cdp, 'working');
      measures.working.how = { api: press.viaApi ? `scene.${focusApi}() (no DOM control matched${focusSelector ? ` ${focusSelector}` : ''})` : `real ${phone ? 'tap' : 'click'} on ${focusSelector}${focusText ? ` (text "${focusText}")` : ''}`, before, press, stable, after };
      if (!press.clicked) console.error('focus control not found and no API fallback fired:', JSON.stringify(press));
    } else {
      // Working camera: on main there is no Focus button; the readable camera the code offers is
      // scene.focusNode(id) (camera.focus → zoom raised to FOCUS_MIN_ZOOM 0.6 when below it).
      const focused = await evalJson(cdp, `() => { const s = window.__rig.scene(); const before = s.camera.zoom; s.focusNode(${JSON.stringify(selectId)}); return { before, after: s.camera.zoom, has: !!s.nodesById.get(${JSON.stringify(selectId)}) }; }`);
      await sleep(400);
      measures.working = await shot(cdp, 'working');
      measures.working.how = { api: 'scene.focusNode(id) → camera.focus(x, y): zoom = max(zoom, 0.6)', ...focused };
    }

    // Selected: at the working camera (focusNode leaves the camera on the node), drop the scene-side
    // selection and land a real pointer click / tap on the node so the app's own selection path runs
    // (NavigateTool.select → setSelectedId → StepPanel on desktop, the sheet on phone).
    let selectFocusHow = null;
    if (selectFocus) {
      const f = await evalJson(cdp, `() => { const s = window.__rig.scene(); const before = [s.camera.x, s.camera.y, s.camera.zoom]; s.focusNode(${JSON.stringify(selectId)}); return { before, after: [s.camera.x, s.camera.y, s.camera.zoom], has: !!s.nodesById.get(${JSON.stringify(selectId)}) }; }`);
      const stable = await waitStable(cdp);
      selectFocusHow = { api: 'scene.focusNode(id) before the click, so the node is on screen at the working zoom', ...f, stable };
    }
    await evalJson(cdp, `() => { const s = window.__rig.scene(); s.select(null); return true; }`);
    await sleep(300);
    const pos = await nodeScreenPosition(cdp, selectId);
    let clickHow = null;
    if (pos && pos.x >= 0 && pos.x <= width && pos.y >= 0 && pos.y <= height) {
      clickHow = { ...(await pointerTap(cdp, pos.x, pos.y)), atZoom: pos.zoom };
      await sleep(1200);
      const afterClick = (focusSelector || selectFocus) ? await waitStable(cdp) : null;
      const picked = await evalJson(cdp, `() => { const s = window.__rig.scene(); return { sceneSelected: s.selectedId ?? null, panelOpen: !!document.querySelector('.st-detail-panel--open'), sheet: !!document.querySelector('[class*="sheet"]'), cameraAfter: [s.camera.x, s.camera.y, s.camera.zoom] }; }`);
      clickHow.result = picked;
      if (afterClick) clickHow.settledAfterClick = afterClick;
      if (selectFocusHow) clickHow.selectFocus = selectFocusHow;
      if (picked.sceneSelected !== selectId) {
        await evalJson(cdp, `() => { window.__rig.scene().select(${JSON.stringify(selectId)}); return true; }`);
        await sleep(400);
        clickHow.fallback = 'scene.select(id) — the pointer click did not land on the node';
      }
    } else {
      await evalJson(cdp, `() => { window.__rig.scene().select(${JSON.stringify(selectId)}); return true; }`);
      await sleep(400);
      clickHow = { kind: 'scene.select(id)', reason: 'node off-screen at the working camera', pos, selectFocus: selectFocusHow };
    }
    measures.selected = await shot(cdp, 'selected');
    measures.selected.how = clickHow;

    if (focusVerb) {
      // All steps: the whole tree, pressed for real when the control is there, else the scene's own fit.
      let press = await clickControl(cdp, '.st-view-action', 'All steps');
      if (!press.clicked) {
        await evalJson(cdp, `() => { window.__rig.scene().fitToView(); return true; }`);
        press = { ...press, viaApi: true, api: 'scene.fitToView()' };
      }
      const stable = await waitStable(cdp);
      measures.allSteps = await shot(cdp, 'allsteps');
      measures.allSteps.how = { press, stable };
      // Hit floors at the fit: a tap on <select>'s dot, then one 8 px beside it, must each select or zoom — never miss.
      measures.allSteps.taps = { onNode: await fitTap(cdp, selectId, 0), besideNode: await fitTap(cdp, selectId, 8) };
    }
  }
  flushConsole();
  measures.console = { entries: consoleLog.length, errors: consoleLog.filter((e) => e.source === 'exception' || e.level === 'error' || e.type === 'error').length, file: 'console.json' };
  fs.writeFileSync(path.join(outDir, 'measures.json'), JSON.stringify(measures, null, 2));
  const brief = (m) => m ? `zoom=${m.camera?.zoom?.toFixed(4)} body=${m.bodyDiameterPx?.ordinary?.toFixed(1)}px captions=${m.captions?.count} font=${m.captions?.fontMedian} overlaps=${m.captions?.overlappingPairs} nnAny=${m.nearestNeighbourPx?.anyToAny?.median?.toFixed(1)} onScreen=${m.nodes?.onScreen}` : 'n/a';
  const taps = measures.allSteps?.taps ? ` taps: on=${measures.allSteps.taps.onNode.outcome} beside=${measures.allSteps.taps.besideNode.outcome}` : '';
  console.log(`overview: ${brief(measures.overview)}\nworking:  ${brief(measures.working)}\nselected: ${brief(measures.selected)}${measures.allSteps ? `\nallsteps: ${brief(measures.allSteps)}${taps}` : ''}`);
  if (!args.keep) cdp.close();
} catch (e) {
  fs.writeFileSync(path.join(outDir, 'error.txt'), `${e.stack}\n\n--- chrome log ---\n${chromeLog}`);
  console.error(e);
  process.exitCode = 1;
} finally {
  // Chrome may still be writing its profile as it dies; the retries outlast that.
  if (!args.keep) { chrome.kill('SIGKILL'); fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
