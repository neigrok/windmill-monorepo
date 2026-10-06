// Answers the account, nudge and echo reads from `fixtures.js` and leaves every other request alone.
// Dev only — `EchoLab` is the only importer, and that route is compiled out of a production build.

import { scenarioById } from './fixtures.js';

let installed = null;

export function serveEchoFixtures(id) {
  const scenario = scenarioById(id);
  if (!scenario) return null;
  if (!installed) installed = window.fetch.bind(window);
  const passThrough = installed;

  const reply = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  window.fetch = async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input.url;
    const url = new URL(href, window.location.href);
    const path = url.pathname;

    if (path === '/v1/me') return reply({ user: { id: 'u_fixture', email: 'you@windmill.test', name: 'You' } });
    if (path === '/v1/subscription') return reply({ active: scenario.entitled });
    if (path === '/v1/journal/nudge') return reply({ armed: false, enabled: false });

    if (path === '/v1/journal/echoes') {
      return reply({
        pages: scenario.echoes,
        pagesWritten: scenario.pagesWritten,
        firstEchoEver: scenario.firstEchoEver,
      });
    }
    if (path.startsWith('/v1/journal/echoes/')) return reply({ ok: true });

    return passThrough(input, init);
  };

  return scenario;
}
