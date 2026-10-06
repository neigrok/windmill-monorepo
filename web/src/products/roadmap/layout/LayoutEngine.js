export class LayoutEngine {
  // How siblings can be dragged into a new order on this engine's geometry: 'ring' — trunk siblings sweep a circle
  // about the world origin; 'parent-arc' — they sweep an arc about their trunk parent, in trunk order, which leaves
  // a root (it has no parent) where it sits; 'none'. The scene arms the angular gesture for the first two.
  static reorder = 'none';

  // Whether the engine reserves each caption's box, so a rename or a recolour has to re-run it.
  static readsCaptions = false;

  // Returns Map<id, Vec2>, synchronously.
  layout(tree) {
    throw new Error('LayoutEngine.layout not implemented');
  }
}
