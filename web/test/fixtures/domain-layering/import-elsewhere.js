// @ts-check
// layer: kit
// file: runner.js
// expect: 8: import '../sync/client/views.js' is not a kit import
// expect: 9: import '/src/platform/sync/core/jcs.js' is not a kit import
// expect: 10: import '../../shell/apiBase.js' is not a kit import
// expect: 11: import '../sync/engine.js' is not a kit import
import { drawn } from '../sync/client/views.js';
import { jcs } from '/src/platform/sync/core/jcs.js';
import { API_BASE } from '../../shell/apiBase.js';
import { BrowserSyncEngine } from '../sync/engine.js';
export const all = [drawn, jcs, API_BASE, BrowserSyncEngine];
