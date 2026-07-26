// Small always-visible map of the whole tree: a dot per node, colored by its
// current state, plus a rectangle for the camera's current viewport. Clicking
// anywhere on it pans the scene there. Two stacked canvases keep it smooth: the
// dots redraw only when nodes/states/bounds change, while the viewport rectangle
// tracks the camera every frame through `subscribeViewport` — never through React.

import React, { useEffect, useRef } from 'react';
import { NODE_COLORS, DEFAULT_NODE_COLOR, nodeTier } from '../theme.js';

const WIDTH = 168;
const HEIGHT = 128;
const PADDING = 10;
const VIEWPORT_STROKE = NODE_COLORS.terracotta.base;

// A dot keeps its kind's hue; an unavailable node drops to the family's lighter
// tint so it reads as faded without losing its color.
function dotColor(color, state) {
  const family = NODE_COLORS[color] ?? NODE_COLORS[DEFAULT_NODE_COLOR];
  return nodeTier(state) === 0 ? family.soft : family.base;
}

function projectBounds(bounds, width, height) {
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((width - PADDING * 2) / spanX, (height - PADDING * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;

  return {
    toScreen: (x, y) => [offsetX + (x - bounds.minX) * scale, offsetY + (y - bounds.minY) * scale],
    toWorld: (px, py) => [bounds.minX + (px - offsetX) / scale, bounds.minY + (py - offsetY) / scale],
  };
}

function hasArea(bounds) {
  return bounds.maxX > bounds.minX && bounds.maxY > bounds.minY;
}

export function Minimap({ nodes, states, bounds, subscribeViewport, onPanTo }) {
  const dotsRef = useRef(null);
  const viewRef = useRef(null);

  useEffect(() => {
    const ctx = dotsRef.current.getContext('2d');
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    if (!hasArea(bounds)) return;

    const { toScreen } = projectBounds(bounds, WIDTH, HEIGHT);
    nodes.forEach((node) => {
      const state = states.get(node.id) ?? node.state;
      const [px, py] = toScreen(node.x, node.y);
      ctx.fillStyle = dotColor(node.color, state);
      ctx.beginPath();
      ctx.arc(px, py, 1.6, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [nodes, states, bounds]);

  useEffect(() => {
    if (!subscribeViewport || !hasArea(bounds)) return;
    const ctx = viewRef.current.getContext('2d');
    const { toScreen } = projectBounds(bounds, WIDTH, HEIGHT);

    return subscribeViewport((viewport) => {
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      if (!hasArea(viewport)) return;
      const [vx0, vy0] = toScreen(viewport.minX, viewport.minY);
      const [vx1, vy1] = toScreen(viewport.maxX, viewport.maxY);
      ctx.strokeStyle = VIEWPORT_STROKE;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(vx0, vy0, Math.max(1, vx1 - vx0), Math.max(1, vy1 - vy0));
    });
  }, [subscribeViewport, bounds]);

  function handleClick(event) {
    if (!hasArea(bounds)) return;
    const rect = viewRef.current.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const py = ((event.clientY - rect.top) / rect.height) * HEIGHT;
    const { toWorld } = projectBounds(bounds, WIDTH, HEIGHT);
    const [worldX, worldY] = toWorld(px, py);
    onPanTo(worldX, worldY);
  }

  return (
    <div className="st-minimap">
      <div className="st-minimap-stack" style={{ width: WIDTH, height: HEIGHT }}>
        <canvas ref={dotsRef} width={WIDTH} height={HEIGHT} className="st-minimap-canvas st-minimap-canvas--dots" />
        <canvas
          ref={viewRef}
          width={WIDTH}
          height={HEIGHT}
          className="st-minimap-canvas st-minimap-canvas--view"
          onClick={handleClick}
        />
      </div>
    </div>
  );
}
