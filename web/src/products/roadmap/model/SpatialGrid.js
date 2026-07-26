// Uniform bucket grid over already-placed RenderNodes. Backs pointer picking
// (nearest) and viewport label selection (within) without scanning all nodes.

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

  // Re-bucket a node after it moves. Positions are read from the shared node
  // objects, so callers that mutate node.x/y are already reflected in queries;
  // this keeps the cell index (which query cells to scan) consistent too.
  move(id, x, y) {
    const oldKey = this.cellByNode.get(id);
    if (oldKey === undefined) return;
    const newKey = this.cellKey(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
    if (newKey === oldKey) return;
    const bucket = this.cells.get(oldKey);
    const at = bucket.indexOf(id);
    if (at >= 0) bucket.splice(at, 1);
    if (!this.cells.has(newKey)) this.cells.set(newKey, []);
    this.cells.get(newKey).push(id);
    this.cellByNode.set(id, newKey);
  }

  nearest(x, y, maxRadius) {
    const originX = Math.floor(x / this.cellSize);
    const originY = Math.floor(y / this.cellSize);
    let bestId = null;
    let bestDistSq = maxRadius * maxRadius;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const ids = this.cells.get(this.cellKey(originX + dx, originY + dy));
        if (!ids) continue;
        for (const id of ids) {
          const node = this.nodesById.get(id);
          const distSq = (node.x - x) ** 2 + (node.y - y) ** 2;
          if (distSq > bestDistSq) continue;
          bestDistSq = distSq;
          bestId = id;
        }
      }
    }

    return bestId;
  }

  within(minX, minY, maxX, maxY) {
    const ids = [];
    const cellXMin = Math.floor(minX / this.cellSize);
    const cellXMax = Math.floor(maxX / this.cellSize);
    const cellYMin = Math.floor(minY / this.cellSize);
    const cellYMax = Math.floor(maxY / this.cellSize);

    for (let cellX = cellXMin; cellX <= cellXMax; cellX++) {
      for (let cellY = cellYMin; cellY <= cellYMax; cellY++) {
        const bucket = this.cells.get(this.cellKey(cellX, cellY));
        if (!bucket) continue;
        for (const id of bucket) {
          const node = this.nodesById.get(id);
          if (node.x < minX || node.x > maxX || node.y < minY || node.y > maxY) continue;
          ids.push(id);
        }
      }
    }

    return ids;
  }
}
