// Rasterises the loop frames and encodes them into a short, seamless mp4 — the tree's og:video,
// with the still as its poster. Best-effort: WebCodecs is not everywhere and encoding can fail, so
// every path returns null on a miss and the caller keeps the poster. H.264/mp4 is what the social
// feeds autoplay; the moov atom goes at the front so the clip streams.

import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH,
  Input, BlobSource, Mp4InputFormat, CanvasSink } from 'mediabunny';
import { buildShareVideoFrameSvg, LOOP } from './shareVideoFrame.js';
import { embeddedFontStyle } from './rasterize.js';

const FPS = 24;
const SIZE = 1080;                          // 1:1 primary; the wide 16:9's centre crop is this square
const FRAMES = Math.round((LOOP / 1000) * FPS);
const MAX_BYTES = 3 * 1024 * 1024;

function shareVideoSupported() {
  return typeof window !== 'undefined' && typeof window.VideoEncoder === 'function';
}

export async function captureShareVideo({ model, title, done, total, dominantKind }) {
  if (!shareVideoSupported() || !model || !model.nodes.length) return null;
  let output = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext('2d');
    if (!context) return null;

    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const source = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH });
    output.addVideoTrack(source, { frameRate: FPS });
    await output.start();

    const fontStyle = await embeddedFontStyle();
    for (let i = 0; i < FRAMES; i++) {
      const t = (i / FRAMES) * LOOP;
      const svg = withFonts(buildShareVideoFrameSvg({ model, title, done, total, dominantKind, t, w: SIZE, h: SIZE }), fontStyle);
      const image = await rasterFrame(svg);
      if (!image) { await output.cancel(); return null; }
      context.clearRect(0, 0, SIZE, SIZE);
      context.drawImage(image, 0, 0, SIZE, SIZE);
      // add() takes (timestamp, duration) in seconds and applies backpressure; one keyframe at the
      // seam so the loop reopens cleanly.
      await source.add(i / FPS, 1 / FPS, { keyFrame: i === 0 });
    }

    await output.finalize();
    const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
    output = null;
    if (blob.size === 0 || blob.size > MAX_BYTES) return null;
    return (await decodesCleanly(blob)) ? blob : null;
  } catch {
    try { if (output) await output.cancel(); } catch { /* noop */ }
    return null;
  }
}

// The card SVG must carry its own fonts: inject the base64 @font-face style after the opening tag.
function withFonts(svg, style) {
  const at = svg.indexOf('>');
  return at < 0 ? svg : `${svg.slice(0, at + 1)}${style}${svg.slice(at + 1)}`;
}

// Through an <img>, never createImageBitmap: Chrome cannot decode an SVG blob that way.
function rasterFrame(svg) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

// Does this blob decode back into a real, correctly-sized frame? Through the same WebCodecs engine
// that encoded it, never a detached <video>: some environments gate media playback off entirely.
async function decodesCleanly(blob) {
  let input = null;
  try {
    input = new Input({ source: new BlobSource(blob), formats: [new Mp4InputFormat()] });
    const track = await input.getPrimaryVideoTrack();
    if (!track || track.codedWidth !== SIZE || track.codedHeight !== SIZE) return false;
    if (!((await input.computeDuration()) > 0)) return false;
    const frame = await new CanvasSink(track).getCanvas(0);
    return Boolean(frame && frame.canvas && frame.canvas.width === SIZE);
  } catch {
    return false;
  } finally {
    if (input) input.dispose();  // closes the decoder the CanvasSink opened
  }
}
