// @ts-check
// layer: kit
// file: time.js
// expect: 10: token Date
// expect: 11: token performance
// expect: 12: token setTimeout
// expect: 13: token setInterval
// expect: 14: token queueMicrotask
// expect: 15: token requestAnimationFrame
export const now = Date.now();
export const mono = performance.now();
setTimeout(() => {}, 0);
setInterval(() => {}, 0);
queueMicrotask(() => {});
requestAnimationFrame(() => {});
