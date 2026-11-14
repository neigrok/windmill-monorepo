import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

function proxyHeaders(headers, upgrade = false) {
  const omitted = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    ...(headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase()),
  ]);
  const result = Object.fromEntries(Object.entries(headers).filter(([name]) => !omitted.has(name)));
  if (upgrade) {
    result.connection = 'Upgrade';
    result.upgrade = headers.upgrade;
  }
  return result;
}

function reply(response, statusCode) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { 'content-length': 0, 'cache-control': 'no-store' });
  response.end();
}

function socketReply(socket, statusCode) {
  socket.end(`HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function serveBuilt({ root, port, backend, durationSeconds = 1800 }) {
  if (typeof root !== 'string' || !Number.isInteger(port) || port < 0 || port > 65535
    || !Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 2147483) {
    throw new Error('invalid server options');
  }
  const target = new URL(backend);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
    || target.pathname !== '/' || target.search || target.hash) throw new Error('backend must be an HTTP origin');
  const directory = await realpath(root);
  const index = await realpath(resolve(directory, 'index.html'));
  if (index !== resolve(directory, 'index.html') || !(await stat(index)).isFile()) throw new Error('invalid built index');
  const indexSha256 = createHash('sha256').update(await readFile(index)).digest('hex');
  const transport = target.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true });
  const sockets = new Set();
  const requests = new Set();
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  };

  function trackSocket(socket) {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  }

  function upstreamRequest(request, upgrade = false) {
    const upstream = transport.request(target, {
      method: request.method,
      path: request.url,
      headers: { ...proxyHeaders(request.headers, upgrade), host: target.host },
      // Drogon must receive the upgrade on a connection that has carried no HTTP requests.
      agent: upgrade ? false : agent,
    });
    requests.add(upstream);
    upstream.once('close', () => requests.delete(upstream));
    upstream.once('socket', trackSocket);
    upstream.setTimeout(30000, () => upstream.destroy());
    return upstream;
  }

  function proxyPath(url) {
    return /^\/(?:v1|mcp|oauth)(?:\/|\?|$)/.test(url);
  }

  const server = http.createServer(async (request, response) => {
    if (proxyPath(request.url)) {
      const upstream = upstreamRequest(request);
      upstream.once('response', (result) => {
        response.writeHead(result.statusCode, proxyHeaders(result.headers));
        result.once('error', () => response.destroy());
        result.pipe(response);
      });
      upstream.once('error', () => reply(response, 502));
      request.once('aborted', () => upstream.destroy());
      response.once('close', () => upstream.destroy());
      request.pipe(upstream);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      reply(response, 405);
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(request.url.split('?')[0]);
    } catch {
      reply(response, 400);
      return;
    }
    if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\0\\]/.test(pathname)
      || pathname.split('/').some((part) => part === '..' || part === '.')) {
      reply(response, 400);
      return;
    }
    try {
      let file = resolve(directory, pathname === '/gallery' ? 'gallery.html' : `.${pathname}`);
      let metadata;
      try {
        metadata = await stat(file);
        if (metadata.isDirectory()) file = resolve(file, 'index.html');
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        const appRoute = /^\/app(?:\/|$)/.test(pathname) || /^\/t\/[^/]+$/.test(pathname);
        if (!appRoute || extname(pathname)) {
          reply(response, 404);
          return;
        }
        file = index;
      }
      file = await realpath(file);
      const localPath = relative(directory, file);
      if (isAbsolute(localPath) || localPath === '..' || localPath.startsWith('../')) {
        reply(response, 403);
        return;
      }
      metadata = await stat(file);
      if (!metadata.isFile()) {
        reply(response, 404);
        return;
      }
      response.writeHead(200, {
        'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': metadata.size,
        'cache-control': 'no-store',
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const source = createReadStream(file);
      source.once('error', () => response.destroy());
      response.once('close', () => source.destroy());
      source.pipe(response);
    } catch (error) {
      reply(response, ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500);
    }
  });

  server.on('connection', trackSocket);
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    socket.once('end', () => socket.destroy());
    if (!proxyPath(request.url)) {
      socketReply(socket, 404);
      return;
    }
    const upstream = upstreamRequest(request, true);
    socket.once('close', () => upstream.destroy());
    upstream.once('error', () => {
      if (!socket.destroyed) socketReply(socket, 502);
    });
    upstream.once('response', (result) => {
      // A rejected handshake keeps its status, but its body and headers may contain credentials.
      socketReply(socket, result.statusCode);
      result.destroy();
    });
    upstream.once('upgrade', (result, peer, tail) => {
      peer.setTimeout(0);
      const headers = proxyHeaders(result.headers, true);
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((part) => `${name}: ${part}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      peer.once('error', () => socket.destroy());
      peer.once('close', () => socket.destroy());
      socket.once('close', () => peer.destroy());
      if (head.length) peer.write(head);
      if (tail.length) socket.write(tail);
      socket.pipe(peer);
      peer.pipe(socket);
    });
    upstream.end();
  });

  let shutdown;
  let timer;
  function close() {
    if (shutdown) return shutdown;
    clearTimeout(timer);
    shutdown = new Promise((done) => {
      server.close(done);
      for (const request of requests) request.destroy();
      for (const socket of sockets) socket.destroy();
      agent.destroy();
    });
    return shutdown;
  }
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', done);
    });
  } catch (error) {
    await close();
    throw error;
  }
  timer = setTimeout(close, durationSeconds * 1000);
  return { server, close, root: directory, indexSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      root: { type: 'string' }, port: { type: 'string' }, backend: { type: 'string' },
      duration: { type: 'string', default: '1800' },
    } });
    const instance = await serveBuilt({
      root: values.root, port: Number(values.port), backend: values.backend,
      durationSeconds: Number(values.duration),
    });
    process.once('SIGTERM', instance.close);
    process.once('SIGINT', instance.close);
    console.log(JSON.stringify({
      event: 'ready', port: instance.server.address().port, root: instance.root,
      indexSha256: instance.indexSha256,
    }));
  } catch {
    console.error('serve-built: startup failed; use --root DIST --port PORT --backend HTTP_ORIGIN [--duration SECONDS]');
    process.exitCode = 1;
  }
}
