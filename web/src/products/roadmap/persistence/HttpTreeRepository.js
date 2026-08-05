// The TreeRepository: loads the authored tree and this user's progress from the
// windmill-backend server, per treeId. Implements the `TreeRepository` port
// (loadTree / loadProgress / loadServerProgress / loadActivity) that the load
// pipeline drives.

import { TreeRepository } from '../model/ports.js';
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
    // The tree document plus what the server knows ABOUT it: `visibility` (private ⇒ owner-only,
    // unlisted/public ⇒ anyone with the link), `mine` (is the caller its owner), and `createdAt` —
    // the planting time in epoch ms, 0 when the row predates the stamp. The week-N card counts its
    // periods from that instant and never from the calendar. All three ride on the returned shape;
    // existing consumers read id/title/nodes/kinds off the same object, untouched.
    return { ...body.data, visibility: body.visibility ?? null, mine: body.mine ?? false, createdAt: body.createdAt ?? 0 };
  }

  // The account's own overlay, exactly as the server holds it — three id arrays, or null
  // when the server did not answer (unreachable, or a status that isn't 200). Credentialed
  // so it is *this* signed-in user's overlay. Two callers: loadProgress below seeds from
  // the document when this comes back empty, and the collab reconcile needs it unseeded,
  // because "the server has no row for this mark" is the only thing that makes a push safe.
  async loadServerProgress() {
    try {
      const response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/progress`, { credentials: 'include' });
      if (!response.ok) return null;
      const body = await response.json();
      return {
        completed: body.completed ?? [],
        inProgress: body.inProgress ?? [],
        cleared: body.cleared ?? [],
      };
    } catch {
      return null;
    }
  }

  async loadProgress(treeData) {
    const server = (await this.loadServerProgress()) ?? { completed: [], inProgress: [], cleared: [] };
    if (server.completed.length > 0 || server.inProgress.length > 0 || server.cleared.length > 0) {
      // `server: true` marks this as the account's real overlay — the load pipeline lets
      // it win over stale localStorage. `cleared` carries the tombstones so a cleared
      // node is never mistaken for a never-marked one.
      return {
        completed: new Set(server.completed),
        inProgress: new Set(server.inProgress),
        cleared: new Set(server.cleared),
        server: true,
      };
    }

    // The server holds no overlay for this caller on this tree — an anonymous reader, a
    // fresh account, or a local-born tree it has never seen. Fall back to the document's
    // own authoring seeds so a quest still opens at the state its author staged.
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
