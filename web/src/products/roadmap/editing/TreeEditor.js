// The tree's present TreeData, held in one place so every read seam (the panels, the
// key handlers, the persistence hooks) sees the same projection without threading it
// through React state. It is a holder, not a history: the lattice is truth, and undo
// lives on the SyncSession, which banks the inverse of each gesture and dispatches it
// (sync/SyncSession.js). Every change arrives the same way — the lattice emits a new
// projection, onTreeChanged assigns it here, and syncStructure re-renders from it.
export class TreeEditor {
  constructor(treeData) {
    this.present = treeData;
  }

  get treeData() {
    return this.present;
  }
}
