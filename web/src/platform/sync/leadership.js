export class TabLeadership {
  constructor({ locks = globalThis.navigator?.locks, channel = (name) => new BroadcastChannel(name),
    visible = true, readReplica, onLeader, onMessage, onFailure = () => {}, id = crypto.randomUUID() }) {
    if (!locks || !channel) throw new Error('sync coordination unavailable');
    Object.assign(this, { locks, channelFactory: channel, visible, readReplica, onLeader, onMessage, onFailure, id });
    this.peers = new Map();
    this.closed = false;
    this.leader = false;
    this.pending = null;
    this.generation = 0;
    this.messages = Promise.resolve();
  }

  async start(replica) {
    await this.locks.request('wm-tab-start', async () => {
      if (this.closed) return;
      const { held } = await this.locks.query();
      if (this.closed) return;
      this.first = !held.some((lock) => lock.name === 'wm-tab');
      let acquired;
      const ready = new Promise((resolve, reject) => {
        acquired = resolve;
        this.tabTask = this.locks.request('wm-tab', { mode: 'shared' }, () => {
          acquired();
          if (this.closed) return;
          return new Promise((resolve) => { this.releaseTab = resolve; });
        });
        this.tabTask.catch(reject);
      });
      await ready;
    });
    this.tabTask?.catch(() => this.onFailure('leadership'));
    this.rekey(replica);
    return this.first;
  }

  rekey(replica) {
    if (this.closed || this.replica === replica) return;
    this.release();
    this.channel?.close();
    this.peers.clear();
    this.replica = replica;
    this.channel = this.channelFactory(`wm-sync:${replica}`);
    this.channel.onmessage = ({ data }) => {
      this.messages = this.messages.then(() => this.receive(data)).catch(() => this.onFailure('leadership'));
    };
    this.post({ type: 'hello', visible: this.visible });
    if (this.visible) this.request();
  }

  post(message) {
    if (!this.closed) this.channel?.postMessage({ ...message, tab: this.id });
  }

  async receive(message) {
    if (!message || message.tab === this.id || typeof message.tab !== 'string') return;
    if (['hello', 'visible', 'hidden', 'bye'].includes(message.type)) {
      const seen = this.peers.has(message.tab);
      if (message.type === 'bye') this.peers.delete(message.tab);
      else this.peers.set(message.tab, message.type === 'visible' || (message.type === 'hello' && message.visible === true));
      if (message.type === 'hello' && !seen) this.post({ type: 'hello', visible: this.visible });
      if (message.type === 'hello' || message.type === 'visible') {
        const replica = await this.readReplica();
        if (replica !== this.replica) this.rekey(replica);
      }
      if (!this.visible && this.anyVisible()) this.release();
      if (this.visible) this.request();
    }
    if (message.type === 'activeReplicaChanged') {
      const replica = await this.readReplica();
      if (this.closed) return;
      this.onMessage(message);
      this.rekey(replica);
      return;
    }
    this.onMessage(message);
  }

  anyVisible() {
    return this.visible || [...this.peers.values()].some(Boolean);
  }

  lastTab() {
    return this.peers.size === 0;
  }

  setVisible(visible) {
    this.visible = visible;
    this.post({ type: visible ? 'visible' : 'hidden' });
    if (visible) this.request();
    else if (this.anyVisible()) this.release();
  }

  request() {
    if (this.closed || !this.visible || this.pending || this.leader) return;
    const controller = new AbortController();
    const generation = this.generation;
    this.pending = controller;
    const task = this.locks.request(`wm-sync:${this.replica}`, { signal: controller.signal }, async () => {
      if (this.closed || controller.signal.aborted || generation !== this.generation) return;
      const replica = await this.readReplica();
      if (this.closed || controller.signal.aborted || generation !== this.generation) return;
      if (replica !== this.replica) {
        this.rekey(replica);
        return;
      }
      this.pending = null;
      const held = new Promise((resolve) => { this.releaseLeader = resolve; });
      this.leader = true;
      this.onLeader(true);
      await held;
      if (generation === this.generation && this.leader) {
        this.leader = false;
        this.onLeader(false);
      }
    });
    task.catch((error) => { if (error.name !== 'AbortError') this.onFailure('leadership'); });
    task.finally(() => {
      if (this.pending === controller) this.pending = null;
      if (generation === this.generation && this.visible && !this.closed) this.request();
    }).catch(() => {});
  }

  release() {
    this.generation++;
    this.pending?.abort();
    this.pending = null;
    this.releaseLeader?.();
    this.releaseLeader = null;
    if (this.leader) {
      this.leader = false;
      this.onLeader(false);
    }
  }

  close() {
    if (this.closed) return;
    this.post({ type: 'bye' });
    this.closed = true;
    this.release();
    this.releaseTab?.();
    this.channel?.close();
  }
}
