// Source read as syntax trees for the catalog test and the copy guard; JSX arrives as $jsx(type, props, ...children).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { transformSync } from 'esbuild';
import { AVAILABLE_LOCALES } from '../../../src/platform/i18n/index.js';
import { parseMessage } from '../../../src/platform/i18n/message.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const COPY_PROPS = new Set([
  'aria-label', 'aria-description', 'aria-valuetext', 'aria-roledescription', 'aria-placeholder',
  'ariaLabel', 'title', 'label', 'placeholder', 'alt', 'badge', 'failure',
]);

export function sourceFiles(root) {
  const full = path.join(WEB, root);
  if (fs.statSync(full).isFile()) return [root];
  return fs.readdirSync(full, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? sourceFiles(path.join(root, entry.name)) : [path.join(root, entry.name)]))
    .filter((file) => /\.jsx?$/.test(file))
    .sort();
}

function parseSource(file) {
  const text = fs.readFileSync(path.join(WEB, file), 'utf8');
  const code = file.endsWith('.jsx')
    ? transformSync(text, { loader: 'jsx', jsx: 'transform', jsxFactory: '$jsx', jsxFragment: '$fragment' }).code
    : text;
  return { text, ast: parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) };
}

function walk(node, visit, parent = null) {
  visit(node, parent);
  for (const value of Object.values(node)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) if (child && typeof child.type === 'string') walk(child, visit, node);
  }
}

function lineLocator(text) {
  const lines = text.split('\n');
  const searched = new Map();
  return (value) => {
    const needle = value.trim().split('\n')[0].slice(0, 40);
    for (let at = text.indexOf(needle, searched.get(needle) ?? 0); at !== -1; at = text.indexOf(needle, at + 1)) {
      const line = text.slice(0, at).split('\n').length;
      if (/^\s*(\/\/|\/\*|\*)/.test(lines[line - 1])) continue;
      searched.set(needle, at + needle.length);
      return line;
    }
    return '?';
  };
}

function keyName(property) {
  if (property.type !== 'Property' || property.computed) return null;
  return property.key.type === 'Identifier' ? property.key.name : String(property.key.value);
}

function renderedStrings(node) {
  if (!node) return [];
  if (node.type === 'Literal') return typeof node.value === 'string' ? [node.value] : [];
  if (node.type === 'TemplateLiteral') return [...node.quasis.map((quasi) => quasi.value.cooked), ...node.expressions.flatMap(renderedStrings)];
  if (node.type === 'ConditionalExpression') return [...renderedStrings(node.consequent), ...renderedStrings(node.alternate)];
  if (node.type === 'LogicalExpression') return [...(node.operator === '&&' ? [] : renderedStrings(node.left)), ...renderedStrings(node.right)];
  if (node.type === 'BinaryExpression' && node.operator === '+') return [...renderedStrings(node.left), ...renderedStrings(node.right)];
  if (node.type === 'SequenceExpression') return renderedStrings(node.expressions.at(-1));
  return [];
}

export function copyHits(file, allowed) {
  const { text, ast } = parseSource(file);
  const lineOf = lineLocator(text);
  const hits = [];
  const report = (where, value) => {
    if (/\p{L}/u.test(value) && !allowed.has(value.trim())) hits.push(`${file}:${lineOf(value)} ${where}${JSON.stringify(value)}`);
  };
  walk(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.name !== '$jsx') return;
    const [, props, ...children] = node.arguments;
    for (const property of props?.type === 'ObjectExpression' ? props.properties : []) {
      const name = keyName(property);
      if (COPY_PROPS.has(name)) for (const value of renderedStrings(property.value)) report(`${name}=`, value);
    }
    for (const child of children) for (const value of renderedStrings(child)) report('text ', value);
  });
  return hits;
}

function argumentNames(nodes) {
  return nodes.flatMap((node) => {
    if (typeof node === 'string' || node.type === 'count') return [];
    return [node.name, ...Object.values(node.options ?? {}).flatMap(argumentNames)];
  });
}

function translationCalls(file, index) {
  const { text, ast } = parseSource(file);
  const specifiers = ast.body
    .filter((node) => node.type === 'ImportDeclaration' && path.resolve(path.dirname(path.join(WEB, file)), node.source.value) === index)
    .flatMap((node) => node.specifiers);
  const misuse = new Set();
  if (specifiers.some((specifier) => specifier.type !== 'ImportSpecifier' || specifier.imported.name !== 't')) misuse.add(`${file} imports its owner's i18n other than as { t }`);
  const local = specifiers.find((specifier) => specifier.type === 'ImportSpecifier' && specifier.imported.name === 't')?.local.name;
  if (!local) return { calls: [], misuse: [...misuse] };

  const lineOf = lineLocator(text);
  const calls = [];
  const seen = new Set();
  walk(ast, (node, parent) => {
    if (node.type !== 'Identifier' || node.name !== local || seen.has(node.start)) return;
    seen.add(node.start);
    if (parent.type === 'ImportSpecifier') return;
    if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
    if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent.type) && parent.key === node && !parent.computed && !parent.shorthand) return;
    if (parent.type !== 'CallExpression' || parent.callee !== node) {
      misuse.add(`${file} passes ${local} around or binds another ${local}; call it only as ${local}('a.literal.key', { args })`);
      return;
    }
    const [key, args, ...rest] = parent.arguments;
    if (key?.type !== 'Literal' || typeof key.value !== 'string' || rest.length) {
      misuse.add(`${file} calls ${local} with a key that is not one string literal, so the catalog test cannot see it`);
      return;
    }
    const at = `${file}:${lineOf(key.value)}`;
    const literalArgs = !args || (args.type === 'ObjectExpression' && args.properties.every(keyName));
    if (!literalArgs) misuse.add(`${at} passes ${key.value} its arguments other than as an object literal of plain keys`);
    calls.push({ key: key.value, args: literalArgs ? (args?.properties ?? []).map(keyName) : null, at });
  });
  return { calls, misuse: [...misuse] };
}

export function catalogViolations({ namespace, root }) {
  const directory = path.join(WEB, root, 'i18n');
  const catalogs = Object.fromEntries(AVAILABLE_LOCALES.map((locale) => [
    locale, JSON.parse(fs.readFileSync(path.join(directory, `${locale}.json`), 'utf8')),
  ]));
  const keys = Object.keys(catalogs.en);
  const shape = new RegExp(`^${namespace}(\\.[a-z][A-Za-z0-9]*)+$`);
  const violations = [];

  const files = fs.readdirSync(directory).sort();
  const expectedFiles = ['index.js', ...AVAILABLE_LOCALES.map((locale) => `${locale}.json`)].sort();
  if (files.join() !== expectedFiles.join()) violations.push(`${root}/i18n holds ${files.join(', ')}, not ${expectedFiles.join(', ')}`);
  for (const [locale, catalog] of Object.entries(catalogs)) {
    if (Object.keys(catalog).sort().join() !== [...keys].sort().join()) violations.push(`${root}/i18n/${locale}.json and en.json hold different keys`);
  }

  const messages = new Map();
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const [key, message] of Object.entries(catalog)) {
      if (!shape.test(key)) violations.push(`${key} is not ${namespace}.dotted.camelCase`);
      if (key.length > 80) violations.push(`${key} is longer than 80 characters, so Sentry would drop it as the missing-message tag`);
      if (typeof message !== 'string') {
        violations.push(`${locale} ${key} is not a string`);
        continue;
      }
      try {
        const names = new Set(argumentNames(parseMessage(message)));
        if (locale === 'en') messages.set(key, names);
      } catch (error) {
        violations.push(`${locale} ${key}: ${error.message}`);
      }
    }
  }

  const used = new Set();
  const sources = sourceFiles(root).filter((file) => !file.startsWith(path.join(root, 'i18n') + path.sep));
  for (const file of sources) {
    const { calls, misuse } = translationCalls(file, path.join(directory, 'index.js'));
    violations.push(...misuse);
    for (const { key, args, at } of calls) {
      used.add(key);
      if (!Object.hasOwn(catalogs.en, key)) {
        violations.push(`${at} asks for ${key}, which ${root}/i18n/en.json does not hold`);
        continue;
      }
      const needed = messages.get(key);
      if (!needed || !args) continue;
      const missing = [...needed].filter((name) => !args.includes(name));
      const extra = args.filter((name) => !needed.has(name));
      if (missing.length) violations.push(`${at} leaves ${key} without ${missing.join(', ')}`);
      if (extra.length) violations.push(`${at} passes ${key} ${extra.join(', ')}, which its message never shows`);
    }
  }
  for (const key of keys) if (!used.has(key)) violations.push(`${key} is in ${root}/i18n/en.json but nothing asks for it`);
  return violations;
}
