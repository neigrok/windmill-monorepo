// @ts-check
// layer: kit
// file: entities.js
// expect: 7: dynamic import of a computed specifier
// expect: 8: import 'react' is not a kit import
export function load(name) {
  const computed = import(name);
  const bare = import('react');
  const fine = import('./values.js');
  return [computed, bare, fine];
}
