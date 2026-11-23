// @ts-check
// layer: domain
// file: coach/run.js
// expect: 8: import '../../gymRuntime.js' is not a domain import
// expect: 9: import '../../../platform/domain-kit/entities.js' is not a domain import
// expect: 10: import '../../../../platform/sync/engine.js' is not a domain import
// expect: 11: import '../../../journal/domain/page.js' is not a domain import
import { createGymApi } from '../../gymRuntime.js';
import { Id } from '../../../platform/domain-kit/entities.js';
import { BrowserSyncEngine } from '../../../../platform/sync/engine.js';
import { Page } from '../../../journal/domain/page.js';
export const all = [createGymApi, Id, BrowserSyncEngine, Page];
