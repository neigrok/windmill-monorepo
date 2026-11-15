// Serializable browser callbacks: keep their dependencies inside the function body.
export async function settleVisuals({ timeoutMs = 10000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error('Invalid visual settlement timeout');
  let timer;
  let expired = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('Timed out waiting for visual settlement')); }, timeoutMs);
  });
  const settle = async () => {
    const fonts = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (![...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight)) continue;
      let visible = true;
      for (let element = node.parentElement; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) {
          visible = false;
          break;
        }
      }
      if (!visible) continue;
      const style = getComputedStyle(node.parentElement);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      fonts.set(font, (fonts.get(font) ?? '') + node.textContent);
    }
    await Promise.all([...fonts].map(([font, text]) => document.fonts.load(font, text)));
    await document.fonts.ready;
    if (expired) return;
    const animations = document.getAnimations().filter((animation) =>
      Number.isFinite(animation.effect?.getTiming().iterations) && Number.isFinite(animation.effect.getComputedTiming().endTime));
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
    if (expired) return;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { fonts: fonts.size, animations: animations.length, frames: 2 };
  };
  try {
    return await Promise.race([settle(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// CDP must await the callback before serializing its result, not serialize its Promise as {}.
export async function evalJson(cdp, expression) {
  const reply = await cdp.send('Runtime.evaluate', {
    expression: `(async () => JSON.stringify(await (${expression})()))()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (reply.exceptionDetails) throw new Error('Browser evaluation failed');
  const value = reply.result.value;
  return value === undefined ? undefined : JSON.parse(value);
}

export function installRoadmapObserver({ origins = [location.origin] } = {}) {
  if (!/^https?:$/.test(location.protocol) || self !== top) return;
  if (window.__roadmapProof) return;
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));
  const current = new Map();
  const writes = [];
  let generation = 0;
  let sockets = 0;
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      const url = new URL(this.url);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      this.proofPending = [];
      this.proofObserved = allowed.has(url.origin) && url.pathname === '/v1/socket';
      if (!this.proofObserved) return;
      sockets += 1;
      this.addEventListener('message', (event) => {
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame?.t !== 'subgraph' || frame.intent !== 'delta') return;
        const index = this.proofPending.findIndex((request) => request.treeId === frame.treeId);
        if (index < 0) return;
        const [request] = this.proofPending.splice(index, 1);
        if (current.get(frame.treeId) !== request) return;
        request.baseline = { treeId: frame.treeId, reach: frame.reach, generation: request.generation };
      });
      this.addEventListener('close', () => {
        for (const [treeId, request] of current) if (request.socket === this) current.delete(treeId);
      });
    }

    send(data) {
      super.send(data);
      if (!this.proofObserved) return;
      let frame;
      try { frame = JSON.parse(data); } catch { return; }
      if (frame?.t === 'subgraph' || frame?.t === 'progress') writes.push({ type: frame.t });
      if (frame?.t !== 'subscribe' || typeof frame.treeId !== 'string') return;
      const request = { treeId: frame.treeId, generation: ++generation, socket: this, baseline: null };
      this.proofPending.push(request);
      current.set(frame.treeId, request);
    }
  };
  window.__roadmapProof = {
    writes,
    get sockets() { return sockets; },
    async waitForBaseline({ treeId, reach, timeoutMs = 15000 }) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error('Invalid roadmap baseline timeout');
      const end = Date.now() + timeoutMs;
      do {
        const request = current.get(treeId);
        if (request?.socket.readyState === NativeWebSocket.OPEN && request.baseline
          && (reach === undefined || request.baseline.reach === reach)) return request.baseline;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, end - Date.now()))));
      } while (Date.now() < end);
      throw new Error('Timed out waiting for roadmap subscription baseline');
    },
  };
}

export function httpOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Expected an HTTP origin'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Expected an HTTP origin');
  }
  return url.origin;
}

export async function installReadOnlyGuard(context, { origins, sentryHosts = [] }) {
  const allowed = new Set(origins.map(httpOrigin));
  const localSentry = new Set(sentryHosts);
  const evidence = { blocked: { intake: 0, sentry: 0, analytics: 0 }, writes: [], clientErrors: 0 };
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const firstParty = allowed.has(url.origin);
    if (firstParty && url.pathname === '/v1/events') {
      evidence.blocked.intake += 1;
      let beacon;
      try { beacon = JSON.parse(request.postData() ?? ''); } catch { /* A malformed beacon is still intercepted. */ }
      if (Array.isArray(beacon?.events) && beacon.events.some((event) => event?.name === 'client_error')) evidence.clientErrors += 1;
      await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
      return;
    }
    if (/(^|\.)(sentry\.io|sentry\.invalid)$/.test(url.hostname) || localSentry.has(url.hostname)) {
      evidence.blocked.sentry += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    if ((/(^|\.)cloudflareinsights\.com$/.test(url.hostname) && !(request.method() === 'GET' && request.resourceType() === 'script'))
      || (firstParty && url.pathname === '/cdn-cgi/rum')) {
      evidence.blocked.analytics += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    // Routing sees the initial request, so an external mutation must not escape through a 307/308 redirect.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      evidence.writes.push({ kind: firstParty ? 'http-mutation' : 'external-http-mutation' });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  return evidence;
}

export async function waitForConfirmed(read, predicate, { timeoutMs = 10000, intervalMs = 50, label = 'confirmation' } = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(label) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000
    || !Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > timeoutMs) throw new Error('Invalid confirmation wait options');
  let timer;
  let interval;
  let expired = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error(`Timed out waiting for ${label}`)); }, timeoutMs);
  });
  const poll = async () => {
    while (!expired) {
      let value;
      let confirmed;
      try {
        value = await read();
        if (expired) return;
        confirmed = await predicate(value);
      } catch {
        throw new Error(`Confirmation failed for ${label}`);
      }
      if (expired) return;
      if (confirmed) return value;
      await new Promise((resolve) => { interval = setTimeout(resolve, intervalMs); });
    }
  };
  try {
    return await Promise.race([poll(), deadline]);
  } finally {
    expired = true;
    clearTimeout(timer);
    clearTimeout(interval);
  }
}
