// @ts-check
// layer: kit
// file: runner.js
// expect: 6: token Date
export async function moment() {
  return Promise.resolve(Date.now());
}
