// Turn an SVG string into a PNG Blob by drawing it onto a canvas through an <img>. Used by
// the share flow to rasterize the OG card (ogCard.js) before uploading it.
//
// THE FONT GOTCHA (verified, not theoretical): an SVG drawn onto a canvas via <img> is an
// ISOLATED document — it can neither fetch its own @font-face fonts NOR reach the host page's
// already-loaded ones. document.fonts.ready + document.fonts.load make fonts.check() pass, yet
// the raster still falls back to sans-serif (a Baloo raster came out pixel-identical to a plain
// sans-serif one). The only reliable fix is to EMBED the exact faces the card uses as base64
// @font-face inside the SVG, so the isolated document carries its own fonts. We inject that
// <style> here (at the I/O boundary) — the builder stays pure and font-agnostic. fonts.ready
// remains as a weak fallback for the rare case the woff2 bytes can't be fetched.
//
// Best-effort by contract: any failure (a tainted canvas, an <img> that won't decode, no DOM at
// all) resolves to null — the caller falls back to the generic OG image and sharing is never
// blocked or broken.

import BALOO_700_URL from '@fontsource/baloo-2/files/baloo-2-latin-700-normal.woff2?url';
import BALOO_600_URL from '@fontsource/baloo-2/files/baloo-2-latin-600-normal.woff2?url';
import MONO_600_URL from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2?url';

// Only the exact faces the card's text uses: title (Baloo 700), watermark (Baloo 600), readout
// (JetBrains Mono 600). The latin subset covers the card's copy — titles, "Made with Windmill",
// digits and the ellipsis.
const CARD_FACES = [
  { family: 'Baloo 2', weight: 700, url: BALOO_700_URL },
  { family: 'Baloo 2', weight: 600, url: BALOO_600_URL },
  { family: 'JetBrains Mono', weight: 600, url: MONO_600_URL },
];

let fontStyle = null; // the embedded <style>, fetched + encoded once and reused across shares

export async function svgToPngBlob(svgString, width = 2400, height = 1260) {
  if (typeof document === 'undefined') return null;
  try {
    const markup = await withEmbeddedFonts(svgString);
    const image = await decodeSvg(markup);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);

    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  } catch {
    return null;
  }
}

// The card's fonts as a base64 @font-face <style>, fetched + encoded once and reused. Exposed so
// the share-video capture can embed the same faces in every frame it rasterises (same font gotcha).
export async function embeddedFontStyle() {
  if (!fontStyle) fontStyle = await buildFontStyle();
  return fontStyle;
}

async function withEmbeddedFonts(svgString) {
  try {
    const style = await embeddedFontStyle();
    const at = svgString.indexOf('>'); // end of the opening <svg …> tag
    return at < 0 ? svgString : `${svgString.slice(0, at + 1)}${style}${svgString.slice(at + 1)}`;
  } catch {
    // The woff2 bytes couldn't be fetched — fall back to the host page's loaded faces (weaker:
    // it works in some engines, not all) rather than failing the whole raster.
    if (document.fonts) await document.fonts.ready.catch(() => {});
    return svgString;
  }
}

async function buildFontStyle() {
  const faces = await Promise.all(CARD_FACES.map(async (face) => {
    const bytes = new Uint8Array(await fetch(face.url).then((response) => response.arrayBuffer()));
    return `@font-face{font-family:'${face.family}';font-style:normal;font-weight:${face.weight};`
      + `src:url(data:font/woff2;base64,${bytesToBase64(bytes)}) format('woff2');}`;
  }));
  return `<style>${faces.join('')}</style>`;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function decodeSvg(svgString) {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('svg image failed to decode'));
    image.src = url;
  });
}
