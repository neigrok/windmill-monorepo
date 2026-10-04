// `code` is the machine word; `sentence` is for a human and must never be branched on.
export class GymRefusal extends Error {
  constructor(status, code, sentence) {
    super(`${status}${code ? ` ${code}` : ''}: ${sentence}`);
    this.status = status;
    this.code = code ?? null;
    this.sentence = sentence;
  }
}

export class GymClient {
  constructor({ baseUrl, token, attempts = 4, backoffMs = 250, timeoutMs = 15_000,
    fetchImpl = fetch, sleep = defaultSleep }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.attempts = attempts;
    this.backoffMs = backoffMs;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  // Every retry sends the same bytes, even if the first attempt committed before its reply was lost.
  async send(method, path, body) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    let lastFailure;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error('request timed out')), this.timeoutMs);
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.token}`,
            cookie: `wm_session=${this.token}`,
          },
          body: encoded,
          signal: controller.signal,
          redirect: 'error',
        });
        const text = await response.text();
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (failure) {
          if (response.ok) throw failure;
        }
        if (response.ok) return { status: response.status, body: parsed };
        const sentence = parsed?.error ?? text;
        const refusal = new GymRefusal(response.status, parsed?.code,
          parsed?.sessionId ? `${sentence} (session ${parsed.sessionId})` : sentence);
        if (response.status < 500) throw refusal;
        lastFailure = refusal;
      } catch (failure) {
        if (failure instanceof GymRefusal && failure.status < 500) throw failure;
        if (response?.status >= 400 && response.status < 500)
          throw new GymRefusal(response.status, null, 'could not read the refusal reply');
        lastFailure = controller.signal.aborted ? controller.signal.reason : failure;
      } finally {
        clearTimeout(deadline);
      }
      if (attempt < this.attempts) await this.sleep(this.backoffMs * attempt);
    }
    throw lastFailure;
  }

  async exercises() {
    const { body } = await this.send('GET', '/v1/gym/exercises');
    return body?.exercises ?? [];
  }

  async importSession(session) {
    const response = await this.send('POST', '/v1/gym/sessions/import', session);
    if (![200, 201].includes(response.status) || response.body?.session?.id !== session.id
        || !Array.isArray(response.body?.sets))
      throw new Error('the import reply did not contain the requested workout');
    return response;
  }
}

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
