// @ts-check
// layer: kit
// file: entities.js
// expect: 6: import '../../../../packages/api-contract/sync/probe.registry.json' is not a kit import
// expect: 7: import './fixture.json' is not a kit import
import probe from '../../../../packages/api-contract/sync/probe.registry.json' with { type: 'json' };
import fixture from './fixture.json' with { type: 'json' };
export const both = [probe, fixture];
