import test from 'node:test';
import assert from 'node:assert/strict';
import { photoLimitNote, prepareCoachPhoto } from '../../../../src/products/gym/coach/photos.js';
import { gymApi } from '../../../../src/products/gym/gymApi.js';

test('picture limits accept the boundary and reject encoded size or decoded edge overruns', () => {
  assert.equal(photoLimitNote({ bytes: 5 * 1024 * 1024, width: 4096, height: 4096 }), null);
  assert.equal(photoLimitNote({ bytes: 5 * 1024 * 1024 + 1, width: 10, height: 10 }), 'Choose a photo up to 5 MB.');
  assert.equal(photoLimitNote({ bytes: 100, width: 4097, height: 10 }), 'Choose a photo no larger than 4096 × 4096 pixels.');
});

test('photo preparation keeps JPEG bytes and converts other decodable formats to JPEG', async (t) => {
  const bitmap = { width: 100, height: 200, close() {} };
  const decoded = [];
  const originalDecode = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.createImageBitmap = originalDecode; globalThis.document = originalDocument; });
  globalThis.createImageBitmap = async (blob) => { decoded.push(blob); return bitmap; };
  const jpeg = new Blob(['original jpeg'], { type: 'image/jpeg' });
  const kept = await prepareCoachPhoto(jpeg);
  assert.equal(kept.blob, jpeg);
  assert.deepEqual({ ...kept, blob: null }, { blob: null, mediaType: 'image/jpeg', width: 100, height: 200, bytes: jpeg.size });
  const converted = new Blob(['converted jpeg'], { type: 'image/jpeg' });
  globalThis.document = { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (done, type) => { assert.equal(type, 'image/jpeg'); done(converted); } }) };
  const webp = new Blob(['webp'], { type: 'image/webp' });
  assert.deepEqual(await prepareCoachPhoto(webp), { blob: converted, mediaType: 'image/jpeg', width: 100, height: 200, bytes: converted.size });
  assert.deepEqual(decoded, [jpeg, webp]);
});

test('raw upload reports browser progress, uses credentials, and abort preserves cancellation identity', async (t) => {
  const original = globalThis.XMLHttpRequest;
  t.after(() => { globalThis.XMLHttpRequest = original; });
  const requests = [];
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.header = [name, value]; }
    send(blob) { this.blob = blob; }
    abort() { this.onabort(); }
  };
  const blob = new Blob(['photo'], { type: 'image/png' });
  const progress = [];
  const completed = gymApi.uploadCoachPhoto('thr_1', 'img_1', blob, { onProgress: (value) => progress.push(value) });
  const request = requests[0];
  request.upload.onprogress({ lengthComputable: true, loaded: 2, total: 4 });
  request.status = 200;
  request.responseText = JSON.stringify({ attachment: { id: 'img_1', mediaType: 'image/png', width: 1, height: 1, bytes: 5 } });
  request.onload();
  assert.deepEqual(await completed, { id: 'img_1', mediaType: 'image/png', width: 1, height: 1, bytes: 5 });
  assert.deepEqual(progress, [0.5]);
  assert.equal(request.method, 'PUT');
  assert.ok(request.url.endsWith('/threads/thr_1/attachments/img_1'));
  assert.equal(request.withCredentials, true);
  assert.deepEqual(request.header, ['content-type', 'image/png']);
  assert.equal(request.blob, blob);
  const controller = new AbortController();
  const canceled = gymApi.uploadCoachPhoto('thr_1', 'img_2', blob, { signal: controller.signal });
  controller.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
});

test('stored photos are fetched privately with cookies and no bearer URL', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response('private image', { headers: { 'content-type': 'image/png' } });
  });
  const blob = await gymApi.coachPhoto('thr_1', 'img_1');
  assert.equal(await blob.text(), 'private image');
  assert.equal(calls[0].options.credentials, 'include');
  assert.ok(calls[0].url.endsWith('/threads/thr_1/attachments/img_1'));
  assert.equal(new URL(calls[0].url).search, '');
});
