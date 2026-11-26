// @ts-check
// layer: domain
// file: abilities/context.js
// product: roadmap
// expect: 8: import '../../../../../../packages/api-contract/gym/limits.json' is not a domain import
// expect: 9: import '../../../../../../packages/api-contract/roadmap/catalog.json' is not a domain import
import limits from '../../../../../../packages/api-contract/roadmap/limits.json' with { type: 'json' };
import theirs from '../../../../../../packages/api-contract/gym/limits.json' with { type: 'json' };
import catalog from '../../../../../../packages/api-contract/roadmap/catalog.json' with { type: 'json' };
export const read = [limits, theirs, catalog];
