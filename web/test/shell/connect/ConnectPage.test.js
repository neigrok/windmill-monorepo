import test from 'node:test';
import assert from 'node:assert/strict';
import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

test('ChatGPT is first and selected, with OAuth settings and the complete setup path', async (t) => {
  globalThis.window = { location: { hash: '#/app/connect' }, localStorage: { getItem: () => null } };
  const { ConnectPage } = await loadScreen('shell/connect/ConnectPage.jsx');
  const view = renderHook(t, () => ConnectPage({}), { context: { status: 'ghost', user: null, open() {} } });
  const elements = elementsOf(view.tree);
  assert.deepEqual(elements.filter((item) => item.type === 'input').map((item) => [item.props.value, item.props.checked]), [
    ['chatgpt', true], ['desktop', false], ['code', false], ['cursor', false], ['codex', false], ['any', false],
  ]);
  assert.equal(textOf(elements.find((item) => item.type === 'h2')), 'ChatGPT · OpenAI');
  assert.equal(textOf(elements.find((item) => item.type === 'dl')), 'NameWindmillAuthenticationOAuth');
  assert.equal(textOf(elements.find((item) => item.type === 'pre')), 'https://windmill.works/mcp');
  assert.deepEqual(elements.filter((item) => item.type === 'li').map(textOf), [
    'In ChatGPT, open Settings → Security and login and enable Developer mode.',
    'Open Plugins and use the plus button to create a connection. Enter the settings above and a description, such as “Use Windmill from ChatGPT”.',
    'Choose OAuth, then approve access to Windmill when prompted.',
    'In a conversation, open the + menu → Developer mode and select Windmill.',
  ]);
  assert.equal(elements.find((item) => textOf(item) === 'OpenAI setup guide ↗').props.href,
    'https://developers.openai.com/plugins/deploy/connect-chatgpt');
});

test('each client copies its complete configuration and switching discards a pending result', async (t) => {
  globalThis.window = { location: { hash: '#/app/connect' }, localStorage: { getItem: () => null } };
  const { ConnectPage } = await loadScreen('shell/connect/ConnectPage.jsx');
  const writes = [];
  let complete;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: { writeText: (value) => { writes.push(value); return new Promise((resolve) => { complete = resolve; }); } },
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; });
  const view = renderHook(t, () => ConnectPage({}), { context: { status: 'signed-in', user: { id: 'member' }, open() {} } });
  const copy = () => elementsOf(view.tree).find((item) => item.props.className === 'wm-cn-copy');
  const radios = () => elementsOf(view.tree).filter((item) => item.type === 'input');
  const expected = [
    'https://windmill.works/mcp',
    'https://windmill.works/mcp',
    'claude mcp add --transport http windmill https://windmill.works/mcp',
    '{\n  "mcpServers": {\n    "windmill": { "url": "https://windmill.works/mcp" }\n  }\n}',
    '[mcp_servers.windmill]\nurl = "https://windmill.works/mcp"',
    '{\n  "mcpServers": {\n    "windmill": { "url": "https://windmill.works/mcp" }\n  }\n}',
  ];
  for (let index = 0; index < expected.length; index += 1) {
    radios()[index].props.onChange();
    const result = copy().props.onClick();
    assert.equal(textOf(copy()), 'Copying…');
    assert.equal(copy().props.disabled, true);
    assert.equal(writes[index], expected[index]);
    complete();
    await result;
    assert.equal(textOf(copy()), 'Copied');
  }
  const result = copy().props.onClick();
  radios()[0].props.onChange();
  complete();
  await result;
  assert.equal(textOf(copy()), 'Copy URL');
  assert.equal(textOf(elementsOf(view.tree).find((item) => item.props.role === 'status')), '');
});

test('clipboard failures offer manual copy and signed-out copy opens sign-in without writing', async (t) => {
  globalThis.window = { location: { hash: '#/app/connect' }, localStorage: { getItem: () => null } };
  const { ConnectPage } = await loadScreen('shell/connect/ConnectPage.jsx');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let attempts = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: { writeText: async () => { attempts += 1; throw new Error('Denied'); } },
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; });
  let signIns = 0;
  const context = { status: 'signed-in', user: { id: 'member' }, open: () => { signIns += 1; } };
  const view = renderHook(t, () => ConnectPage({}), { context });
  const copy = () => elementsOf(view.tree).find((item) => item.props.className === 'wm-cn-copy');
  await copy().props.onClick();
  assert.equal(textOf(copy()), 'Copy URL');
  assert.equal(textOf(elementsOf(view.tree).find((item) => item.props.role === 'status')),
    'Couldn’t copy. Select the text above and copy it manually.');
  context.status = 'ghost';
  context.user = null;
  view.redraw();
  await copy().props.onClick();
  assert.equal(attempts, 1);
  assert.equal(signIns, 1);
});

test('API key fallback remains reachable with sign-in requirements and a named disclosure', async (t) => {
  globalThis.window = { location: { hash: '#/app/connect' }, localStorage: { getItem: () => null } };
  const { ConnectPage } = await loadScreen('shell/connect/ConnectPage.jsx');
  const open = () => {};
  const view = renderHook(t, () => ConnectPage({}), { context: { status: 'ghost', user: null, open } });
  const summary = () => elementsOf(view.tree).find((item) => item.props.className === 'wm-cn-summary');
  const body = () => elementsOf(view.tree).find((item) => item.props.id === summary().props['aria-controls']);
  assert.equal(summary().props['aria-expanded'], false);
  assert.equal(body().props.hidden, true);
  summary().props.onClick();
  assert.equal(summary().props['aria-expanded'], true);
  assert.equal(body().props.hidden, false);
  const panel = elementsOf(body()).find((item) => item.type?.name === 'McpKeyPanel');
  assert.equal(panel.props.signedIn, false);
  assert.equal(panel.props.onRequireSignIn, open);
  assert.equal(elementsOf(body()).find((item) => item.type === 'a').props.href, '#/settings');
});
