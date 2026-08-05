// The share-video capture (design brief #19): rasterise the animated loop frames
// (shareVideoFrame.js) and encode them into a short, seamless mp4 — the motion companion to the
// og-tree-cards still. Runs in the owner's browser at share time; the encoded mp4 is uploaded and
// served as the tree's og:video, with the still as the poster.
//
// Best-effort by contract, exactly like the still: WebCodecs isn't everywhere (Safari, older
// engines) and encoding can fail — every path returns null on any miss, and the caller keeps the
// poster. A share video can NEVER block or break sharing; it only ever enhances it. A final decode
// probe (isPlayable) means a malformed encode falls back to the poster rather than shipping a broken
// og:video (the poster only covers ABSENCE, not a broken tag).
//
// H.264/mp4 (not webm) because the whole point is autoplay in the social feeds (X, LinkedIn,
// Reddit, Discord) — mp4 is the format they accept. Encoded via Mediabunny (which drives WebCodecs
// + the mp4 mux together), with the moov atom at the front so the clip streams + autoplays.

import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH,
  Input, BlobSource, Mp4InputFormat, CanvasSink } from 'mediabunny';
import { buildShareVideoFrameSvg, LOOP } from './shareVideoFrame.js';
import { embeddedFontStyle } from './rasterize.js';

const FPS = 24;
const SIZE = 1080;                          // 1:1 primary; the wide 16:9's centre crop is this square
const FRAMES = Math.round((LOOP / 1000) * FPS);   // 72
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
      // add() encodes the current canvas at (timestamp, duration) in SECONDS; one keyframe at the
      // seam so the loop reopens cleanly, and add() applies backpressure so memory stays bounded.
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

// The card SVG carries its own fonts (the isolated-document gotcha from rasterize.js) — inject the
// same base64 @font-face style the still uses, just after the opening <svg> tag.
function withFonts(svg, style) {
  const at = svg.indexOf('>');
  return at < 0 ? svg : `${svg.slice(0, at + 1)}${style}${svg.slice(at + 1)}`;
}

// An SVG rasterises through an <img> element, not createImageBitmap — Chrome can't decode an SVG
// blob via createImageBitmap, but it decodes the same markup fine through an <img>.
function rasterFrame(svg) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

// Does this blob decode back into a real, correctly-sized frame? The safety net that keeps a broken
// encode from ever becoming a broken og:video tag. We demux + decode through the SAME WebCodecs
// engine that encoded it (via Mediabunny's reader) rather than probing a detached <video>: a <video>
// leans on the browser's full media-playback pipeline, which some environments gate off even for a
// valid file — a false negative that would silently drop a good clip to the poster. Decoding frame
// zero proves the H.264 bitstream is real, the dimensions are right, and it will play.
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
