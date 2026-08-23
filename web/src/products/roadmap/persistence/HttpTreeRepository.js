// The TreeRepository over HTTP, per treeId. A bootstrap read only: a live SyncSession's private
// lane owns the overlay.

import { TreeRepository } from '../model/ports.js';
import { ProgressLattice } from '../sync/progressLattice.js';
import { API_BASE } from '../../../shell/apiBase.js';

export class HttpTreeRepository extends TreeRepository {
  constructor({ baseUrl = API_BASE, treeId } = {}) {
    super();
    if (!treeId) throw new Error('HttpTreeRepository requires a treeId — there is no default roadmap');
    this.baseUrl = baseUrl;
    this.treeId = treeId;
  }

  async loadTree() {
    const response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}`, { credentials: 'include' });
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
      inProgress: new Set(treeData.nodes.filter((node) => node.status === 'active').map((node) => node.id)),
      startedAt: {},
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
