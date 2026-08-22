// The TreeRepository: loads the authored tree and the progress overlay from the windmill-backend
// server, per treeId. Implements the `TreeRepository` port (loadTree / loadProgress /
// loadActivity) that the load pipeline drives.
//
// This is the BOOTSTRAP read only. Once a SyncSession is live the private lane owns the overlay
// for an editable view (sync/progressLattice.js) — this door exists because a share view has no
// lane of its own to graft, and because a first paint should not wait on a socket.

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
    // The tree document plus what the server knows ABOUT it: `visibility` (private ⇒ owner-only,
    // unlisted/public ⇒ anyone with the link), `mine` (is the caller its owner), and `createdAt` —
    // the planting time in epoch ms, 0 when the row predates the stamp. The week-N card counts its
    // periods from that instant and never from the calendar. All three ride on the returned shape;
    // existing consumers read id/title/nodes/kinds off the same object, untouched.
    return { ...body.data, visibility: body.visibility ?? null, mine: body.mine ?? false, createdAt: body.createdAt ?? 0 };
  }

  // The overlay this reader should see, as a lattice frame of stamped registers, folded through
  // the same ProgressLattice the socket lane uses — one codec for both doors. For an owner these
  // are their own marks; on a share the server answers with the OWNER's journey, which is the
  // whole point of the picture. Falls back to the document's authoring seeds when the server holds
  // no marks at all, so a quest still opens at the state its author staged.
  async loadProgress(treeData) {
    let body = null;
    try {
      const response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}/progress`, { credentials: 'include' });
      if (response.ok) body = await response.json();
    } catch {
      body = null;  // unreachable — the seeds below still open the tree at a sane state
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
      completedAt: {},  // an authored seed status is nobody's mark, at no instant we know
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
