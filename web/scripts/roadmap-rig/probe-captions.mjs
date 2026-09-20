// Attaches to a Chrome left up by `capture.mjs --keep`, shows all steps, then focuses and selects <select>, and at
// each stop lists the visible captions with their rects and the overlapping pairs among them.
//   node --experimental-websocket probe-captions.mjs <cdp-port> [<select-node-id>]
const port = Number(process.argv[2]);
const selectId = process.argv[3] ?? 'skilltree-scene';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (fn) => { const r = await send('Runtime.evaluate', { expression: `(() => { try { return JSON.stringify((${fn})()); } catch (e) { return JSON.stringify({ __error: String(e.stack || e) }); } })()`, returnByValue: true, awaitPromise: true }); return JSON.parse(r.result.value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPTIONS = `() => {
  const s = window.__rig.scene();
  // Visible as the eye sees it: main toggles display, this build toggles visibility + opacity through st-label--shown.
  const visible = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0; };
  const labels = [...document.querySelectorAll('.st-label')].filter(visible).map((el) => { const r = el.getBoundingClientRect(); return { text: el.textContent.slice(0, 48), left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
  const ov = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const overlaps = [];
  for (let i = 0; i < labels.length; i += 1) for (let j = i + 1; j < labels.length; j += 1) if (ov(labels[i], labels[j])) overlaps.push([labels[i].text, labels[j].text]);
  return { zoom: s.camera.zoom, insets: s.camera.insets, selectedId: s.selectedId, captions: labels.length, overlaps, texts: labels.map((l) => l.text) };
}`;

await ev(`() => { const s = window.__rig.scene(); s.select(null); s.fitToView(); return true; }`);
await sleep(900);
console.log('all steps', JSON.stringify(await ev(CAPTIONS), null, 1));
await ev(`() => { const s = window.__rig.scene(); s.focusWorking(${JSON.stringify(selectId)}); return true; }`);
await sleep(1200);
await ev(`() => { const s = window.__rig.scene(); s.select(${JSON.stringify(selectId)}); return true; }`);
await sleep(1200);
console.log('focused + selected', JSON.stringify(await ev(CAPTIONS), null, 1));
ws.close();
