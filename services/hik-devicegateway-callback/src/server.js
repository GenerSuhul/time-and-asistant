import http from 'node:http';
import { config } from './config.js';
import { handleUploadEvent } from './callback.js';

const settings = config();
const path = settings.callbackPath;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  console.log(JSON.stringify({
    request_at: new Date().toISOString(),
    method: request.method,
    url: request.url,
    content_type: request.headers['content-type'] || null,
    content_length: request.headers['content-length'] || null,
    remote_address: request.socket.remoteAddress || null
  }));
  if (request.method === 'POST' && url.pathname === path) return handleUploadEvent(request, response);
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ status: 'ok' }));
  }
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(settings.callbackPort, settings.callbackHost, () => {
  console.log(`Callback escuchando en http://${settings.callbackHost}:${settings.callbackPort}${path}`);
});
