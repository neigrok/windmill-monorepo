// Tree reads over HTTP, per treeId. A bootstrap read only: a live SyncSession's private
// lane owns the overlay.

import { Opening, Openings, TreePlace } from '../model/Opening.js';
import { ProgressLattice } from '../sync/progressLattice.js';
import { API_BASE } from '../../../shell/apiBase.js';
import { BoundaryFailure, reportInvalidProgressMark, pageWatching, reportRoadmapFailure } from '../reportFailure.js';

export class HttpTreeRepository {
  // An owner naming `operation` reports every read under it; a tree this repository did not read came off this device, and its reads report nothing.
  constructor({ baseUrl = API_BASE, treeId, operation = null, reportFailure = reportRoadmapFailure } = {}) {
    if (!treeId) throw new Error('HttpTreeRepository requires a treeId — there is no default roadmap');
    this.baseUrl = baseUrl;
    this.treeId = treeId;
    this.operation = operation;
    this.reportFailure = reportFailure;
    this.treeRead = false;
  }

  // One read's parsed answer, null when a 2xx is not JSON; anything else throws, reporting `operation` for a server failure or a loss someone was waiting on.
  async answer(reading, path, { operation, signal }) {
    const report = () => { if (operation) this.reportFailure(operation); };
    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/trees/${this.treeId}${path}`, { credentials: 'include', signal });
    } catch (error) {
      const wanted = error?.name !== 'AbortError' && !signal?.aborted;
      if (wanted && pageWatching()) report();
      throw error;
    }
    // A tree whose pointers the server could not follow says so, and reports as that unless this repository's owner names its own operation.
    if (response.status >= 500 && operation) {
      const code = (await response.json().catch(() => null))?.code;
      this.reportFailure(this.operation ?? (code === 'opens-unavailable' ? 'roadmap-opens-load' : operation));
    }
    if (!response.ok) throw new Error(`${reading} ${this.treeId}: HTTP ${response.status}`);
    return response.json().catch(() => null);
  }

  // The tree, where it sits among the trees and what its steps open. An answer that is not a tree, or that does not say
  // where it sits, reports as a failed read.
  async loadTree({ signal } = {}) {
    const operation = this.operation ?? 'roadmap-tree-load';
    const body = await this.answer('loadTree', '', { operation, signal });
    const place = body && TreePlace.fromWire(body);
    if (!Array.isArray(body?.data?.nodes) || !place) {
      this.reportFailure(operation);
      throw new Error(`loadTree ${this.treeId}: the answer is not a tree`);
    }
    this.treeRead = true;
    return {
      ...body.data, visibility: body.visibility ?? null, mine: body.mine ?? false, createdAt: body.createdAt ?? 0,
      place, openings: Openings.fromWire(body.opens, body.data.nodes),
    };
  }

  // The owner's marks on a share, else the document's seeds, and what the server says each subtree the steps own has come
  // to (`subtrees`, by step; none where it says nothing). A server tree whose marks can't be read throws rather than open
  // on a false count.
  async loadProgress(treeData, { signal } = {}) {
    const operation = this.treeRead ? this.operation ?? 'roadmap-progress-load' : null;
    const body = await this.answer('loadProgress', '/progress', { operation, signal }).catch((error) => {
      if (this.treeRead) throw new BoundaryFailure(`loadProgress ${this.treeId}`, { cause: error });
      return {};
    });
    if (body === null && this.treeRead) {
      this.reportFailure(operation);
      throw new BoundaryFailure(`loadProgress ${this.treeId}: the answer is not JSON`);
    }
    const subtrees = new Map((Array.isArray(body?.subtrees) ? body.subtrees : []).flatMap((row) => {
      if (typeof row?.node !== 'string' || typeof row.tree !== 'string') return [];
      const state = row.total > 0 && row.done === row.total ? 'complete' : 'open';
      return [[row.node, Opening.owned({ id: row.tree, done: row.done, total: row.total, state })]];
    }));
    if (body?.marks?.length) {
      const lattice = new ProgressLattice();
      lattice.join(body, () => reportInvalidProgressMark(this.reportFailure));
      return { ...lattice.overlay(), server: true, subtrees };
    }
    return {
      completed: new Set(treeData.nodes.filter((node) => node.status === 'complete').map((node) => node.id)),
      completedAt: {},  // an authored seed status carries no instant
      server: false,
      subtrees,
    };
  }

  // `since` is a seq cursor; 0 is the whole tail, capped at `limit`. A failed read costs the feed, never the room.
  async loadActivity({ since = 0, limit = 200, signal } = {}) {
    const operation = this.treeRead ? this.operation ?? 'roadmap-activity-load' : null;
    const body = await this.answer('loadActivity', `/activity?since=${since}&limit=${limit}`, { operation, signal }).catch(() => ({}));
    if (body === null && operation) this.reportFailure(operation);
    return body?.events ?? [];
  }
}
