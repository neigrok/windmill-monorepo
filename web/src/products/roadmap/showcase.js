// What roadmap lends the design-system gallery, and the only door it lends them through.
//
// These are not dead code and they are not design-system components. SkillNode, SkillConnector and
// ProgressBar are the canon's reference implementation of the tree metaphor — the drawn thing every
// other surface is measured against — and their one consumer is the routed #/showcase page. That is
// a real consumer, so they stay; what was wrong was the shape of the reach, not the reach itself.
//
// Before this, the gallery imported five files out of roadmap's interior by path, which the boundary
// test could not see and nothing declared. Now the coupling is one module, named, on the product's
// own side: roadmap decides what it exhibits, the gallery asks for it, and test/shell-boundaries
// enforces that the showcase may import THIS file and nothing else out of a product. A specimen that
// wants to join the gallery is added here, in the open, by the product that owns it.

export { SkillNode } from './ui/tree/SkillNode.jsx';
export { SkillConnector } from './ui/tree/SkillConnector.jsx';
export { ProgressBar } from './ui/tree/ProgressBar.jsx';
export { GalleryCard } from './share/GalleryCard.jsx';
export { ShareStats } from './share/ShareStats.js';
