import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { startTransition, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import BoardView from '/src/products/roadmap/board/BoardView.jsx';
import { StepDetail } from '/src/products/roadmap/step/StepDetail.jsx';
import { StepComposer } from '/src/products/roadmap/step/StepComposer.jsx';
import { useStepAddress, stepIsStale } from '/src/products/roadmap/step/stepAddress.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { Openings } from '/src/products/roadmap/model/Opening.js';
import { TreeDoor } from '/src/products/roadmap/room/useTreeVisit.js';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { advanceProgress } from '/src/products/roadmap/model/progress.js';
import { toggleSubtask } from '/src/products/roadmap/model/NodeWorkspace.js';

const noop = () => {};
const call = (line) => (window.calls ??= []).push(line);
const bandOf = (width) => (width < 744 ? 'phone' : width < 1024 ? 'tablet' : 'desktop');
const without = (steps, id) => steps.filter((step) => step.id !== id).map((step) => ({ ...step, prerequisites: step.prerequisites.filter((need) => need !== id) }));

// Like the shell: the route follows the URL in a transition, and each roadmap is its own view, keyed by its id, that
// loads its tree a beat after it mounts.
window.openRoom = ({ nodes, completed, editable = true, workspaces = {}, kinds = [], linked = true, others = {}, editingEnabled = false, selectable = false, opens = {} }) => {
  const trees = { sail: nodes, ...others };
  const routeTree = () => window.location.hash.split('?')[0].replace('#/app/', '');
  function App() {
    const [treeId, setTreeId] = useState(routeTree);
    useEffect(() => {
      const follow = () => startTransition(() => setTreeId(routeTree()));
      window.addEventListener('hashchange', follow);
      window.addEventListener('popstate', follow);
      return () => {
        window.removeEventListener('hashchange', follow);
        window.removeEventListener('popstate', follow);
      };
    }, []);
    return React.createElement(Room, { key: treeId, treeId });
  }
  function Room({ treeId }) {
    const [steps, setSteps] = useState(null);
    useEffect(() => { Promise.resolve().then(() => setSteps(trees[treeId])); }, []);
    const tree = useMemo(() => (steps === null ? null : new SkillTree(Openings.fromWire(opens, steps).onto({ id: treeId, title: 'Learn to sail', nodes: steps }, { joined: true }))), [steps]);
    const [progress, setProgress] = useState({ completed: new Set(completed), completedAt: Object.fromEntries(completed.map((id, index) => [id, index + 1])) });
    const [selectedId, setSelectedId] = useState(null);
    const [editing, setEditing] = useState(null);
    const [spaces, setSpaces] = useState(workspaces);
    const [linkPrefix, setLinkPrefix] = useState(linked ? 'https://windmill.test/t/sail#?step=' : null);
    const [refusal, setRefusal] = useState(null);
    window.setLinkPrefix = setLinkPrefix;
    window.refuseSync = () => setRefusal({ code: 'server-error', count: 1, onRetry: () => setRefusal(null), onDiscard: () => setRefusal(null) });
    const [query, setQuery] = useState(() => new BoardQuery({ kinds }));
    const [quiet, setQuiet] = useState(0);
    const [breakpoint, setBreakpoint] = useState(() => bandOf(window.innerWidth));
    const address = useStepAddress();
    useEffect(() => {
      const follow = () => setBreakpoint(bandOf(window.innerWidth));
      window.addEventListener('resize', follow);
      return () => window.removeEventListener('resize', follow);
    }, []);
    useEffect(() => {
      if (editing && address.id !== editing) setEditing(null);
    }, [editing, address.id]);
    const stale = stepIsStale({ loading: tree === null, tree, treeId, stepId: address.id });
    useEffect(() => { if (stale) address.drop(); }, [stale]);
    const mark = (id, target) => setProgress((current) => advanceProgress(current, [id], target, Date.now()));
    window.restoreSteps = () => setSteps(trees[treeId]);
    if (tree === null) return null;
    const open = address.id !== null && tree.nodesById.has(address.id);
    return React.createElement(TreeDoor.Provider, { value: (id, door) => call('tree ' + id + ' ' + door) }, React.createElement('div', { style: { position: 'fixed', inset: 0 } },
      React.createElement('div', { className: 'st-view-layer--board is-active', inert: open ? '' : undefined, style: { position: 'absolute', inset: 0, zIndex: 18, visibility: open ? 'hidden' : undefined } },
        React.createElement(BoardView, { tree, completed: progress.completed, completedAt: progress.completedAt, selectedId,
          onSelect: (id) => { setSelectedId(id); address.open(id, 'card'); }, onAnchor: setSelectedId, breakpoint, active: true,
          onSwitchView: noop, query, onQuery: setQuery, quiet })),
      open && React.createElement(StepDetail, {
        tree, completed: progress.completed, completedAt: progress.completedAt, address, breakpoint, roadmapTitle: 'Learn to sail',
        editable, deletable: tree.roots().length !== 1 || tree.roots()[0].id !== address.id, stepLink: linkPrefix ? linkPrefix + address.id : null, refusal,
        workspace: spaces[address.id] ?? { subtasks: [], note: '', links: [] },
        workspaceActions: { onToggleSubtask: (nodeId, subtaskId) => setSpaces((current) => ({ ...current, [nodeId]: toggleSubtask(current[nodeId], subtaskId) })),
          onAddSubtask: noop, onEditSubtask: noop, onDeleteSubtask: noop, onSetNote: (nodeId) => call('note ' + nodeId), onAddLink: noop, onDeleteLink: noop },
        history: [],
        onEdit: editingEnabled ? (id) => setEditing(id) : undefined,
        onOpenStep: (id) => address.open(id, 'step'),
        onBack: address.back,
        onClose: () => { const origin = address.trail[0]; address.close(); setSelectedId(origin); },
        onComplete: (id) => { call('complete ' + id); mark(id, 'complete'); },
        onReset: (id) => { call('reset ' + id); mark(id, 'none'); },
        onRestore: (id, snapshot) => {
          if (window.restoreFails) throw new Error('private content');
          call('restore ' + id);
          setQuiet((current) => current + 1);
          mark(id, snapshot.completed.has(id) ? 'complete' : 'none');
        },
        onOpenInGraph: (id) => call('graph ' + id),
        onSelect: selectable ? (id) => call('select ' + id) : undefined,
        onViewBranch: (id) => { call('branch ' + id); address.close(); setQuery((current) => current.inBranch(id)); },
        onDelete: (id) => { call('delete ' + id); address.close(); setSteps((current) => without(current, id)); },
        onNotify: (message) => call('notify ' + message),
      }),
      open && editing === address.id && React.createElement(StepComposer, {
        tree, completed: progress.completed, legend: [], band: breakpoint, editing,
        onCreate: noop,
        onClose: () => setEditing(null),
        onEdit: (request) => {
          (window.editRequests ??= []).push(request);
          setQuiet((current) => current + 1);
          setSteps((current) => current.map((node) => node.id === request.id ? { ...node, ...request } : node));
          return { ok: true };
        },
      })));
  }
  createRoot(document.getElementById('root')).render(React.createElement(App));
};
window.entryReady = true;
`;

export const learnToSailNodes = [
  { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta' },
  { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky', description: 'Identify the mast, boom, hull and rudder.' },
  { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta' },
  { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive' },
  { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky', description: 'Learn to spot shifts in wind direction.',
    links: [{ url: 'https://example.com/sailing', label: 'Sailing basics' }] },
  { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta', description: 'Cast off safely and steer clear of the dock.' },
  { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive' },
  { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold' },
];

export function createStepDetailHost(name) {
  let server, browser, webkitBrowser, origin, cacheDir, ready;

  function start() {
    ready ??= (async () => {
      cacheDir = await mkdtemp(`${root}node_modules/.vite-step-${name}-`);
      server = await createServer({ configFile: false, root, cacheDir,
        plugins: [{ name: 'step-detail-test', enforce: 'pre',
          resolveId(id) {
            if (id === '/step-detail-entry.js') return '\0step-detail-entry';
            if (id.endsWith('/telemetry/beacon.js')) return '\0step-detail-beacon';
            if (id.endsWith('/reportFailure.js')) return '\0step-detail-report';
          },
          load(id) {
            if (id === '\0step-detail-entry') return entry;
            if (id === '\0step-detail-beacon') {
              return 'export function track(name, props) { (window.events ??= []).push(`${name} ${JSON.stringify(props)}`); }\n'
                + 'export function reportError() {}\nexport function routeFamily(route) { return route; }';
            }
            if (id === '\0step-detail-report') {
              return 'export function reportRoadmapFailure(operation) { (window.reports ??= []).push(operation); }\n'
                + 'export function reportUnexpectedFailure(operation) { (window.reports ??= []).push(operation); }';
            }
          },
          configureServer(server) {
            server.middlewares.use('/step-detail-test', (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Step detail test</title><div id="root"></div><script type="module" src="/step-detail-entry.js"></script>');
            });
          },
        }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
        server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
      const serverReady = once(server.httpServer, 'listening');
      server.httpServer.listen(0, '127.0.0.1');
      await serverReady;
      origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      browser = await chromium.launch({ headless: true });
    })();
    return ready;
  }

  async function openRoom({ viewport, nodes = learnToSailNodes, editable = true, workspaces = {}, kinds = [], linked = true, others = {}, start = '#/app/sail', clock = false, permissions = [], editingEnabled = false, opens = {}, engine = 'Chromium' }, errors) {
    if (engine === 'WebKit') webkitBrowser ??= await webkit.launch({ headless: true });
    const context = await (engine === 'WebKit' ? webkitBrowser : browser).newContext({ viewport, permissions });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    if (clock) await page.clock.install();
    await page.goto(`${origin}/step-detail-test${start}`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate((options) => openRoom(options), { nodes, completed: ['course', 'parts', 'rig'], editable, workspaces, kinds, linked, others, editingEnabled, opens });
    await page.locator('.st-board').waitFor({ state: 'attached' });
    return page;
  }

  async function close() {
    try { await ready; } finally {
      try { await Promise.all([browser?.close(), webkitBrowser?.close()]); } finally {
        try { await server?.close(); } finally {
          if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
        }
      }
    }
  }

  return { start, openRoom, close, get browser() { return browser; }, get origin() { return origin; } };
}

export const events = (page) => page.evaluate(() => window.events ?? []);
export const calls = (page) => page.evaluate(() => window.calls ?? []);
export const hash = (page) => page.evaluate(() => window.location.hash);
export const focusedName = (page) => page.evaluate(() => {
  const element = document.activeElement;
  return element.getAttribute('aria-label') ?? element.querySelector('.st-board-card-title')?.textContent ?? element.textContent;
});

export const card = (page, label) => page.locator('.st-board-card:visible', { has: page.locator('.st-board-card-title', { hasText: new RegExp(`^${label}$`) }) });
