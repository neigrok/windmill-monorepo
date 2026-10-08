import { sha256 } from './sha256.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (text) => encoder.encode(text);
export const hashText = (text) => sha256(utf8(text));

export function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

export function encode64(text) {
  let binary = '';
  for (const byte of utf8(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decode64(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('invalid cursor');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return decoder.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
