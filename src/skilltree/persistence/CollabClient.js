// Live-collaboration socket client. Subscribes to a tree on windmill-backend and
// streams authoritative op frames as they land. Read-path for now: it surfaces remote
// ops so the view can apply them; `send` is here for a future write-path.

import { socketUrl } from '../apiBase.js';

const DEFAULT_URL = socketUrl();

export class CollabClient {
  constructor({ url = DEFAULT_URL, treeId, lastSeq = 0 } = {}) {
    this.url = url;
    this.treeId = treeId;
    this.lastSeq = lastSeq;
    this.ws = null;
    this.opHandler = null;
    this.presenceHandler = null;
    this.peerHandler = null;
    this.presence = null; // latest un-sent presence, coalesced by the throttle
    this.presenceTimer = null;
    this.sent = new Set(); // opIds we authored — their echoes are already applied locally
    this.closed = false;
  }

  onOp(handler) {
    this.opHandler = handler;
    return this;
  }

  // A peer's coalesced cursor/selection (server sends at ≤ 20 Hz, latest-wins per actor).
  onPresence(handler) {
    this.presenceHandler = handler;
    return this;
  }

  // A peer joined or left the room (`{ event, actor, profile }`) — brackets the cursor.
  onPeer(handler) {
    this.peerHandler = handler;
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
        if (frame.opId && this.sent.has(frame.opId)) return; // our own edit, already applied
        this.opHandler?.(frame);
      } else if (frame.t === 'presence') {
        this.presenceHandler?.(frame); // the server never echoes our own cursor back to us
      } else if (frame.t === 'peer') {
        this.peerHandler?.(frame);
      } else if (frame.t === 'reject') {
        // The server refused an op — a legend invariant (hue taken, ≤6 kinds, in-use
        // removal), a bounds cap, or authorization (not signed in / not your tree). Auth
        // rejects fire a window event so the app can prompt sign-in; the rest just warn.
        const authReject = frame.reason === 'sign in to edit' ||
          frame.reason === 'this tree belongs to another account';
        if (authReject) window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: frame.reason }));
        else console.warn('[collab] op rejected', frame.opId, '—', frame.reason);
        this.rejectHandler?.(frame);
      }
    });
    return this;
  }

  send(kind, payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const opId = crypto.randomUUID?.() ?? `op-${Date.now()}-${Math.random()}`;
    this.sent.add(opId);
    this.ws.send(JSON.stringify({ t: 'cmd', treeId: this.treeId, opId, kind, payload }));
  }

  // Our cursor/selection (cursor in world coords, or null). Ephemeral — coalesced to the
  // trailing edge of a ~40 ms window (≈25 Hz) so a drag doesn't flood the socket; the
  // server coalesces again to ≤ 20 Hz per subscriber. The latest state always wins.
  sendPresence(cursor, selection) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.presence = { cursor, selection };
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      if (!this.presence || this.ws?.readyState !== WebSocket.OPEN) return;
      const { cursor, selection } = this.presence;
      this.presence = null;
      this.ws.send(JSON.stringify({ t: 'presence', treeId: this.treeId, cursor, selection }));
    }, 40);
  }

  // Collaborative undo/redo is server-driven: the backend replays this author's inverse
  // as fresh ops, which come back through onOp like any edit.
  undo() { this.control('undo'); }
  redo() { this.control('redo'); }
  control(t) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t, treeId: this.treeId }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}
