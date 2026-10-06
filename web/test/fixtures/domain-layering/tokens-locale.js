// @ts-check
// layer: kit
// file: time.js
// expect: 8: token Intl
// expect: 9: token toLocaleString
// expect: 10: token toLocaleDateString
// expect: 11: token localeCompare
export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const shown = (n) => n.toLocaleString();
export const day = (d) => d.toLocaleDateString();
export const ordered = (a, b) => a.localeCompare(b);
