// Edge identity is the ordered (from, to) pair. Separator is NUL: no node id contains it.
const SEPARATOR = String.fromCharCode(0);

export const edgeKey = (from, to) => `${from}${SEPARATOR}${to}`;

export function parseEdgeKey(key) {
  const at = key.indexOf(SEPARATOR);
  return { from: key.slice(0, at), to: key.slice(at + 1) };
}
