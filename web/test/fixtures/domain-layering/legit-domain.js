// @ts-check
// layer: domain
// file: notes.js
import { Id } from '../../../platform/domain-kit/entities.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { hashText } from '../../../platform/sync/core/encoding.js';
import { nextDocumentStamp } from '../../../platform/sync/core/content.js';
import { registry } from '../../../platform/sync/schema.js';
import { GymRules } from './gymRules.js';
export * from './bodyweight.js';
export const note = (id) => ({ id: new Id(id), text: jcs(registry.type('note')), rules: GymRules });
