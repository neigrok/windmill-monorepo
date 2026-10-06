// @ts-check
// layer: kit
// file: runner.js
import { recordKey } from '../sync/core/rows.js';
export class ActionRunner {
  async run(action) {
    const { outcome } = await this.replica.commit(action.scope, () => ({ gesture: null, value: recordKey('t', 'id') }));
    return Promise.resolve(outcome);
  }
}
