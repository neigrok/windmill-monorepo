// The real TreeRepository: loads the authored tree and this user's progress from the
// windmill-backend server. Same port (and same loadProgress(treeData) shape) as
// MockTreeRepository, so it drops straight into the load pipeline.

import { TreeRepository } from '../model/ports.js';
import { API_BASE } from '../apiBase.js';

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
    return body.data;
  }

  async loadProgress(treeData) {
    // Credentialed so the server returns *this* signed-in user's overlay (anonymous falls
    // back to the document's authoring seeds below).
    const response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/progress`, { credentials: 'include' });
    const server = response.ok ? await response.json() : { completed: [], inProgress: [] };
    if (server.completed.length > 0 || server.inProgress.length > 0) {
      return { completed: new Set(server.completed), inProgress: new Set(server.inProgress) };
    }

    // No per-user progress on the server yet — fall back to the document's authoring
    // seeds, matching the mock's first paint (Phase 0; real progress lands in Phase 1).
    return {
      completed: new Set(treeData.nodes.filter((node) => node.status === 'complete').map((node) => node.id)),
      inProgress: new Set(treeData.nodes.filter((node) => node.status === 'active').map((node) => node.id)),
    };
  }

  // The authoritative structural history from the op log: added/renamed/removed and the
  // edge deeds (linked/unlinked/rerouted/tidied), each with a ready `summary` sentence and
  // a real timestamp — including edits by collaborators the local feed never saw. `since`
  // is a seq cursor for catch-up; 0 = the whole tail (capped at `limit`).
  async loadActivity({ since = 0, limit = 200 } = {}) {
    const response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/activity?since=${since}&limit=${limit}`, { credentials: 'include' });
    if (!response.ok) return [];
    const body = await response.json();
    return body.events ?? [];
  }
}
