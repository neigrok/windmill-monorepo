// The whole conversation with the training log's public API — four routes, one retry rule. The
// importer adds no backend surface: gym's write path is already idempotent by client-minted id,
// which is exactly what a re-runnable import needs, so this speaks the same wire a phone does.

// A refusal the server named. `code` is the machine word (session-id-taken · set-id-taken ·
// session-finished · unknown-exercise); the sentence beside it is for a human reading a log and
// may be reworded any day, so nothing here ever branches on it.
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

  // 400 and 409 are the client's own facts and terminal — retrying never makes a body readable, and
  // never un-spends an id. 5xx and a dropped connection are the server's, and are the two the queue
  // is meant to keep trying. That split is the entire retry policy.
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

  // Every session this tool writes is a past one, so it must never join: without the flag, an import
  // run while the lifter has a workout open no-ops on the one-open index, is handed the LIVE session
  // with a 200, and files years of history into today's workout. The refusal is 409
  // `session-already-open`, and its repair is to run again once that workout has ended.
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
