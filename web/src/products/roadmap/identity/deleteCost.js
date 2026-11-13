// What deleting a tree takes from the person's other trees, as the switcher's confirmation says it. A server that removes
// the steps opening a tree along with it sends `openers` on each row of the list: one { treeId, steps } per other tree of
// the person's that holds a step opening it. A row without the field came from a server that does not, and costs nothing
// to say.

// The cost line for `tree` among `rows`, the switcher's list in its own order, or null where no step opens it. The
// trees named are the first two openers the list holds, in its order and titled as their rows are; an opener the list
// does not hold counts among the trees and is never named. `form` is the sentence that says it: `one` names the only
// tree, `two` both, `more` the first two and how many more, and `unnamed` counts the trees where too few can be named.
export function deleteCost(tree, rows, { untitled }) {
  const openers = Array.isArray(tree.openers) ? tree.openers : [];
  if (openers.length === 0) return null;
  const steps = openers.reduce((sum, opener) => sum + opener.steps, 0);
  const trees = openers.length;
  const opening = new Set(openers.map((opener) => opener.treeId));
  const [first, second] = rows.filter((row) => opening.has(row.id)).map((row) => row.title?.trim() || untitled);
  if (trees === 1 && first) return { form: 'one', steps, tree: first };
  if (trees === 2 && second) return { form: 'two', steps, first, second };
  if (trees > 2 && second) return { form: 'more', steps, first, second, more: trees - 2 };
  return { form: 'unnamed', steps, trees };
}

// The switcher's list once `treeId` is deleted: its row gone, and gone from every row's openers, as its steps went with it.
export function withoutTree(rows, treeId) {
  return rows
    .filter((row) => row.id !== treeId)
    .map((row) => (Array.isArray(row.openers) ? { ...row, openers: row.openers.filter((opener) => opener.treeId !== treeId) } : row));
}
