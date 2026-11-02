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

export function addLink(ws, value) {
  const input = typeof value === 'string' ? { url: value } : value;
  const trimmed = input.url.trim();
  if (!trimmed) return ws;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return ws;
  }
  const domain = url.hostname.replace(/^www\./, '');
  const title = input.title?.trim() || domain;
  const link = { id: newId(), url: url.href, title, domain };
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

function newId() {
  return crypto.randomUUID?.() ?? `ws-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

export function formatNote(text, selection, format) {
  const start = Math.max(0, Math.min(text.length, selection.start));
  const end = Math.max(start, Math.min(text.length, selection.end));
  const { kind } = format;
  const selected = text.slice(start, end);
  if (kind === 'list') {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lastSelected = end > start ? end - 1 : end;
    const nextBreak = text.indexOf('\n', lastSelected);
    const lineEnd = nextBreak === -1 ? text.length : nextBreak;
    const lines = text.slice(lineStart, lineEnd).split('\n');
    const bullet = /^(\s*)-\s+/;
    const remove = lines.every((line) => bullet.test(line));
    const replacement = lines.map((line) => {
      if (remove) return line.replace(bullet, '$1');
      if (bullet.test(line)) return line;
      return `- ${line}`;
    }).join('\n');
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
  const markers = { bold: '**', italic: '*' };
  const marker = markers[kind];
  if (!marker) return { text, selection: { start, end } };
  const selectedMarker = Object.values(markers).find((value) => (
    selected.startsWith(value) && selected.endsWith(value) && selected.length >= value.length * 2
  ));
  if (selectedMarker) {
    const inner = selected.slice(selectedMarker.length, -selectedMarker.length);
    const nextMarker = selectedMarker === marker ? '' : marker;
    const replacement = nextMarker + inner + nextMarker;
    return {
      text: text.slice(0, start) + replacement + text.slice(end),
      selection: { start: start + nextMarker.length, end: start + nextMarker.length + inner.length },
    };
  }
  const outsideMarker = Object.values(markers).find((value) => (
    text.slice(start - value.length, start) === value && text.slice(end, end + value.length) === value
  ));
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

export class NoteDocument {
  constructor(text) {
    this.text = text;
    this.projection = null;
    this.history = [];
    this.future = [];
  }

  project(projection) {
    this.projection = { text: projection.text, source: [...projection.source] };
  }

  sourceSelection(selection) {
    const source = this.projection.source;
    const at = (offset) => {
      if (offset < source.length) return source[offset];
      if (source.length > 0) return source.at(-1) + 1;
      return 0;
    };
    return { start: at(selection.start), end: at(selection.end) };
  }

  replace(text, selection) {
    if (text === this.text) return;
    this.history.push({ text: this.text, selection });
    this.future = [];
    this.text = text;
  }

  lineBreak(selection, tokens = { start: [], end: [] }, continueList = false) {
    let { start, end } = selection;
    const collapsed = start === end;
    let closing = '';
    let opening = '';
    for (const token of tokens.start) {
      if (start === token.contentStart) start = token.start;
      else if (start === token.contentEnd) start = token.end;
      if (collapsed) end = start;
    }
    for (const token of tokens.end) {
      if (end === token.contentEnd) end = token.end;
      else if (end === token.contentStart) end = token.start;
      if (collapsed) start = end;
    }
    for (const token of tokens.start) {
      if (start <= token.contentStart || start >= token.contentEnd) continue;
      closing += this.text.slice(token.contentEnd, token.end);
    }
    for (const token of tokens.end) {
      if (end <= token.contentStart || end >= token.contentEnd) continue;
      opening = this.text.slice(token.start, token.contentStart) + opening;
    }
    const lineStart = this.text.lastIndexOf('\n', start - 1) + 1;
    const line = this.text.slice(lineStart, start);
    const bullet = continueList && line.match(/^(\s*-\s+)(.*)$/);
    let marker = '';
    if (bullet) {
      if (bullet[2]) marker = bullet[1];
      else start = lineStart;
    }
    const inserted = closing + '\n' + marker + opening;
    this.replace(this.text.slice(0, start) + inserted + this.text.slice(end), selection);
    return { start: start + inserted.length, end: start + inserted.length };
  }

  undo(redo = false, selection = null) {
    const from = redo ? this.future : this.history;
    const to = redo ? this.history : this.future;
    const previous = from.pop();
    if (!previous) return null;
    to.push({ text: this.text, selection: selection ?? previous.selection });
    this.text = previous.text;
    return previous.selection;
  }

  change(next, before) {
    const previous = this.projection;
    const collapsed = !before || before.start === before.end;
    if (next.text === previous.text && collapsed) return this.sourceSelection(next.selection);
    let start = 0;
    const sharedLength = Math.min(previous.text.length, next.text.length);
    while (start < sharedLength && previous.text[start] === next.text[start]) start += 1;
    let suffix = 0;
    while (suffix < sharedLength - start && previous.text.at(-suffix - 1) === next.text.at(-suffix - 1)) {
      suffix += 1;
    }
    if (before) {
      start = Math.min(start, before.start);
      suffix = Math.min(suffix, previous.text.length - before.end);
    }
    const end = previous.text.length - suffix;
    const nextEnd = next.text.length - suffix;
    const insertion = next.text.slice(start, nextEnd);
    let sourceStart = previous.source[start] ?? this.text.length;
    let sourceEnd = end > start ? previous.source[end - 1] + 1 : sourceStart;
    if (before?.source && start === before.start) sourceStart = before.source.start;
    if (before?.source && end === before.end) sourceEnd = before.source.end;
    const text = this.text.slice(0, sourceStart) + insertion + this.text.slice(sourceEnd);
    this.replace(text, before?.source ?? { start: sourceStart, end: sourceEnd });
    const delta = insertion.length - (sourceEnd - sourceStart);
    this.projection = {
      text: next.text,
      source: [
        ...previous.source.slice(0, start),
        ...Array.from({ length: insertion.length }, (_, index) => sourceStart + index),
        ...previous.source.slice(end).map((offset) => offset >= sourceEnd ? offset + delta : offset),
      ],
    };
    const selected = this.sourceSelection(next.selection);
    for (const edge of ['start', 'end']) {
      const offset = next.selection[edge];
      if (offset >= start && offset <= nextEnd) selected[edge] = sourceStart + offset - start;
    }
    return selected;
  }
}
