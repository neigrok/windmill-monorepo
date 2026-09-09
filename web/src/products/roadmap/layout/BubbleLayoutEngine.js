import { LayoutEngine } from '../model/ports.js';

export default class BubbleLayoutEngine extends LayoutEngine {
  static reorder = 'none';

  layout() {
    throw new Error('bubble layout is not built yet');
  }
}
