// Answers the journal's own reads from `fixtures.js` and leaves every other request alone. Dev only —
// `EchoLab` is the only importer, and that route is compiled out of a production build.

import { scenarioById } from './fixtures.js';

let installed = null;

export function serveEchoFixtures(id) {
  const scenario = scenarioById(id);
  if (!scenario) return null;
  const pages = new Map(scenario.pages.map((page) => [page.day, page]));

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
    const method = (init.method || 'GET').toUpperCase();

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

    if (path === '/v1/journal/pages') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const written = [...pages.values()];
      const asked = from && to ? written.filter((page) => page.day >= from && page.day <= to) : written;
      return reply({ pages: asked.sort((a, b) => a.day.localeCompare(b.day)) });
    }

    if (path.startsWith('/v1/journal/page/')) {
      const day = path.slice('/v1/journal/page/'.length);
      if (method === 'PUT') {
        const written = { day, ...JSON.parse(init.body || '{}') };
        pages.set(day, written);
        return reply(written);
      }
      const page = pages.get(day);
      return page ? reply(page) : reply({ error: 'not found' }, 404);
    }

    return passThrough(input, init);
  };

  return scenario;
}
