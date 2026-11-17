const documentSessions = new WeakMap();

export class StepDraftSession {
  constructor() {
    this.scope = null;
    this.slot = null;
    this.listeners = new Set();
    this.subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    this.getSnapshot = () => {
      const slot = this.slot;
      const scope = this.scope?.getSnapshot();
      if (!slot || slot.scope !== this.scope || scope?.phase !== 'ready' || scope.epoch !== slot.epoch || scope.owner !== slot.owner) return null;
      return slot;
    };
  }

  bindScope(scope) {
    if (this.scope === scope) return;
    this.invalidate();
    this.scope = scope;
  }

  publish(slot) {
    this.slot = slot ? Object.freeze(slot) : null;
    for (const listener of this.listeners) listener();
  }

  invalidate() { this.publish(null); }

  start({ draft, treeId, route, displayValue }) {
    if (this.getSnapshot()) return null;
    const scope = this.scope?.getSnapshot();
    if (scope?.phase !== 'ready') return null;
    const token = Object.freeze({});
    this.publish({ token, scope: this.scope, epoch: scope.epoch, owner: scope.owner, draft, treeId, route, displayValue, mode: 'active', returnToken: null });
    return token;
  }

  update(token, change) {
    const slot = this.getSnapshot();
    if (!slot || slot.token !== token) return false;
    this.publish({ ...slot, ...change, token, scope: slot.scope, epoch: slot.epoch, owner: slot.owner });
    return true;
  }

  retain(token) { return this.update(token, { mode: 'retained', returnToken: null }); }
  clear(token) {
    if (this.getSnapshot()?.token !== token) return false;
    this.publish(null);
    return true;
  }

  requestReturn(token) {
    const returnToken = Object.freeze({});
    if (!this.update(token, { returnToken })) return null;
    return returnToken;
  }

  adopt(token, returnToken) {
    const slot = this.getSnapshot();
    if (!slot || slot.mode !== 'retained' || slot.token !== token || slot.returnToken !== returnToken) return false;
    return this.update(token, { mode: 'active', returnToken: null });
  }
}

export function stepDraftSession(document, { create = true } = {}) {
  if (!document) return null;
  let session = documentSessions.get(document);
  if (!session && create) {
    session = new StepDraftSession();
    documentSessions.set(document, session);
  }
  return session ?? null;
}

export function invalidateStepDraftSession(document = globalThis.document) {
  stepDraftSession(document, { create: false })?.invalidate();
}
