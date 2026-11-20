// The routes roadmap's move onto the engine retires or answers 410 (roadmap-on-the-engine.md §7, §8.3), and a stand-in
// for the server as the move leaves it, put between a built app and a backend that still serves them. Once the backend
// answers them itself under ROADMAP_ENGINE_ENABLED, this file goes and its callers meet the backend directly.
import { createServer, request as forward } from 'node:http';

// Each by its method, its path's shape and the name it is counted under. The fork, the activity and progress reads and
// tending stay.
export const RETIRED = [
  ['GET', /^\/v1\/trees$/, 'GET /v1/trees'],
  ['POST', /^\/v1\/trees$/, 'POST /v1/trees'],
  ['GET', /^\/v1\/trees\/[^/]+$/, 'GET /v1/trees/{id}'],
  ['PATCH', /^\/v1\/trees\/[^/]+$/, 'PATCH /v1/trees/{id}'],
  ['DELETE', /^\/v1\/trees\/[^/]+$/, 'DELETE /v1/trees/{id}'],
  ['GET', /^\/v1\/trees\/[^/]+\/guides$/, 'GET /v1/trees/{id}/guides'],
  ['GET', /^\/v1\/trees\/[^/]+\/diagnostics$/, 'GET /v1/trees/{id}/diagnostics'],
  ['PUT', /^\/v1\/trees\/[^/]+\/subtree$/, 'PUT /v1/trees/{id}/subtree'],
];

// Each route of `RETIRED` answers 410 `client-update-required` and `/v1/socket` refuses its upgrade so, each refusal
// counted in `refused` under its route's name, never its id. Every other request and upgrade passes to the backend on
// 127.0.0.1:`backendPort` as it came, an upgrade on a connection of its own, as Drogon needs. It listens on a port the
// system picks.
export async function refuseRetiredRoutes({ backendPort, refused }) {
  const count = (name) => refused.set(name, (refused.get(name) ?? 0) + 1);
  const gone = JSON.stringify({ code: 'client-update-required' });
  const toBackend = (request, agent) => forward({ host: '127.0.0.1', port: backendPort, method: request.method, path: request.url, headers: request.headers, agent });
  const statusLine = (answer) => `HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n${answer.rawHeaders
    .flatMap((value, index) => (index % 2 ? [] : [`${value}: ${answer.rawHeaders[index + 1]}`])).join('\r\n')}\r\n\r\n`;
  const server = createServer((request, response) => {
    const retired = RETIRED.find(([method, path]) => method === request.method && path.test(request.url.split('?')[0]));
    if (retired) {
      count(retired[2]);
      request.resume();
      response.writeHead(410, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(gone) }).end(gone);
      return;
    }
    const passed = toBackend(request);
    passed.once('response', (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    passed.once('error', () => response.destroy());
    request.pipe(passed);
  });
  server.on('upgrade', (request, socket, head) => {
    socket.once('error', () => socket.destroy());
    if (request.url.split('?')[0] === '/v1/socket') {
      count('WS /v1/socket');
      socket.end(`HTTP/1.1 410 Gone\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(gone)}\r\nconnection: close\r\n\r\n${gone}`);
      return;
    }
    const passed = toBackend(request, false);
    passed.once('upgrade', (answer, peer, tail) => {
      socket.write(statusLine(answer));
      if (tail.length) socket.write(tail);
      if (head.length) peer.write(head);
      peer.once('error', () => socket.destroy());
      socket.once('close', () => peer.destroy());
      peer.pipe(socket).pipe(peer);
    });
    passed.once('response', (answer) => {
      socket.write(statusLine(answer));
      answer.pipe(socket);
    });
    passed.once('error', () => socket.destroy());
    passed.end();
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  return server;
}
