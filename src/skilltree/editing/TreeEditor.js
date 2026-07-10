// The edit history for a tree. Holds the present TreeData plus undo/redo stacks
// of prior snapshots. Every edit is a pure TreeData → TreeData transform (see
// edits.js) whose result is committed here as one history step — compound edits
// (e.g. delete node + splice children) are a single transform, so they undo as
// one. Snapshots share unchanged node objects, so keeping many is cheap.
//
// Linear history (a new edit clears redo); session-scoped; camera moves never
// pass through here.
export class TreeEditor {
  constructor(treeData) {
    this.present = treeData;
    this.undoStack = [];
    this.redoStack = [];
  }

  get treeData() {
    return this.present;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  commit(nextTreeData) {
    if (nextTreeData === this.present) return false;
    this.undoStack.push(this.present);
    this.present = nextTreeData;
    this.redoStack = [];
    return true;
  }

  // Refine the current present without a new history step — e.g. naming a node
  // that was just committed, so create + name undo together as one.
  amend(nextTreeData) {
    this.present = nextTreeData;
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(this.present);
    this.present = this.undoStack.pop();
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(this.present);
    this.present = this.redoStack.pop();
    return true;
  }
}
