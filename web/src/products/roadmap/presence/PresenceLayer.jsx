// Live presence overlay — remote peers' cursors drawn as a DOM layer above the GPU
// canvas. Peer state lives in peersRef (a Map the view fills from presence/peer frames);
// this layer projects each peer's world-space cursor to screen space on its own rAF loop
// (never through React, so a moving camera or a peer cursor at 20 Hz costs no re-renders),
// and forwards our own pointer as world coords to the socket. Cursors are inert to input.

import React, { useEffect, useRef } from 'react';

export function PresenceLayer({ peersRef, scene, canvasRef, collabRef, selection }) {
  const containerRef = useRef(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!scene || !canvas || !container) return undefined;
    const els = new Map(); // actor -> cursor element

    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const viewport = scene.getViewport();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const spanX = viewport.maxX - viewport.minX || 1;
      const spanY = viewport.maxY - viewport.minY || 1;
      const peers = peersRef.current;

      for (const [actor, el] of els) {
        if (!peers.has(actor) || !peers.get(actor).cursor) { el.remove(); els.delete(actor); }
      }
      for (const [actor, peer] of peers) {
        if (!peer.cursor) continue;
        let el = els.get(actor);
        if (!el) { el = makeCursor(); container.appendChild(el); els.set(actor, el); }
        paintCursor(el, peer);
        const x = ((peer.cursor.x - viewport.minX) / spanX) * width;
        const y = ((peer.cursor.y - viewport.minY) / spanY) * height;
        el.style.transform = `translate(${x}px, ${y}px)`;
        el.style.visibility = x < -40 || y < -40 || x > width + 40 || y > height + 40 ? 'hidden' : 'visible';
      }
    };
    frame = requestAnimationFrame(draw);

    const onMove = (event) => {
      const viewport = scene.getViewport();
      const rect = canvas.getBoundingClientRect();
      const x = viewport.minX + ((event.clientX - rect.left) / rect.width) * (viewport.maxX - viewport.minX);
      const y = viewport.minY + ((event.clientY - rect.top) / rect.height) * (viewport.maxY - viewport.minY);
      collabRef.current?.sendPresence({ x, y }, selectionRef.current ?? '');
    };
    const onLeave = () => collabRef.current?.sendPresence(null, selectionRef.current ?? '');
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      els.forEach((el) => el.remove());
    };
  }, [scene, canvasRef, collabRef, peersRef]);

  return <div ref={containerRef} className="st-presence-layer" style={LAYER_STYLE} />;
}

const LAYER_STYLE = { position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 5 };

function makeCursor() {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;top:0;left:0;will-change:transform;pointer-events:none;';
  el.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 20 20" style="display:block;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))">' +
    '<path d="M3 2 L3 16 L7 12 L10 18 L12 17 L9 11 L15 11 Z" fill="var(--c)" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>' +
    '<span style="position:absolute;left:16px;top:14px;padding:1px 6px;border-radius:6px;background:var(--c);' +
    'color:#fff;font:600 11px/1.4 system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.25)"></span>';
  return el;
}

function paintCursor(el, peer) {
  el.style.setProperty('--c', peer.color || '#5b6ee1');
  const label = el.querySelector('span');
  if (label.textContent !== peer.name) label.textContent = peer.name || 'Guest';
}
