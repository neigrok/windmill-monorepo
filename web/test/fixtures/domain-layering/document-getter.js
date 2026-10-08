// @ts-check
// layer: domain
// expect: 9: token document
// expect: 10: token document

export class Proposal {
  get document() { return []; }
}
export class GlobalRead { get document() { return document.body; } }
export class Computed { get [document]() { return []; } }
