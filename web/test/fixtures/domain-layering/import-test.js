// @ts-check
// layer: kit
// file: entities.js
// expect: 8: import '../../../test/platform/domain-kit/probe.js' is not a kit import
// expect: 9: import '../../../../packages/api-contract/sync/reference/server/state.js' is not a kit import
// expect: 10: import '../../../../packages/api-contract/sync/reference/vectors/fixtures.js' is not a kit import
// expect: 11: import '../../../../packages/api-contract/sync/reference/core/../server/state.js' is not a kit import
import { Probe } from '../../../test/platform/domain-kit/probe.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { registry } from '../../../../packages/api-contract/sync/reference/vectors/fixtures.js';
import { ServerState as Traversal } from '../../../../packages/api-contract/sync/reference/core/../server/state.js';
export const all = [Probe, ServerState, registry, Traversal];
