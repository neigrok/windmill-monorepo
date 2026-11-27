import { BrowserSyncEngine } from './engine.js';

// The session owner supplies cookie cleanup and product preparation before networking starts.
class SyncSession {
  constructor() {
    this.listeners = new Set();
    // `signedIn` stays null until the shell's account answer says whether someone is signed in on this document, and
    // `account` is the id of the account it settled, null while there is none.
    this.snapshot = { engine: null, ready: false, signedIn: null, account: null, online: true, error: false };
  }

  subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  publish(change) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  open(options) {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const engine = await BrowserSyncEngine.open(options);
      this.engine = engine;
      // A page in the back/forward cache stays ready: its rooms keep the replica and its observations as they stand, and
      // the engine holds their writes until it is restored. Only a restore that fails takes the rooms down.
      engine.onEvent(({ event }) => {
        if (event === 'restored') this.publish({ ready: true, error: false, online: engine.online });
        if (event === 'restoreFailed') this.publish({ ready: false, error: true });
      });
      try {
        await options.prepare?.(engine);
        await engine.start();
        this.publish({ engine, ready: true, online: engine.online });
        this.connectivity = () => this.publish({ online: navigator.onLine !== false });
        window.addEventListener('online', this.connectivity);
        window.addEventListener('offline', this.connectivity);
        return engine;
      } catch (error) {
        engine.close();
        throw error;
      }
    })().catch((error) => {
      this.publish({ error: true });
      throw error;
    });
    return this.opening;
  }
}

export const syncSession = new SyncSession();
