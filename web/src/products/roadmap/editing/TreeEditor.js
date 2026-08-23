// Holds the tree's present TreeData so every read seam sees the same projection.
export class TreeEditor {
  constructor(treeData) {
    this.present = treeData;
  }

  get treeData() {
    return this.present;
  }
}
