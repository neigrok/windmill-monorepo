import { RoadmapTree } from '../../../../src/products/roadmap/domain/records.js';
import { FollowGraph } from '../../../../src/products/roadmap/domain/graph.js';
import { RoadmapAccount } from '../../../../src/products/roadmap/domain/account.js';
import { BoardRead, LegendRead, selectNodes, landingFacts } from '../../../../src/products/roadmap/domain/reads.js';
import { diagnose, pointerDiagnostics } from '../../../../src/products/roadmap/domain/diagnostics.js';

export function runRead(input) {
  if (input.operation === 'account' || input.operation === 'guides' || input.operation === 'pointers' || input.operation === 'progress') {
    const account = new RoadmapAccount(input.trees.map((tree) => new RoadmapTree(tree)));
    if (input.operation === 'account') return account.result();
    if (input.operation === 'progress') return account.progress(input.tree);
    return input.operation === 'guides' ? account.guides(input.tree) : pointerDiagnostics(account, input.tree);
  }
  const tree = new RoadmapTree(input.tree);
  if (input.operation === 'legend') return new LegendRead(tree).result();
  if (input.operation === 'search') return selectNodes(tree, input.query);
  const graph = new FollowGraph(tree);
  if (input.operation === 'graph') return graph.result(input.subjects);
  if (input.operation === 'board') return new BoardRead(graph, input.query).result();
  if (input.operation === 'diagnostics') return diagnose(graph);
  if (input.operation === 'landing') return landingFacts(graph, input.own);
  throw new Error(`Unclaimed roadmap read operation: ${input.operation}`);
}
