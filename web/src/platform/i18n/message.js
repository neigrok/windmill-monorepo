// The ICU MessageFormat subset catalogs are written in: {name}, plural with =N and #, select, ICU apostrophe quoting.

const PLURAL_KEY = /^(=\d+(\.\d+)?|zero|one|two|few|many|other)$/;
const SELECT_KEY = /^[A-Za-z0-9_-]+$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class MessageParser {
  constructor(source) {
    this.source = source;
    this.at = 0;
  }

  parse() {
    const nodes = this.message(false);
    if (this.at < this.source.length) this.fail('an unmatched }');
    return nodes;
  }

  message(inPlural) {
    const nodes = [];
    let text = '';
    const flush = () => {
      if (text) nodes.push(text);
      text = '';
    };
    while (this.at < this.source.length && this.source[this.at] !== '}') {
      const char = this.source[this.at];
      if (char === '{') {
        flush();
        nodes.push(this.argument());
      } else if (char === '#' && inPlural) {
        flush();
        nodes.push({ type: 'count' });
        this.at++;
      } else if (char === "'") {
        text += this.apostrophe(inPlural);
      } else {
        text += char;
        this.at++;
      }
    }
    flush();
    return nodes;
  }

  apostrophe(inPlural) {
    const next = this.source[this.at + 1];
    if (next === "'") {
      this.at += 2;
      return "'";
    }
    if (next !== '{' && next !== '}' && !(next === '#' && inPlural)) {
      this.at++;
      return "'";
    }
    this.at++;
    let quoted = '';
    while (this.at < this.source.length) {
      if (this.source[this.at] === "'" && this.source[this.at + 1] === "'") {
        quoted += "'";
        this.at += 2;
        continue;
      }
      if (this.source[this.at] === "'") {
        this.at++;
        return quoted;
      }
      quoted += this.source[this.at];
      this.at++;
    }
    return quoted;
  }

  argument() {
    this.at++;
    const name = this.word();
    if (!NAME.test(name)) this.fail(`an argument name, got "${name}"`);
    if (this.take('}')) return { type: 'argument', name };
    if (!this.take(',')) this.fail(`, or } after {${name}`);
    const style = this.word();
    if (style !== 'plural' && style !== 'select') this.fail(`plural or select as the type of {${name}}, got "${style}"`);
    if (!this.take(',')) this.fail(`, after {${name}, ${style}`);
    const options = this.options(style);
    return { type: style, name, options };
  }

  options(style) {
    const options = {};
    for (;;) {
      if (this.take('}')) break;
      const key = this.word();
      const valid = style === 'plural' ? PLURAL_KEY : SELECT_KEY;
      if (!valid.test(key)) this.fail(`a ${style} option, got "${key}"`);
      if (key in options) this.fail(`one ${key} option, got two`);
      if (!this.take('{')) this.fail(`{ after the ${key} option`);
      options[key] = this.message(style === 'plural');
      if (!this.take('}')) this.fail(`} closing the ${key} option`);
    }
    if (!('other' in options)) this.fail(`an other option in the ${style}`);
    return options;
  }

  word() {
    this.space();
    const start = this.at;
    while (this.at < this.source.length && !/[\s,{}]/.test(this.source[this.at])) this.at++;
    return this.source.slice(start, this.at);
  }

  take(char) {
    this.space();
    if (this.source[this.at] !== char) return false;
    this.at++;
    return true;
  }

  space() {
    while (this.at < this.source.length && /\s/.test(this.source[this.at])) this.at++;
  }

  fail(expected) {
    throw new SyntaxError(`message "${this.source}" expects ${expected} at ${this.at}`);
  }
}

export function parseMessage(source) {
  return new MessageParser(source).parse();
}

export function formatMessage(nodes, args, pluralRules, count = null) {
  const parts = [];
  const push = (part) => {
    if (typeof part === 'string' && typeof parts.at(-1) === 'string') parts[parts.length - 1] += part;
    else parts.push(part);
  };
  for (const node of nodes) {
    if (typeof node === 'string') {
      push(node);
      continue;
    }
    if (node.type === 'count') {
      push(String(count));
      continue;
    }
    const value = args[node.name];
    if (value === undefined || value === null) throw new Error(`message needs the argument "${node.name}"`);
    if (node.type === 'argument') {
      push(typeof value === 'object' ? value : String(value));
      continue;
    }
    const branch = node.type === 'plural'
      ? pluralBranch(node, value, pluralRules)
      : node.options[String(value)] ?? node.options.other;
    for (const part of formatMessage(branch, args, pluralRules, node.type === 'plural' ? value : count)) push(part);
  }
  return parts;
}

function pluralBranch(node, value, pluralRules) {
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`plural argument "${node.name}" must be a number`);
  const exact = Object.keys(node.options).find((key) => key.startsWith('=') && Number(key.slice(1)) === value);
  return node.options[exact] ?? node.options[pluralRules.select(value)] ?? node.options.other;
}
