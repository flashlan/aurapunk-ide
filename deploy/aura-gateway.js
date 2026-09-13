import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

const gatewayPort = Number.parseInt(process.env.PORT ?? '3000', 10);
const websiteOrigin = process.env.WEBSITE_ORIGIN ?? 'http://127.0.0.1:3200';
const vibeOrigin = process.env.VIBE_ORIGIN ?? 'http://127.0.0.1:3100';
const demoRoot = process.env.DEMO_ROOT ?? '/opt/vibe-kanban-demo/frontend-demo';
const demoPrefix = '/demo';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function isDemoRequest(pathname) {
  return pathname === demoPrefix || pathname.startsWith(`${demoPrefix}/`);
}

function isVibeApiRequest(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/v1' || pathname.startsWith('/v1/');
}

// The local gateway shares one origin between the Desktop API and the Cloud
// control plane. Cloud owns these prefixes; every other /api request remains
// compatible with the Vibe backend.
function isCloudApiRequest(pathname) {
  return [
    '/api/admin',
    '/api/billing',
    '/api/cloud-contract',
    '/api/cloud-workspace',
    '/api/dashboard',
    '/api/dashboard-api',
    '/api/deployment',
    '/api/desktop-auth',
    '/api/devices',
    '/api/instances',
    '/api/sync',
    '/api/teams',
  ].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function proxyRequest(request, response, origin) {
  const target = new URL(request.url ?? '/', origin);
  const upstream = fetch(target, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request,
    duplex: 'half',
  });

  upstream.then(async (upstreamResponse) => {
    // Node fetch transparently decodes gzip/br responses. Do not forward the
    // original encoding metadata, or browsers will attempt to decode the body
    // a second time and report an invalid content-encoding error.
    const headers = Object.fromEntries(upstreamResponse.headers);
    delete headers['content-encoding'];
    delete headers['content-length'];
    response.writeHead(upstreamResponse.status, headers);
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) response.write(chunk);
    }
    response.end();
  }).catch((error) => {
    console.error('Gateway proxy error:', error);
    if (!response.headersSent) response.writeHead(502);
    response.end('Bad gateway');
  });
}

async function serveDemo(request, response) {
  const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
  const relativePath = requestPath.slice(demoPrefix.length).replace(/^\/+/, '');
  const candidate = path.resolve(demoRoot, relativePath || 'index.html');
  const root = path.resolve(demoRoot);
  const safeCandidate = candidate === root || candidate.startsWith(`${root}${path.sep}`);

  if (!safeCandidate) {
    response.writeHead(400);
    response.end('Invalid demo path');
    return;
  }

  let filePath = candidate;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    filePath = path.join(root, 'index.html');
  }

  try {
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Demo frontend not found');
  }
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

  if (isDemoRequest(pathname)) {
    void serveDemo(request, response);
    return;
  }

  if (isVibeApiRequest(pathname) && !isCloudApiRequest(pathname)) {
    proxyRequest(request, response, vibeOrigin);
    return;
  }

  proxyRequest(request, response, websiteOrigin);
});

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (!isVibeApiRequest(pathname)) {
    socket.destroy();
    return;
  }

  const target = new URL(request.url ?? '/', vibeOrigin);
  const upstream = connect(Number(target.port || 80), target.hostname, () => {
    const headers = Object.entries(request.headers)
      .filter(([name]) => name.toLowerCase() !== 'host')
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .join('\r\n');
    upstream.write(
      `${request.method} ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\n${headers}\r\n\r\n`
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(gatewayPort, '0.0.0.0', () => {
  console.log(`AuraPunk gateway listening on http://0.0.0.0:${gatewayPort}`);
});
