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
  const input = typeof rawUrl === 'string' ? { url: rawUrl } : rawUrl;
  const link = parseLink(input.url);
  if (link && input.title?.trim()) link.title = input.title.trim();
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

export function formatNote(text, selection, format) {
  const start = Math.max(0, Math.min(text.length, selection.start));
  const end = Math.max(start, Math.min(text.length, selection.end));
  const kind = typeof format === 'string' ? format : format.kind;
  const selected = text.slice(start, end);
  if (kind === 'list') {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lastSelected = end > start ? end - 1 : end;
    const nextBreak = text.indexOf('\n', lastSelected);
    const lineEnd = nextBreak === -1 ? text.length : nextBreak;
    const lines = text.slice(lineStart, lineEnd).split('\n');
    const remove = lines.every((line) => line.startsWith('- '));
    const replacement = lines.map((line) => remove ? line.slice(2) : line.startsWith('- ') ? line : `- ${line}`).join('\n');
    return {
      text: text.slice(0, lineStart) + replacement + text.slice(lineEnd),
      selection: { start: lineStart, end: lineStart + replacement.length },
    };
  }
  if (kind === 'link') {
    const label = format.text || selected || format.url;
    const replacement = `[${label}](${format.url})`;
    return {
      text: text.slice(0, start) + replacement + text.slice(end),
      selection: { start: start + 1, end: start + 1 + label.length },
    };
  }
  const marker = kind === 'bold' ? '**' : kind === 'italic' ? '*' : '';
  if (!marker) return { text, selection: { start, end } };
  const selectedMarker = selected.startsWith('**') && selected.endsWith('**') && selected.length >= 4 ? '**'
    : selected.startsWith('*') && selected.endsWith('*') && selected.length >= 2 ? '*' : null;
  if (selectedMarker) {
    const inner = selected.slice(selectedMarker.length, -selectedMarker.length);
    const nextMarker = selectedMarker === marker ? '' : marker;
    const replacement = nextMarker + inner + nextMarker;
    return { text: text.slice(0, start) + replacement + text.slice(end), selection: { start: start + nextMarker.length, end: start + nextMarker.length + inner.length } };
  }
  const outsideMarker = text.slice(start - 2, start) === '**' && text.slice(end, end + 2) === '**' ? '**'
    : text.slice(start - 1, start) === '*' && text.slice(end, end + 1) === '*' ? '*' : null;
  if (outsideMarker) {
    const nextMarker = outsideMarker === marker ? '' : marker;
    const replacement = nextMarker + selected + nextMarker;
    const offset = start - outsideMarker.length + nextMarker.length;
    return {
      text: text.slice(0, start - outsideMarker.length) + replacement + text.slice(end + outsideMarker.length),
      selection: { start: offset, end: offset + selected.length },
    };
  }
  return {
    text: text.slice(0, start) + marker + selected + marker + text.slice(end),
    selection: { start: start + marker.length, end: end + marker.length },
  };
}
