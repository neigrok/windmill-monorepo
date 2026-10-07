// @ts-check
// layer: kit
// file: plans.js
// expect: 7: token Math.round
// expect: 8: token toFixed
// expect: 9: token toPrecision
export const rounded = (x) => Math.round(x * 100) / 100;
export const fixed = (x) => x.toFixed(2);
export const precise = (x) => x.toPrecision(3);
