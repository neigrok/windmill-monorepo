// Tree reads over HTTP, per treeId. A bootstrap read only: a live SyncSession's private
// lane owns the overlay.

import { ProgressLattice } from '../sync/progressLattice.js';
import { API_BASE } from '../../../shell/apiBase.js';
import { BoundaryFailure, pageWatching, reportRoadmapFailure } from '../reportFailure.js';

export class HttpTreeRepository {
  // An owner naming `operation` reports every read under it. A tree that did not come from this repository's own read came
  // off this device, and its reads report nothing: the tree's read already told what the server is doing.
  constructor({ baseUrl = API_BASE, treeId, operation = null, reportFailure = reportRoadmapFailure } = {}) {
    if (!treeId) throw new Error('HttpTreeRepository requires a treeId — there is no default roadmap');
    this.baseUrl = baseUrl;
    this.treeId = treeId;
    this.operation = operation;
    this.reportFailure = reportFailure;
    this.treeRead = false;
  }

  // One read of this tree: its parsed answer, null when a 2xx is not JSON. A server failure, and a request lost while the page
  // is visible, online and still wants it, report `operation`. A refusal, an abort and a loss nobody is waiting on report
  // nothing. Anything but a 2xx throws.
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
    if (response.status >= 500) report();
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
    return { ...body.data, visibility: body.visibility ?? null, mine: body.mine ?? false, createdAt: body.createdAt ?? 0 };
  }

  // On a share the server answers with the owner's marks; falls back to the document's authoring seeds when it holds none.
  // A server tree whose marks can't be read throws rather than opening on a false count. A device tree keeps its seeds, and
  // its session's lane brings its marks.
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
      lattice.join(body);
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
