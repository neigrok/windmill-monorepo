// Tree reads over HTTP, per treeId. A bootstrap read only: a live SyncSession's private
// lane owns the overlay.

import { Openings } from '../model/Opening.js';
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

  async loadTree({ signal } = {}) {
    const operation = this.operation ?? 'roadmap-tree-load';
    const body = await this.answer('loadTree', '', { operation, signal });
    if (!Array.isArray(body?.data?.nodes)) {
      this.reportFailure(operation);
      throw new Error(`loadTree ${this.treeId}: the answer is not a tree`);
    }
    this.treeRead = true;
    return {
      ...body.data, visibility: body.visibility ?? null, mine: body.mine ?? false, createdAt: body.createdAt ?? 0,
      openings: Openings.fromWire(body.opens),
    };
  }

  // The owner's marks on a share, else the document's seeds. A server tree whose marks can't be read throws rather than open on a false count.
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
    if (body?.marks?.length) {
      const lattice = new ProgressLattice();
      lattice.join(body, () => reportInvalidProgressMark(this.reportFailure));
      return { ...lattice.overlay(), server: true };
    }
    return {
      completed: new Set(treeData.nodes.filter((node) => node.status === 'complete').map((node) => node.id)),
      completedAt: {},  // an authored seed status carries no instant
      server: false,
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
