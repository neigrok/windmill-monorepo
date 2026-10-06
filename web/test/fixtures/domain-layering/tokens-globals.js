// @ts-check
// layer: kit
// file: entities.js
// expect: 15: token window
// expect: 16: token document
// expect: 17: token globalThis
// expect: 18: token navigator
// expect: 19: token self
// expect: 20: token localStorage
// expect: 21: token sessionStorage
// expect: 22: token indexedDB
// expect: 23: token fetch
// expect: 24: token eval
// expect: 25: token Function
export const a = window.location;
export const b = document.title;
export const c = globalThis.structuredClone;
export const d = navigator.onLine;
export const e = self.name;
export const f = localStorage.getItem('k');
export const g = sessionStorage.getItem('k');
export const h = indexedDB.open('db');
export const i = fetch('/v1');
export const j = eval('1');
export const k = new Function('return 1');
