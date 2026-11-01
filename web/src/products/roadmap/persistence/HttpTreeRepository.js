// Tree reads over HTTP, per treeId. A bootstrap read only: a live SyncSession's private
// lane owns the overlay.

import { ProgressLattice } from '../sync/progressLattice.js';
import { API_BASE } from '../../../shell/apiBase.js';
import { captureError } from '../../../telemetry/sentry.js';

export class HttpTreeRepository {
  constructor({ baseUrl = API_BASE, treeId, reportFailure = (operation) => captureError('roadmap', operation, '', '#/app') } = {}) {
    if (!treeId) throw new Error('HttpTreeRepository requires a treeId — there is no default roadmap');
    this.baseUrl = baseUrl;
    this.treeId = treeId;
    this.reportFailure = reportFailure;
  }

  // A server failure, or a request lost while the browser believes it is online, reports `roadmap-tree-load`; a tree
  // the server refuses or does not know is an expected answer and reports nothing.
  async loadTree() {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}`, { credentials: 'include' });
    } catch (error) {
      if (globalThis.navigator?.onLine !== false) this.reportFailure('roadmap-tree-load');
      throw error;
    }
    if (response.status >= 500) this.reportFailure('roadmap-tree-load');
    if (!response.ok) throw new Error(`loadTree ${this.treeId}: HTTP ${response.status}`);
    const body = await response.json();
    return { ...body.data, visibility: body.visibility ?? null, mine: body.mine ?? false, createdAt: body.createdAt ?? 0 };
  }

  // On a share the server answers with the owner's marks; falls back to the document's authoring
  // seeds when it holds none.
  async loadProgress(treeData) {
    let body = null;
    try {
      const response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/progress`, { credentials: 'include' });
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
  async loadActivity({ since = 0, limit = 200 } = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/activity?since=${since}&limit=${limit}`, { credentials: 'include' });
    } catch {
      return [];
    }
    if (!response.ok) return [];
    const body = await response.json();
    return body.events ?? [];
  }
}
