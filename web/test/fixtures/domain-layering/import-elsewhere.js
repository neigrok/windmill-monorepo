// @ts-check
// layer: kit
// file: runner.js
// expect: 8: import '../../../../packages/api-contract/sync/reference/client/views.js' is not a kit import
// expect: 9: import '/packages/api-contract/sync/reference/core/jcs.js' is not a kit import
// expect: 10: import '../../shell/apiBase.js' is not a kit import
// expect: 11: import '../sync/engine.js' is not a kit import
import { drawn } from '../../../../packages/api-contract/sync/reference/client/views.js';
import { jcs } from '/packages/api-contract/sync/reference/core/jcs.js';
import { API_BASE } from '../../shell/apiBase.js';
import { BrowserSyncEngine } from '../sync/engine.js';
export const all = [drawn, jcs, API_BASE, BrowserSyncEngine];
