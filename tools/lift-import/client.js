// `code` is the machine word (session-id-taken · set-id-taken · session-finished ·
// unknown-exercise); `sentence` is for a human and must never be branched on.
export class GymRefusal extends Error {
  constructor(status, code, sentence) {
    super(`${status}${code ? ` ${code}` : ''}: ${sentence}`);
    this.status = status;
    this.code = code ?? null;
    this.sentence = sentence;
  }
}

export class GymClient {
  constructor({ baseUrl, token, attempts = 4, backoffMs = 250, fetchImpl = fetch, sleep = defaultSleep }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.attempts = attempts;
    this.backoffMs = backoffMs;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  // 5xx and a dropped connection retry; 4xx is terminal, since retrying never un-spends an id.
  async send(method, path, body) {
    let lastFailure;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.token}`,
            cookie: `wm_session=${this.token}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (failure) {
        lastFailure = failure;
        await this.sleep(this.backoffMs * attempt);
        continue;
      }

      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (response.ok) return parsed;
      if (response.status >= 500) {
        lastFailure = new GymRefusal(response.status, parsed?.code, parsed?.error ?? text);
        await this.sleep(this.backoffMs * attempt);
        continue;
      }
      throw new GymRefusal(response.status, parsed?.code, parsed?.error ?? text ?? '');
    }
    throw lastFailure;
  }

  async exercises() {
    const body = await this.send('GET', '/v1/gym/exercises');
    return body?.exercises ?? [];
  }

  // joinOpenSession:false is required: without it an import run during an open workout is handed
  // that live session and files history into it.
  async startSession(id, startedAt) {
    return this.send('POST', '/v1/gym/sessions', { id, startedAt, joinOpenSession: false });
  }

  async appendSet(sessionId, set) {
    return this.send('POST', `/v1/gym/sessions/${sessionId}/sets`, set);
  }

  async finishSession(sessionId, finishedAt) {
    return this.send('POST', `/v1/gym/sessions/${sessionId}/finish`, { finishedAt });
  }

  async session(sessionId) {
    return this.send('GET', `/v1/gym/sessions/${sessionId}`);
  }
}

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
