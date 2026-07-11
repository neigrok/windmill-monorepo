// The Share surface (X2 identity). The preview IS the export: we render the frame
// recipe onto a Canvas2D via renderShareCanvas, show that very canvas, and download
// that very canvas — so what the user sees and what they post can't diverge. The
// dominant kind is computed (ShareStats), never picked; the user only chooses the
// export size and the light/dark skin.

import React, { useEffect, useRef, useState } from 'react';
import { Dialog, Button, Tabs } from '../../components';
import { ShareFrame, SHARE_SIZES, shareSize } from './ShareFrame.js';
import { renderShareCanvas, canvasToPngBlob } from './exportImage.js';

const SIZE_TABS = SHARE_SIZES.map((size) => ({ value: size.id, label: size.label }));
const THEME_TABS = [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];

export function ShareDialog({ open, onClose, model, title, stats }) {
  const [size, setSize] = useState('og');
  const [theme, setTheme] = useState('light');
  const previewRef = useRef(null);
  const filmRef = useRef(null);

  const kind = stats?.dominantKind ?? 'terracotta';
  const s = shareSize(size);

  // The live preview: render the chosen frame at scale 1 and swap the canvas in.
  // The ignore flag drops any render whose inputs changed before it resolved.
  useEffect(() => {
    if (!open || !model) return undefined;
    let ignore = false;
    const frame = new ShareFrame({ w: s.w, h: s.h, theme, kind, stats, title });
    renderShareCanvas(frame, model, { scale: 1 }).then((canvas) => {
      if (ignore || !previewRef.current) return;
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.style.borderRadius = '12px';
      canvas.style.boxShadow = frame.palette.shadow;
      previewRef.current.replaceChildren(canvas);
    });
    return () => { ignore = true; };
  }, [open, size, theme, model, stats, kind, title, s.w, s.h]);

  // The filmstrip note: GIF intro frame → the final postcard (twice) — an illustration
  // that the animation resolves to the same static PNG this dialog exports.
  useEffect(() => {
    if (!open || !model) return undefined;
    let ignore = false;
    const frames = [
      new ShareFrame({ w: 960, h: 540, theme, kind, variant: 'intro', stats, title }),
      new ShareFrame({ w: 960, h: 540, theme, kind, stats, title }),
      new ShareFrame({ w: 960, h: 540, theme, kind, stats, title }),
    ];
    Promise.all(frames.map((frame) => renderShareCanvas(frame, model, { scale: 1 }))).then((canvases) => {
      if (ignore || !filmRef.current) return;
      canvases.forEach((canvas) => {
        canvas.style.display = 'block';
        canvas.style.flex = '1 1 0';
        canvas.style.minWidth = '0';
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.style.borderRadius = '6px';
        canvas.style.boxShadow = 'var(--shadow-xs)';
      });
      filmRef.current.replaceChildren(...canvases);
    });
    return () => { ignore = true; };
  }, [open, theme, model, stats, kind, title]);

  async function exportBlob(scale) {
    const frame = new ShareFrame({ w: s.w, h: s.h, theme, kind, stats, title });
    const canvas = await renderShareCanvas(frame, model, { scale });
    return canvasToPngBlob(canvas);
  }

  async function handleDownload() {
    if (!model) return;
    downloadBlob(await exportBlob(2), fileName(title));
  }

  async function handleCopy() {
    if (!model) return;
    const blob = await exportBlob(2);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch {
      downloadBlob(blob, fileName(title));
    }
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={handleCopy} disabled={!model}>Copy image</Button>
      <Button variant="primary" onClick={handleDownload} disabled={!model}>Download PNG</Button>
    </>
  );

  return (
    <Dialog open={open} onClose={onClose} title="Share roadmap" width={640} footer={model ? footer : null}>
      {!model ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-tertiary)' }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
            <Tabs tabs={SIZE_TABS} value={size} onChange={setSize} />
            <Tabs tabs={THEME_TABS} value={theme} onChange={setTheme} />
          </div>

          <div ref={previewRef} style={{ width: '100%', minHeight: 120 }} />

          <div style={{ marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', textAlign: 'center' }}>
            {s.w}×{s.h} · exports @2x · dominant {kind}
          </div>

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
            <div ref={filmRef} style={{ display: 'flex', gap: 8, alignItems: 'stretch' }} />
            <div style={{ marginTop: 8, fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
              GIF intro → final frame ≡ this PNG. Reduced motion: ship the static PNG.
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = name;
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
}

function fileName(title) {
  const slug = (title || 'roadmap').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `windmill-${slug || 'roadmap'}.png`;
}
