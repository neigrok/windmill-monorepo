// Live-collaboration socket client. Subscribes to a tree on windmill-backend and
// streams authoritative op frames as they land. Read-path for now: it surfaces remote
// ops so the view can apply them; `send` is here for a future write-path.

const DEFAULT_URL = 'ws://localhost:8088/v1/socket';

export class CollabClient {
  constructor({ url = DEFAULT_URL, treeId, lastSeq = 0 } = {}) {
    this.url = url;
    this.treeId = treeId;
    this.lastSeq = lastSeq;
    this.ws = null;
    this.opHandler = null;
    this.closed = false;
  }

  onOp(handler) {
    this.opHandler = handler;
    return this;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('open', () => {
      this.ws.send(JSON.stringify({ t: 'subscribe', treeId: this.treeId, lastSeq: this.lastSeq }));
    });
    this.ws.addEventListener('message', (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      // The tree was already loaded over HTTP, so the snapshot is redundant; op frames
      // carry the deltas we render live.
      if (frame.t === 'op') {
        this.lastSeq = frame.seq;
        this.opHandler?.(frame);
      }
    });
    return this;
  }

  send(kind, payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const opId = crypto.randomUUID?.() ?? `op-${Date.now()}-${Math.random()}`;
    this.ws.send(JSON.stringify({ t: 'cmd', treeId: this.treeId, opId, kind, payload }));
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}
