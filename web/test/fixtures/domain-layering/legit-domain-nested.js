// @ts-check
// layer: domain
// file: coach/run.js
import { Id } from '../../../../platform/domain-kit/entities.js';
import { jcs } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { hashText } from '../../../../platform/sync/core/encoding.js';
import { registry } from '../../../../platform/sync/schema.js';
import { GymRules } from '../gymRules.js';
import { Conversation } from './conversation.js';
export const run = (id) => ({ id: new Id(id), text: jcs(registry.type('message')), hashText, rules: GymRules, Conversation });
