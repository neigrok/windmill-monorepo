// Tree reads over HTTP, per treeId. A bootstrap read only: a live SyncSession's private
// lane owns the overlay.

import { ProgressLattice } from '../sync/progressLattice.js';
import { API_BASE } from '../../../shell/apiBase.js';
import { captureError } from '../../../telemetry/sentry.js';

export class HttpTreeRepository {
  constructor({
    baseUrl = API_BASE,
    treeId,
    operation = 'roadmap-tree-load',
    reportFailure = (failed) => captureError('roadmap', failed, '', '#/app'),
  } = {}) {
    if (!treeId) throw new Error('HttpTreeRepository requires a treeId — there is no default roadmap');
    this.baseUrl = baseUrl;
    this.treeId = treeId;
    this.operation = operation;
    this.reportFailure = reportFailure;
  }

  // Reports its static operation for a server failure, an answer that is not a tree, or a request lost while the page
  // is visible, online and still wants the tree. A refusal, an abort and a loss nobody is waiting on report nothing.
  async loadTree({ signal } = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}`, { credentials: 'include', signal });
    } catch (error) {
      const wanted = error?.name !== 'AbortError' && !signal?.aborted;
      const watched = globalThis.document?.visibilityState === 'visible' && globalThis.navigator?.onLine !== false;
      if (wanted && watched) this.reportFailure(this.operation);
      throw error;
    }
    if (response.status >= 500) this.reportFailure(this.operation);
    if (!response.ok) throw new Error(`loadTree ${this.treeId}: HTTP ${response.status}`);
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.data?.nodes)) {
      this.reportFailure(this.operation);
      throw new Error(`loadTree ${this.treeId}: the answer is not a tree`);
    }
    return { ...body.data, visibility: body.visibility ?? null, mine: body.mine ?? false, createdAt: body.createdAt ?? 0 };
  }

  // On a share the server answers with the owner's marks; falls back to the document's authoring
  // seeds when it holds none.
  async loadProgress(treeData, { signal } = {}) {
    let body = null;
    try {
      const response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/progress`, { credentials: 'include', signal });
      if (response.ok) body = await response.json();
    } catch {
      body = null;
    }
    if (body?.marks?.length) {
      const lattice = new ProgressLattice();
      lattice.join(body);
      return { ...lattice.overlay(), server: true };
    }
    return {
      completed: new Set(treeData.nodes.filter((node) => node.status === 'complete').map((node) => node.id)),
      completedAt: {},  // an authored seed status carries no instant
      server: false,
    };
  }

  // `since` is a seq cursor; 0 is the whole tail, capped at `limit`.
  async loadActivity({ since = 0, limit = 200, signal } = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/activity?since=${since}&limit=${limit}`, { credentials: 'include', signal });
    } catch {
      return [];
    }
    if (!response.ok) return [];
    const body = await response.json();
    return body.events ?? [];
  }
}
