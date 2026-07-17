// The TreeRepository: loads the authored tree and this user's progress from the
// windmill-backend server, per treeId. Implements the `TreeRepository` port
// (loadTree / loadProgress / loadActivity) that the load pipeline drives.

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
    // The tree document plus the server's stance on it: `visibility` (private ⇒ owner-only,
    // unlisted/public ⇒ anyone with the link) and `mine` (is the caller its owner). Both ride
    // on the returned shape so the Share surface can share honestly; existing consumers read
    // id/title/nodes/kinds off the same object, untouched.
    return { ...body.data, visibility: body.visibility ?? null, mine: body.mine ?? false };
  }

  async loadProgress(treeData) {
    // Credentialed so the server returns *this* signed-in user's overlay (anonymous and
    // offline/local-born trees both fall back to the document's authoring seeds below).
    let response = null;
    try {
      response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/progress`, { credentials: 'include' });
    } catch { /* unreachable — the seed statuses answer */ }
    const server = response?.ok ? await response.json() : { completed: [], inProgress: [], cleared: [] };
    if (server.completed.length > 0 || server.inProgress.length > 0 || (server.cleared?.length ?? 0) > 0) {
      // `server: true` marks this as the account's real overlay — the load pipeline lets
      // it win over stale localStorage. `cleared` carries the tombstones so a cleared
      // node is never mistaken for a never-marked one.
      return {
        completed: new Set(server.completed),
        inProgress: new Set(server.inProgress),
        cleared: new Set(server.cleared ?? []),
        server: true,
      };
    }

    // No per-user progress on the server yet — fall back to the document's authoring
    // seeds, matching the mock's first paint (Phase 0; real progress lands in Phase 1).
    return {
      completed: new Set(treeData.nodes.filter((node) => node.status === 'complete').map((node) => node.id)),
      inProgress: new Set(treeData.nodes.filter((node) => node.status === 'active').map((node) => node.id)),
      server: false,
    };
  }

  // The authoritative structural history from the op log: added/renamed/removed and the
  // edge deeds (linked/unlinked/rerouted/tidied), each with a ready `summary` sentence and
  // a real timestamp — including edits by collaborators the local feed never saw. `since`
  // is a seq cursor for catch-up; 0 = the whole tail (capped at `limit`).
  async loadActivity({ since = 0, limit = 200 } = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/activity?since=${since}&limit=${limit}`, { credentials: 'include' });
    } catch {
      return []; // unreachable — the local feed still tells its story
    }
    if (!response.ok) return [];
    const body = await response.json();
    return body.events ?? [];
  }
}
