// Uniform bucket grid over already-placed RenderNodes, for picking and viewport queries.

export class SpatialGrid {
  constructor(renderNodes, cellSize) {
    this.cellSize = cellSize;
    this.nodesById = new Map();
    this.cells = new Map();
    this.cellByNode = new Map();

    for (const node of renderNodes) {
      this.nodesById.set(node.id, node);
      const key = this.cellKey(Math.floor(node.x / cellSize), Math.floor(node.y / cellSize));
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(node.id);
      this.cellByNode.set(node.id, key);
    }
  }

  cellKey(cellX, cellY) {
    return `${cellX},${cellY}`;
  }

  // Call after mutating node.x/y so the cell index stays consistent.
  move(id, x, y) {
    const oldKey = this.cellByNode.get(id);
    if (oldKey === undefined) return;
    const newKey = this.cellKey(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
    if (newKey === oldKey) return;
    const bucket = this.cells.get(oldKey);
    const at = bucket.indexOf(id);
    if (at >= 0) bucket.splice(at, 1);
    if (bucket.length === 0) this.cells.delete(oldKey); // an emptied bucket would decay the occupancy bound below
    if (!this.cells.has(newKey)) this.cells.set(newKey, []);
    this.cells.get(newKey).push(id);
    this.cellByNode.set(id, newKey);
  }

  // Reaches every cell the radius covers, so a radius wider than a cell (a screen-px hit floor at overview zoom) still
  // finds its node — but a query wider than the grid is occupied walks the nodes instead: the cost is min(nodes, cells).
  nearest(x, y, maxRadius) {
    const originX = Math.floor(x / this.cellSize);
    const originY = Math.floor(y / this.cellSize);
    const reach = Math.ceil(maxRadius / this.cellSize);
    let bestId = null;
    let bestDistSq = maxRadius * maxRadius;

    for (const node of this.scan(originX - reach, originY - reach, originX + reach, originY + reach)) {
      const distSq = (node.x - x) ** 2 + (node.y - y) ** 2;
      if (distSq > bestDistSq) continue;
      bestDistSq = distSq;
      bestId = node.id;
    }

    return bestId;
  }

  within(minX, minY, maxX, maxY) {
    const ids = [];
    for (const node of this.scan(
      Math.floor(minX / this.cellSize), Math.floor(minY / this.cellSize),
      Math.floor(maxX / this.cellSize), Math.floor(maxY / this.cellSize),
    )) {
      if (node.x < minX || node.x > maxX || node.y < minY || node.y > maxY) continue;
      ids.push(node.id);
    }
    return ids;
  }

  // Every node in the given cell rectangle, cell by cell — or, when the rectangle asks for more cells than the grid
  // holds, every node in the grid: at an overview zoom one query can span millions of cells over a few hundred nodes.
  *scan(cellXMin, cellYMin, cellXMax, cellYMax) {
    if ((cellXMax - cellXMin + 1) * (cellYMax - cellYMin + 1) > this.cells.size) {
      yield* this.nodesById.values();
      return;
    }
    for (let cellX = cellXMin; cellX <= cellXMax; cellX++) {
      for (let cellY = cellYMin; cellY <= cellYMax; cellY++) {
        const bucket = this.cells.get(this.cellKey(cellX, cellY));
        if (!bucket) continue;
        for (const id of bucket) yield this.nodesById.get(id);
      }
    }
  }
}
