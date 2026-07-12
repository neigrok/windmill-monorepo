// The real TreeRepository: loads the authored tree and this user's progress from the
// windmill-backend server. Same port (and same loadProgress(treeData) shape) as
// MockTreeRepository, so it drops straight into the load pipeline.

import { TreeRepository } from '../model/ports.js';

const DEFAULT_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? 'http://localhost:8088';
const DEFAULT_TREE_ID = 'windmill-roadmap';

export class HttpTreeRepository extends TreeRepository {
  constructor({ baseUrl = DEFAULT_BASE_URL, treeId = DEFAULT_TREE_ID } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.treeId = treeId;
  }

  async loadTree() {
    const response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}`);
    if (!response.ok) throw new Error(`loadTree ${this.treeId}: HTTP ${response.status}`);
    const body = await response.json();
    return body.data;
  }

  async loadProgress(treeData) {
    const response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/progress`);
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
    const response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/activity?since=${since}&limit=${limit}`);
    if (!response.ok) return [];
    const body = await response.json();
    return body.events ?? [];
  }
}
