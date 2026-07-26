// The per-node workspace (F13 — Node workspace): the sub-tasks, a free note, and
// the saved links that hang off a single step. A pure domain module — every op
// takes a workspace and returns a NEW one, so callers stay immutable and the
// persistence layer + arc feed always read a fresh value. No I/O lives here.
//
//   workspace: { subtasks: [{ id, label, done }], note: '', links: [{ id, url, title, domain }] }

export function emptyWorkspace() {
  return { subtasks: [], note: '', links: [] };
}

export function addSubtask(ws, label) {
  const text = label.trim();
  if (!text) return ws;
  return { ...ws, subtasks: [...ws.subtasks, { id: newId(), label: text, done: false }] };
}

export function toggleSubtask(ws, subtaskId) {
  return {
    ...ws,
    subtasks: ws.subtasks.map((subtask) =>
      subtask.id === subtaskId ? { ...subtask, done: !subtask.done } : subtask),
  };
}

export function editSubtask(ws, subtaskId, label) {
  const text = label.trim();
  if (!text) return ws;
  return {
    ...ws,
    subtasks: ws.subtasks.map((subtask) =>
      subtask.id === subtaskId ? { ...subtask, label: text } : subtask),
  };
}

export function deleteSubtask(ws, subtaskId) {
  return { ...ws, subtasks: ws.subtasks.filter((subtask) => subtask.id !== subtaskId) };
}

export function setNote(ws, markdown) {
  return { ...ws, note: markdown };
}

export function addLink(ws, rawUrl) {
  const link = parseLink(rawUrl);
  if (!link) return ws;
  return { ...ws, links: [...ws.links, link] };
}

export function deleteLink(ws, linkId) {
  return { ...ws, links: ws.links.filter((link) => link.id !== linkId) };
}

// The gauge behind the node: done/total when there are sub-tasks, else no arc.
export function arcFraction(ws) {
  const total = ws.subtasks.length;
  if (total === 0) return null;
  const done = ws.subtasks.filter((subtask) => subtask.done).length;
  return done / total;
}

// Parse a pasted link into { url, title, domain }. A bare host with no scheme
// gets https:// prepended; the domain is the hostname without www.; the title
// defaults to that domain. An unparseable string yields no link.
function parseLink(rawUrl) {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const domain = url.hostname.replace(/^www\./, '');
  return { id: newId(), url: url.href, title: domain, domain };
}

function newId() {
  return crypto.randomUUID?.() ?? `ws-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}
