// @ts-check
// layer: domain
// file: page.js
// expect: 9: token document
// expect: 10: token document
export const page = { document: 'prose' };
export const body = page.document;
export const { document: doc } = page;
export const title = document.title;
export const computed = page[document];
