import { API_BASE } from '../../shell/apiBase.js';
import { readCoachStream } from './coach/stream.js';
import { GymError } from './errors.js';

const base = `${API_BASE}/v1/gym`;

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return response;
}

async function json(response) {
  if (response.status === 204) return null;
  if (response.ok) return response.json();
  const body = await response.json().catch(() => null);
  throw new GymError(response.status, body?.error ?? '', body?.code ?? '', body);
}

export const gymApi = {
  async shareSession(id) {
    return json(await call(`/sessions/${id}/share`, { method: 'POST' }));
  },

  async revokeShare(id) {
    const response = await call(`/sessions/${id}/share`, { method: 'DELETE' });
    if (response.status === 404) return null;
    return json(response);
  },

  async sharedSession(token) {
    const response = await call(`/shared/${encodeURIComponent(token)}`);
    if (response.status === 404) return null;
    return json(response);
  },

  async ask(thread, question, requestId, { attachmentIds } = {}) {
    const response = await call('/ask', {
      method: 'POST', body: JSON.stringify({ thread, question, ...(requestId ? { requestId } : {}), ...(attachmentIds?.length ? { attachmentIds } : {}) }),
    });
    const reply = await json(response);
    return { ...reply, pending: response.status === 202 };
  },

  async askStream(thread, question, requestId, { attachmentIds, signal, onSnapshot } = {}) {
    const response = await call('/ask', {
      method: 'POST', signal,
      body: JSON.stringify({ thread, question, requestId, stream: true, ...(attachmentIds?.length ? { attachmentIds } : {}) }),
    });
    if (!response.ok) return json(response);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const reply = await json(response);
      return { ...reply, pending: response.status === 202 };
    }
    return readCoachStream(response, (snapshot) => {
      if (snapshot.thread !== thread || snapshot.generation.requestId !== requestId) throw new Error('Response interrupted.');
      onSnapshot(snapshot);
    }, (body) => new GymError(body.status ?? 500, body.error ?? 'Response interrupted.', body.code ?? '', body));
  },

  async stopCoach(thread, requestId) {
    return json(await call(`/threads/${encodeURIComponent(thread)}/generations/${encodeURIComponent(requestId)}/stop`, { method: 'POST' }));
  },

  async uploadCoachPhoto(thread, id, blob, { signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const upload = new XMLHttpRequest();
      const abort = () => upload.abort();
      const finish = (run) => { signal?.removeEventListener('abort', abort); run(); };
      upload.open('PUT', `${base}/threads/${encodeURIComponent(thread)}/attachments/${encodeURIComponent(id)}`);
      upload.withCredentials = true;
      upload.setRequestHeader('content-type', blob.type);
      upload.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
      upload.onload = () => finish(() => {
        let body;
        try { body = JSON.parse(upload.responseText); } catch { reject(new Error('Photo didn’t upload.')); return; }
        if (upload.status >= 200 && upload.status < 300) {
          if (body.attachment?.id !== id) { reject(new Error('Photo didn’t upload.')); return; }
          resolve(body.attachment);
          return;
        }
        reject(new GymError(upload.status, body.error ?? 'Photo didn’t upload.', body.code ?? '', body));
      });
      upload.onerror = () => finish(() => reject(new Error('Photo didn’t upload.')));
      upload.onabort = () => finish(() => reject(new DOMException('Upload canceled.', 'AbortError')));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { finish(() => reject(new DOMException('Upload canceled.', 'AbortError'))); return; }
      upload.send(blob);
    });
  },

  async coachPhoto(thread, id, { signal } = {}) {
    const response = await call(`/threads/${encodeURIComponent(thread)}/attachments/${encodeURIComponent(id)}`, { signal });
    if (!response.ok) return json(response);
    return response.blob();
  },

  async threads(page) {
    const query = new URLSearchParams(page ?? {});
    const reply = await json(await call(`/threads${page ? `?${query}` : ''}`));
    return page ? reply : reply.threads;
  },

  async thread(id, page) {
    const query = new URLSearchParams(page ?? {});
    const response = await call(`/threads/${encodeURIComponent(id)}${page ? `?${query}` : ''}`);
    if (response.status === 404) return null;
    return json(response);
  },

  async deleteThread(id) {
    return json(await call(`/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  },

};
