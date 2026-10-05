// Raw product/request ids are JSON object keys, including Object.prototype names. Read only own
// properties and define writes as data properties so `__proto__` cannot invoke the legacy setter.
export const ownValue = (map, key) => map && Object.hasOwn(map, key) ? map[key] : undefined;
export function setOwn(map, key, value) {
  Object.defineProperty(map, key, { value, enumerable: true, configurable: true, writable: true });
  return value;
}
