import { Text } from 'troika-three-text';
import { NODE_SIZE } from '../theme.js';

// A fixed pool of troika Text meshes — never one-per-node. Above the zoom
// threshold we ask the shared SpatialGrid for the nodes within the viewport,
// keep the ones nearest the viewport center (capped at the pool size) and park
// pooled Texts on them; everyone else, and the whole pool below the threshold,
// is just hidden. Far LOD is fruit + branches only, exactly like a real map.
const POOL_SIZE = 64;
const ZOOM_SHOW_THRESHOLD = 0.45; // camera.zoom (pixels per world unit) above which labels appear
const LABEL_OFFSET_Y = NODE_SIZE * 0.78; // below the fruit, matching DOM SkillNode's column layout
const LABEL_COLOR = '#211B13'; // colors.css --text-primary / --neutral-900
const FONT_SIZE = 16;

export class LabelLayer {
  constructor(scene) {
    this.scene = scene;
    this.nodesById = new Map();
    this.spatialGrid = null;
    this.assignedId = new Array(POOL_SIZE).fill(null);
    this.hidden = true;

    this.pool = Array.from({ length: POOL_SIZE }, () => {
      const text = new Text();
      text.fontSize = FONT_SIZE;
      text.color = LABEL_COLOR;
      text.anchorX = 'center';
      text.anchorY = 'middle';
      text.renderOrder = 2;
      text.visible = false;
      // World space is Y-down (see CameraController); troika builds glyphs with
      // +Y as "up" like any normal text mesh, so we flip the local Y axis once
      // here to cancel the camera's flip and keep labels reading upright.
      text.scale.y = -1;
      scene.add(text);
      return text;
    });
  }

  setModel(renderModel, spatialGrid) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.spatialGrid = spatialGrid;
    this.assignedId.fill(null);
    this.pool.forEach((text) => {
      text.visible = false;
    });
    this.hidden = true;
  }

  update(viewport, zoom) {
    if (!this.spatialGrid || zoom < ZOOM_SHOW_THRESHOLD) {
      this.hideAll();
      return;
    }

    this.hidden = false;
    const centerX = (viewport.minX + viewport.maxX) / 2;
    const centerY = (viewport.minY + viewport.maxY) / 2;

    const nearestIds = this.spatialGrid
      .within(viewport.minX, viewport.minY, viewport.maxX, viewport.maxY)
      .map((id) => {
        const node = this.nodesById.get(id);
        const distanceSq = (node.x - centerX) ** 2 + (node.y - centerY) ** 2;
        return { id, distanceSq };
      })
      .sort((a, b) => a.distanceSq - b.distanceSq)
      .slice(0, POOL_SIZE);

    this.pool.forEach((text, slot) => {
      const picked = nearestIds[slot];
      if (!picked) {
        text.visible = false;
        this.assignedId[slot] = null;
        return;
      }

      const node = this.nodesById.get(picked.id);
      text.visible = true;
      text.position.set(node.x, node.y + LABEL_OFFSET_Y, 1);
      if (this.assignedId[slot] !== node.id) {
        this.assignedId[slot] = node.id;
        text.text = node.label;
        text.sync();
      }
    });
  }

  hideAll() {
    if (this.hidden) return;
    this.hidden = true;
    this.pool.forEach((text, slot) => {
      text.visible = false;
      this.assignedId[slot] = null;
    });
  }

  dispose() {
    this.pool.forEach((text) => {
      this.scene.remove(text);
      text.dispose();
    });
  }
}
