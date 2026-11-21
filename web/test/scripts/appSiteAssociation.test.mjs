import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { appSiteAssociation, associationBody } from '../../scripts/appSiteAssociation.js';

test("the association file names the team's app and claims a roadmap's two addresses alone", () => {
  assert.equal(associationBody('ABCDE12345'),
    '{"applinks":{"details":[{"appIDs":["ABCDE12345.works.windmill.app"],"components":[{"/":"/t/*"},{"/":"/","#":"/app/t_*"}]}]}}');
});

test('a team identifier that is not ten capitals and digits is refused, as the iPhone release refuses it', () => {
  for (const team of [undefined, '', 'content', 'abcde12345', 'ABCDE1234', 'ABCDE123456', 'ABCDE-2345', 'ABCDE12345\n']) {
    assert.throws(() => associationBody(team), { name: 'Error', message: 'APPLE_TEAM_ID must be the ten-character Apple team identifier.' });
  }
});

test('the build writes the file where iOS asks for it, writes none and says so without a team, and stops on a malformed one', (t) => {
  const said = t.mock.method(console, 'log', () => {});
  const written = (team) => {
    const files = [];
    appSiteAssociation(team).generateBundle.call({ emitFile: (file) => files.push(file) });
    return files;
  };

  assert.deepEqual(written('ABCDE12345'), [{
    type: 'asset',
    fileName: '.well-known/apple-app-site-association',
    source: '{"applinks":{"details":[{"appIDs":["ABCDE12345.works.windmill.app"],"components":[{"/":"/t/*"},{"/":"/","#":"/app/t_*"}]}]}}',
  }]);
  assert.deepEqual(said.mock.calls.map((call) => call.arguments), []);
  assert.deepEqual([written(undefined), written('')], [[], []]);
  assert.deepEqual(said.mock.calls.map((call) => call.arguments), [
    ['App site association: not written, APPLE_TEAM_ID is not set'],
    ['App site association: not written, APPLE_TEAM_ID is not set'],
  ]);
  assert.throws(() => appSiteAssociation('content'), { name: 'Error', message: 'APPLE_TEAM_ID must be the ten-character Apple team identifier.' });
});

test("every address the backend builds for a roadmap is one the file claims, and the site's other doors stay the browser's", () => {
  const { cases } = JSON.parse(readFileSync(new URL('../../../packages/api-contract/roadmap-addresses.json', import.meta.url), 'utf8'));
  const [{ components }] = JSON.parse(associationBody('ABCDE12345')).applinks.details;
  const matches = (pattern, text) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(text);
  const claimed = (address) => {
    const url = new URL(address, 'https://windmill.example');
    return components.some((component) => matches(component['/'] ?? '*', url.pathname) && matches(component['#'] ?? '*', url.hash.slice(1)));
  };

  assert.deepEqual(cases.filter((one) => !claimed(one.address)).map((one) => one.address), []);
  assert.deepEqual(['/', '/#/', '/#/app', '/#/app/new', '/#/app/start', '/#/auth?token=secret', '/#/settings', '/#/journal',
    '/#/gym/shared/token', '/app/roadmap', '/app/journal', '/app/gym', '/roadmap', '/gallery', '/pricing.html'].filter(claimed), []);
});
