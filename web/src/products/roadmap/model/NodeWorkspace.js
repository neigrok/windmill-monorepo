// workspace: { subtasks: [{ id, label, done }], note: '', links: [{ id, url, title, domain }] }
// Every op returns a new workspace.

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

// null when there are no sub-tasks.
export function arcFraction(ws) {
  const total = ws.subtasks.length;
  if (total === 0) return null;
  const done = ws.subtasks.filter((subtask) => subtask.done).length;
  return done / total;
}

// A bare host with no scheme gets https:// prepended; null when unparseable.
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
