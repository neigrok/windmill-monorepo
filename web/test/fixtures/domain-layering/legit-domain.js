// @ts-check
// layer: domain
// file: notes.js
import { Id } from '../../../platform/domain-kit/entities.js';
import { jcs } from '../../../platform/sync/core/jcs.js';
import { registry } from '../../../platform/sync/schema.js';
import { GymRules } from './gymRules.js';
export * from './bodyweight.js';
export const note = (id) => ({ id: new Id(id), text: jcs(registry.type('note')), rules: GymRules });
