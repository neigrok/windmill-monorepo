export async function readCoachStream(response, onSnapshot, errorFrom) {
  if (!response.body) throw new Error('Response interrupted.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const revisions = new Map();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        let event = '';
        const data = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length || !['snapshot', 'error'].includes(event)) continue;
        const body = JSON.parse(data.join('\n'));
        if (event === 'error') throw errorFrom(body);
        const generation = body.generation;
        if (!generation || !Number.isInteger(generation.revision) || typeof generation.answer !== 'string') {
          throw new Error('Response interrupted.');
        }
        const previous = revisions.get(generation.id) ?? -1;
        if (generation.revision <= previous) continue;
        revisions.set(generation.id, generation.revision);
        onSnapshot(body);
        if (['completed', 'failed', 'stopped'].includes(generation.status)) {
          return body;
        }
      }
      if (done) break;
      if (buffer.length > 1048576) throw new Error('Response interrupted.');
    }
    throw new Error('Response interrupted.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
