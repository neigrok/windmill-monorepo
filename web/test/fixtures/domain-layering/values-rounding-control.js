// @ts-check
// layer: kit
// file: values.js
export const rounded = (x, q) => Math.round(x / q) * q;
export const shown = (x) => x.toFixed(2) + x.toPrecision(3);
