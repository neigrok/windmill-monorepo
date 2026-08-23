// Turns an SVG string into a PNG Blob by drawing it onto a canvas through an <img>. An SVG drawn
// that way is an isolated document — it can reach neither its own @font-face fonts nor the host
// page's loaded ones — so the exact faces must be embedded as base64 @font-face inside the SVG.
// Any failure resolves to null.

import BALOO_700_URL from '@fontsource/baloo-2/files/baloo-2-latin-700-normal.woff2?url';
import BALOO_600_URL from '@fontsource/baloo-2/files/baloo-2-latin-600-normal.woff2?url';
import MONO_600_URL from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2?url';

// Only the exact faces the card's text uses; the latin subset covers its copy.
const CARD_FACES = [
  { family: 'Baloo 2', weight: 700, url: BALOO_700_URL },
  { family: 'Baloo 2', weight: 600, url: BALOO_600_URL },
  { family: 'JetBrains Mono', weight: 600, url: MONO_600_URL },
];

let fontStyle = null; // fetched and encoded once, reused across shares

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

// The card's fonts as a base64 @font-face <style>, shared with the share-video capture.
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
    // The woff2 bytes couldn't be fetched: fall back to the host page's loaded faces.
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
