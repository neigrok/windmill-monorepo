// An edge has no id of its own — its identity is the ordered (from, to) endpoint pair. This is
// the one place that folds those endpoints into a stable string key and back, so the React
// selection state and the ConnectorBatch GPU highlight can never disagree on what "this edge"
// is. The separator is NUL, which no node id (a UUID, an n-… bud, a t_… tree) ever contains.
const SEPARATOR = String.fromCharCode(0);

export const edgeKey = (from, to) => `${from}${SEPARATOR}${to}`;

export function parseEdgeKey(key) {
  const at = key.indexOf(SEPARATOR);
  return { from: key.slice(0, at), to: key.slice(at + 1) };
}
