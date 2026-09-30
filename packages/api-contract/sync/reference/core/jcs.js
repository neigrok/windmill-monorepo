// RFC 8785 JSON Canonicalization Scheme (§3.2 `jcs`). `compareJcs` orders values by the UTF-8 bytes
// of their encoding, which differs from JavaScript string order above U+FFFF.

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export class JcsError extends Error {}

export function jcs(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JcsError(`not a finite number: ${value}`);
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw new JcsError('string holds a lone surrogate');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${jcs(key)}:${jcs(value[key])}`).join(',')}}`;
  }
  throw new JcsError(`not a JSON value: ${typeof value}`);
}

export function jcsBytes(value) {
  return Buffer.from(jcs(value), 'utf8');
}

export function compareJcs(a, b) {
  return Buffer.compare(jcsBytes(a), jcsBytes(b));
}

export function sameJson(a, b) {
  return jcs(a) === jcs(b);
}
