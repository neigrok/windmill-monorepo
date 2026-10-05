import { readFileSync } from 'node:fs';
import { Registry } from '../../../../src/platform/sync/core/registry.js';
import { JournalProduct } from '../../../../../packages/api-contract/sync/reference/journal/product.js';
export const journalRegistry = new Registry(JSON.parse(readFileSync(new URL('../../../../../packages/api-contract/sync/journal.registry.json', import.meta.url), 'utf8')));
export const journalProduct = new JournalProduct();
