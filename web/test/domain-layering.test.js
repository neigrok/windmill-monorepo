// The kit and the product domains are the web's pure-logic layers (docs/foundation/domain-kit.md §2):
// each file imports only what its row allows, names no clock, randomness, platform or concurrency,
// and opts into tsc. A Vite build bundles any of those happily, so this test is the wall, and
// `npm run build` runs it before bundling. The rules live here, in code; one fixture per rule under
// test/fixtures/domain-layering/ keeps every rule firing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(WEB, 'src', 'platform', 'domain-kit');
const PRODUCTS = path.join(WEB, 'src', 'products');
const FIXTURES = path.join(WEB, 'test', 'fixtures', 'domain-layering');

const NAME = '[\\w-]+';
const IMPORTS = {
  kit: [
    new RegExp(`^(?:\\.\\./){4}packages/api-contract/sync/reference/core/${NAME}\\.js$`),
    /^\.\.\/sync\/core\/(?:encoding|content)\.js$/,
    new RegExp(`^\\./${NAME}\\.js$`),
  ],
  domain: [
    new RegExp(`^\\.\\./\\.\\./\\.\\./platform/domain-kit/${NAME}\\.js$`),
    new RegExp(`^(?:\\.\\./){5}packages/api-contract/sync/reference/core/${NAME}\\.js$`),
    /^\.\.\/\.\.\/\.\.\/platform\/sync\/core\/(?:encoding|content)\.js$/,
    /^\.\.\/\.\.\/\.\.\/platform\/sync\/schema\.js$/,
    new RegExp(`^\\./${NAME}\\.js$`),
  ],
};
const TOKENS = new Set(['Date', 'crypto', 'performance', 'setTimeout', 'setInterval', 'queueMicrotask',
  'requestAnimationFrame', 'Promise', 'fetch', 'indexedDB', 'window', 'document', 'globalThis', 'navigator',
  'self', 'localStorage', 'sessionStorage', 'console', 'Intl', 'eval', 'Function', 'localeCompare']);
// Rounding is the quantum's, which values.js takes from the engine's core; nothing else rounds.
const ROUNDING = new Set(['toFixed', 'toPrecision', 'Math.round']);
const CHAINS = new Set(['Math.random', 'Math.round']);
// runner.js is the kit's one impure file: it awaits the engine's commit, and nothing else is let through.
const EXEMPTIONS = { 'runner.js': ['async', 'await', 'Promise'] };

const isNode = (value) => value !== null && typeof value === 'object' && typeof value.type === 'string';

function walk(node, visit, parent = null) {
  visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => { if (isNode(item)) walk(item, visit, node); });
    else if (isNode(value)) walk(value, visit, node);
  }
}

// `directory` is where the file lives, for the existence check; fixtures pass null and pose as `name`.
function findings({ layer, name, text, directory }) {
  const found = [];
  const report = (line, message, token = null) => found.push({ line, message, token });
  const rounds = layer === 'kit' && name === 'values.js';
  if (text.split('\n')[0] !== '// @ts-check') report(1, 'first line is not // @ts-check');

  let program;
  try {
    program = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (error) {
    report(1, `parse error: ${error.message}`);
    return finish(found, layer, name);
  }

  const checkImport = (specifier, line) => {
    if (!IMPORTS[layer].some((shape) => shape.test(specifier))) return report(line, `import '${specifier}' is not a ${layer} import`);
    if (directory && !fs.existsSync(path.resolve(directory, specifier))) report(line, `import '${specifier}' does not exist`);
  };
  const checkName = (identifier) => {
    const { name: word } = identifier;
    const line = identifier.loc.start.line;
    if (TOKENS.has(word) || word.startsWith('toLocale')) report(line, `token ${word}`, word);
    if (ROUNDING.has(word) && !rounds) report(line, `token ${word}`, word);
    if (word.startsWith('_') && word !== '_') report(line, `identifier ${word} begins with an underscore`);
  };

  walk(program, (node, parent) => {
    const line = node.loc.start.line;
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node.source) checkImport(node.source.value, line);
        break;
      case 'ImportExpression':
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') checkImport(node.source.value, line);
        else report(line, 'dynamic import of a computed specifier');
        break;
      case 'Identifier':
        // A page's document is data; only a reference or binding can name the browser global.
        if (node.name === 'document' && !parent?.computed &&
          (parent?.type === 'MemberExpression' && parent.property === node ||
            parent?.type === 'Property' && parent.key === node && !parent.shorthand ||
            parent?.type === 'MethodDefinition' && parent.key === node)) break;
        checkName(node);
        break;
      case 'MemberExpression': {
        if (node.computed || node.object.type !== 'Identifier') break;
        const chain = `${node.object.name}.${node.property.name}`;
        if (CHAINS.has(chain) && !(ROUNDING.has(chain) && rounds)) report(line, `token ${chain}`, chain);
        break;
      }
      case 'MetaProperty':
        report(line, 'token import.meta', 'import.meta');
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.async) report(line, 'token async', 'async');
        break;
      case 'AwaitExpression':
        report(line, 'token await', 'await');
        break;
      case 'ForOfStatement':
        if (node.await) report(line, 'token await', 'await');
        break;
      default:
        break;
    }
  });
  return finish(found, layer, name);
}

function finish(found, layer, name) {
  const exempt = new Set(layer === 'kit' && Object.hasOwn(EXEMPTIONS, name) ? EXEMPTIONS[name] : []);
  return found
    .filter((finding) => !exempt.has(finding.token))
    .sort((a, b) => a.line - b.line || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0))
    .map((finding) => `${finding.line}: ${finding.message}`);
}

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return path.extname(entry.name) === '.js' ? [full] : [];
  });
}

const scan = (layer, file) => findings({ layer, name: path.basename(file), text: fs.readFileSync(file, 'utf8'), directory: path.dirname(file) });

// A fixture's header: `// layer: kit|domain`, `// file: <the basename it poses as>`, `// expect: <finding>`…
function fixture(file) {
  const text = fs.readFileSync(file, 'utf8');
  const header = (key) => text.split('\n').filter((line) => line.startsWith(`// ${key}:`)).map((line) => line.slice(key.length + 4).trim());
  const [layer] = header('layer');
  assert.ok(layer === 'kit' || layer === 'domain', `${path.basename(file)} names no layer`);
  return { layer, name: header('file')[0] ?? path.basename(file), text, expected: header('expect') };
}

const fixtures = fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.js')).sort();
assert.ok(fixtures.length > 0, 'no fixture under test/fixtures/domain-layering');

for (const name of fixtures) {
  test(`fixture ${name}`, () => {
    const { layer, name: posedAs, text, expected } = fixture(path.join(FIXTURES, name));
    assert.deepEqual(findings({ layer, name: posedAs, text, directory: null }), expected);
  });
}

// Fixtures pose as files and resolve nothing; a real file's relative import must also be there.
test('a relative import of a real file names a file that exists', () => {
  const text = "// @ts-check\nimport { Path } from './values.js';\nimport { gone } from './missing.js';\nexport const both = [Path, gone];\n";
  assert.deepEqual(findings({ layer: 'kit', name: 'entities.js', text, directory: path.join(WEB, 'test', 'fixtures') }),
    ["2: import './values.js' does not exist", "3: import './missing.js' does not exist"]);
  assert.deepEqual(findings({ layer: 'kit', name: 'entities.js', text, directory: null }), []);
});

test('the exemption list is exactly runner.js, for awaiting the engine', () => {
  assert.deepEqual(EXEMPTIONS, { 'runner.js': ['async', 'await', 'Promise'] });
});

test('every kit and domain file has no finding', (t) => {
  const kitFiles = sourceFiles(KIT);
  const domainFiles = (fs.existsSync(PRODUCTS) ? fs.readdirSync(PRODUCTS) : [])
    .flatMap((product) => sourceFiles(path.join(PRODUCTS, product, 'domain')));
  assert.ok(kitFiles.length > 0, 'no kit file was scanned');
  const faulted = [...kitFiles.map((file) => [file, scan('kit', file)]), ...domainFiles.map((file) => [file, scan('domain', file)])]
    .filter(([, found]) => found.length > 0)
    .map(([file, found]) => `${path.relative(WEB, file)}: ${found.join('; ')}`);
  assert.deepEqual(faulted, []);
  t.diagnostic(`${kitFiles.length} kit files and ${domainFiles.length} domain files scanned, 0 findings`);
});
