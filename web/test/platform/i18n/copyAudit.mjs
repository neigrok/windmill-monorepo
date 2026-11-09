// Source read as syntax trees for the catalog test and the copy guard; JSX arrives as $jsx(type, props, ...children).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { transformSync } from 'esbuild';
import { AVAILABLE_LOCALES } from '../../../src/platform/i18n/index.js';
import { parseMessage } from '../../../src/platform/i18n/message.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const COPY_PROPS = new Set([
  'aria-label', 'aria-description', 'aria-valuetext', 'aria-roledescription', 'aria-placeholder',
  'ariaLabel', 'title', 'label', 'placeholder', 'alt', 'caption', 'error', 'panePlace',
  'badge', 'failure', 'quiet', 'stamp',
]);
const DIALOGS = new Set(['alert', 'confirm', 'prompt']);

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
  const find = (needle) => {
    for (let at = text.indexOf(needle, searched.get(needle) ?? 0); at !== -1; at = text.indexOf(needle, at + 1)) {
      const line = text.slice(0, at).split('\n').length;
      if (/^\s*(\/\/|\/\*|\*)/.test(lines[line - 1])) continue;
      searched.set(needle, at + needle.length);
      return line;
    }
    return null;
  };
  return (value) => {
    const words = value.trim().split('\n')[0].slice(0, 40);
    return find(`'${words}'`) ?? find(`"${words}"`) ?? find(words) ?? '?';
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

function copyPropStrings(name, value) {
  if (COPY_PROPS.has(name)) return renderedStrings(value).map((text) => [name, text]);
  if (value?.type === 'ArrayExpression') return value.elements.flatMap((element) => copyPropStrings(null, element));
  if (value?.type === 'ObjectExpression') return value.properties.flatMap((property) => copyPropStrings(keyName(property), property.value));
  return [];
}

function dialogName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.name === 'window') return callee.property.name;
  return null;
}

export function copyHits(file, allowed) {
  const { text, ast } = parseSource(file);
  const lineOf = lineLocator(text);
  const hits = [];
  const report = (where, value) => {
    if (/\p{L}/u.test(value) && !allowed.has(value.trim())) hits.push(`${file}:${lineOf(value)} ${where}${JSON.stringify(value)}`);
  };
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const dialog = dialogName(node.callee);
    if (DIALOGS.has(dialog)) for (const value of renderedStrings(node.arguments[0])) report(`${dialog}() `, value);
    if (node.callee.name !== '$jsx') return;
    const [, props, ...children] = node.arguments;
    for (const property of props?.type === 'ObjectExpression' ? props.properties : []) {
      for (const [name, value] of copyPropStrings(keyName(property), property.value)) report(`${name}=`, value);
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

function translationCalls(file, indexes) {
  const { text, ast } = parseSource(file);
  const directory = path.dirname(path.join(WEB, file));
  const targetOf = (specifier) => (specifier.startsWith('/') ? path.join(WEB, specifier) : path.resolve(directory, specifier));
  const misuse = new Set();
  const reads = [];
  walk(ast, (node) => {
    const source = node.type === 'ImportExpression' || node.type.startsWith('Import') || node.type.startsWith('Export') ? node.source : null;
    if (source?.type !== 'Literal' || !indexes.includes(targetOf(source.value))) return;
    const [specifier, ...others] = node.specifiers ?? [];
    const canonical = node.type === 'ImportDeclaration' && source.value.startsWith('.') && !others.length
      && specifier?.type === 'ImportSpecifier' && specifier.imported.name === 't' && specifier.local.name === 't';
    if (!canonical) misuse.add(`${file} reads its owner's catalog other than as one static, relative import { t } from '…/i18n/index.js'`);
    reads.push(targetOf(source.value));
  });
  if (reads.length > 1) misuse.add(`${file} reads its owner's catalog more than once; import t once, from one index`);
  if (reads.length !== 1 || misuse.size) return { index: null, calls: [], misuse: [...misuse] };

  const lineOf = lineLocator(text);
  const calls = [];
  const seen = new Set();
  walk(ast, (node, parent) => {
    if (node.type !== 'Identifier' || node.name !== 't' || seen.has(node.start)) return;
    seen.add(node.start);
    if (parent.type === 'ImportSpecifier') return;
    if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
    if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent.type) && parent.key === node && !parent.computed && !parent.shorthand) return;
    if (parent.type !== 'CallExpression' || parent.callee !== node) {
      misuse.add(`${file} passes t around or binds another t; call it only as t('a.literal.key', { args })`);
      return;
    }
    const [key, args, ...rest] = parent.arguments;
    if (key?.type !== 'Literal' || typeof key.value !== 'string' || rest.length) {
      misuse.add(`${file} calls t with a key that is not one string literal, so the catalog test cannot see it`);
      return;
    }
    const at = `${file}:${lineOf(key.value)}`;
    const literalArgs = !args || (args.type === 'ObjectExpression' && args.properties.every(keyName));
    if (!literalArgs) misuse.add(`${at} passes ${key.value} its arguments other than as an object literal of plain keys`);
    calls.push({ key: key.value, args: literalArgs ? (args?.properties ?? []).map(keyName) : null, at });
  });
  return { index: reads[0], calls, misuse: [...misuse] };
}

// An owner's catalogs, one per moment its files load. Every tier reads the brand root's entry/; the app's chrome and
// home (app/) and a product's landing (landing/) add their own; settings, drawn inside the app's chrome, reads app/
// too; i18n/ reads them all. A key lives in the latest catalog every file that asks for it reads.
const TIERS = { entry: ['entry'], app: ['entry', 'app'], settings: ['entry', 'app', 'settings'], landing: ['entry', 'landing'] };

function tiersOf(root) {
  const own = path.join(root, 'i18n');
  const present = Object.keys(TIERS).filter((tier) => fs.existsSync(path.join(WEB, own, tier)));
  return [
    ...present.map((tier) => ({ directory: path.join(own, tier), reads: TIERS[tier].map((read) => path.join(own, read)) })),
    { directory: own, reads: [...present.map((tier) => path.join(own, tier)), own] },
  ];
}

function catalogFiles(directory, locales, violations) {
  const expected = ['index.js', ...locales.map((locale) => `${locale}.json`)];
  for (const tier of Object.keys(TIERS)) if (fs.existsSync(path.join(WEB, directory, tier))) expected.push(`${tier}/`);
  const held = fs.readdirSync(path.join(WEB, directory), { withFileTypes: true }).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  if (held.sort().join() !== expected.sort().join()) violations.push(`${directory} holds ${held.join(', ')}, not ${expected.join(', ')}`);
  const present = locales.filter((locale) => fs.existsSync(path.join(WEB, directory, `${locale}.json`)));
  return { en: {}, ...Object.fromEntries(present.map((locale) => [locale, JSON.parse(fs.readFileSync(path.join(WEB, directory, `${locale}.json`), 'utf8'))])) };
}

function readMessages(directory, catalogs, namespace, violations) {
  const shape = new RegExp(`^${namespace}(\\.[a-z][A-Za-z0-9]*)+$`);
  const shown = new Map();
  for (const [locale, catalog] of Object.entries(catalogs)) {
    if (Object.keys(catalog).sort().join() !== Object.keys(catalogs.en).sort().join()) violations.push(`${directory}/${locale}.json and en.json hold different keys`);
    for (const [key, message] of Object.entries(catalog)) {
      if (locale === 'en' && !shape.test(key)) violations.push(`${key} is not ${namespace}.dotted.camelCase`);
      if (locale === 'en' && key.length > 80) violations.push(`${key} is longer than 80 characters, so Sentry would drop it as the missing-message tag`);
      if (typeof message !== 'string') {
        violations.push(`${locale} ${key} is not a string`);
        continue;
      }
      try {
        const names = new Set(argumentNames(parseMessage(message)));
        const listed = [...names].sort().join(', ');
        if (locale === 'en') shown.set(key, names);
        else if (shown.has(key) && listed !== [...shown.get(key)].sort().join(', ')) violations.push(`${locale} ${key} shows {${listed}} where en shows {${[...shown.get(key)].sort().join(', ')}}`);
      } catch (error) {
        violations.push(`${locale} ${key}: ${error.message}`);
      }
    }
  }
  return shown;
}

export function catalogViolations({ namespace, root, locales = AVAILABLE_LOCALES }) {
  const violations = [];
  const tiers = tiersOf(root);
  const catalogs = new Map(tiers.map(({ directory }) => [directory, catalogFiles(directory, locales, violations)]));
  const shown = new Map(tiers.flatMap(({ directory }) => [...readMessages(directory, catalogs.get(directory), namespace, violations)]));
  const holder = new Map();
  for (const { directory } of tiers) {
    for (const key of Object.keys(catalogs.get(directory).en)) {
      if (holder.has(key)) violations.push(`${key} is in both ${holder.get(key)}/en.json and ${directory}/en.json`);
      else holder.set(key, directory);
    }
  }

  const readerOf = new Map(tiers.map((tier) => [path.join(WEB, tier.directory, 'index.js'), tier]));
  const askers = new Map();
  const own = tiers.at(-1).directory;
  for (const file of sourceFiles(root).filter((source) => !source.startsWith(own + path.sep))) {
    const { index, calls, misuse } = translationCalls(file, [...readerOf.keys()]);
    violations.push(...misuse);
    const reader = readerOf.get(index);
    for (const { key, args, at } of calls) {
      if (!holder.has(key)) {
        violations.push(`${at} asks for ${key}, which ${reader.directory}/en.json does not hold`);
        continue;
      }
      if (!askers.has(key)) askers.set(key, []);
      askers.get(key).push(reader);
      const needed = shown.get(key);
      if (!needed || !args) continue;
      const missing = [...needed].filter((name) => !args.includes(name));
      const extra = args.filter((name) => !needed.has(name));
      if (missing.length) violations.push(`${at} leaves ${key} without ${missing.join(', ')}`);
      if (extra.length) violations.push(`${at} passes ${key} ${extra.join(', ')}, which its message never shows`);
    }
  }
  for (const [key, directory] of holder) {
    const readers = askers.get(key);
    if (!readers) {
      violations.push(`${key} is in ${directory}/en.json but nothing asks for it`);
      continue;
    }
    const best = tiers.filter((tier) => readers.every((reader) => reader.reads.includes(tier.directory)))
      .reduce((latest, tier) => (tier.reads.length > latest.reads.length ? tier : latest));
    if (best.directory !== directory) violations.push(`${key} is in ${directory}/en.json, but the latest catalog every file that asks for it reads is ${best.directory}/en.json`);
  }
  return violations;
}

function argumentsOf(message) {
  return Object.fromEntries(argumentNames(parseMessage(message)).map((name) => [name, 1]));
}

// Each tier's index, loaded as the app loads it: its catalogs hold every key of the tiers it reads in every locale,
// and its t shows every one of them.
export async function translatorViolations({ root, locales = AVAILABLE_LOCALES }) {
  const violations = [];
  for (const tier of tiersOf(root)) {
    const index = path.join(tier.directory, 'index.js');
    const { t, catalogs } = await import(pathToFileURL(path.join(WEB, index)).href);
    if (!catalogs) {
      violations.push(`${index} exports no catalogs`);
      continue;
    }
    for (const locale of locales) {
      const read = Object.assign({}, ...tier.reads.map((directory) => {
        const file = path.join(WEB, directory, `${locale}.json`);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      }));
      const missing = Object.keys(read).filter((key) => !Object.hasOwn(catalogs[locale] ?? {}, key));
      if (missing.length) violations.push(`${index} gives ${locale} no ${missing.length === 1 ? missing[0] : `${missing.length} keys, ${missing[0]} first`}`);
    }
    const english = Object.assign({}, ...tier.reads.map((directory) => JSON.parse(fs.readFileSync(path.join(WEB, directory, 'en.json'), 'utf8'))));
    for (const [key, message] of Object.entries(english)) {
      try { t(key, argumentsOf(message)); } catch (error) { violations.push(`${index} cannot show ${key}: ${error.message}`); break; }
    }
  }
  return violations;
}
