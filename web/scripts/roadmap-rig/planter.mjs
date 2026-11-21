// Roadmap fixtures planted in a local backend through MCP, the door every server write for a person takes on both sides of
// roadmap's move onto the engine (roadmap-on-the-engine.md §7): a roadmap with the fixture's legend, its steps under their
// own ids with their order, prerequisites and links, and the caller's marks. A fixture has a get_tree reply's shape:
// `{ title, kinds?, nodes: [{ id, label, color?, icon?, order?, prerequisites?, description?, links?, status?, outOfOrder? }] }`.
const MARKS_PER_CALL = 200;
const CALL_MS = 300_000;

export class RoadmapPlanter {
  static async connect({ api, token, client }) {
    const planter = new RoadmapPlanter(api, token);
    const reply = await planter.send({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: client, version: '0' } } });
    planter.session = reply.headers.get('mcp-session-id');
    if (!planter.session) throw new Error(`MCP initialize answered ${reply.status}`);
    return planter;
  }

  constructor(api, token) {
    this.api = api;
    this.token = token;
    this.session = null;
  }

  async send(message) {
    return fetch(`${this.api}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.token}`, ...(this.session && { 'Mcp-Session-Id': this.session }) },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(CALL_MS),
    });
  }

  // A tool's answer; a refusal throws the tool's own sentence.
  async call(name, args) {
    const { result, error } = await (await this.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })).json();
    if (error || result.isError) throw new Error(error?.message ?? result.content[0].text);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }

  // The id of the caller's roadmap of this title, or null.
  async find(title) {
    const { trees } = await this.call('roadmap_list_trees', {});
    return trees.find((tree) => tree.title === title)?.id ?? null;
  }

  async plant({ title, kinds = [], nodes }) {
    const legend = kinds.map(({ id, hue, label = '', description = '' }) => ({ id, hue, label, description }));
    const { treeId } = await this.call('roadmap_create_tree', { title, ...(legend.length > 0 && { kinds: legend }) });
    const steps = nodes.map(({ id, label, color, icon, order, prerequisites = [], description, links }) => ({
      id, label, prerequisites, ...(color && { color }), ...(icon && { icon }), ...(order && { order }),
      ...(description && { description }), ...(links?.length && { links }),
    }));
    await this.call('roadmap_import_subgraph', { treeId, nodes: steps });
    const marks = nodes.filter((node) => node.status === 'complete')
      .map((node) => ({ nodeId: node.id, status: 'complete', ...(node.outOfOrder && { outOfOrder: true }) }));
    for (let start = 0; start < marks.length; start += MARKS_PER_CALL) {
      await this.call('roadmap_update_nodes', { treeId, updates: marks.slice(start, start + MARKS_PER_CALL) });
    }
    return treeId;
  }
}
