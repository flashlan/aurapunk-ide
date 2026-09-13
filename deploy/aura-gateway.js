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
const cloudIdeBaseDomain = (process.env.CLOUD_IDE_BASE_DOMAIN ?? '')
  .trim()
  .toLowerCase()
  .replace(/^\*\./, '')
  .replace(/\.$/, '');
const cloudIdeGatewayKey = process.env.CLOUD_IDE_GATEWAY_KEY?.trim() ?? '';
const cloudIdeAllowedUpstreamHosts = new Set(
  (process.env.CLOUD_IDE_ALLOWED_UPSTREAM_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

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
    '/api/cloud-ide',
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

function cloudIdeTenantFromHost(hostHeader) {
  if (!cloudIdeBaseDomain) return null;
  const hostname = (hostHeader ?? '').split(':')[0].trim().toLowerCase().replace(/\.$/, '');
  const suffix = `.${cloudIdeBaseDomain}`;
  if (!hostname.endsWith(suffix) || hostname === cloudIdeBaseDomain) return null;
  const tenant = hostname.slice(0, -suffix.length);
  if (!/^personal-[a-z0-9-]{1,49}$/.test(tenant) || tenant.includes('.')) return null;
  return tenant;
}

function proxyHeaders(
  request,
  target,
  { forwardCookie = false, forwardAuthorization = false } = {},
) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || lower === 'connection' || lower === 'content-length' || lower === 'host') continue;
    if (!forwardCookie && lower === 'cookie') continue;
    if (!forwardAuthorization && lower === 'authorization') continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers.host = target.host;
  return headers;
}

function writeJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function resolveCloudIde(request, tenant) {
  if (!cloudIdeGatewayKey) return { status: 503, body: { error: 'Cloud IDE gateway is not configured' } };

  const resolveUrl = new URL('/api/cloud-ide/resolve', websiteOrigin);
  resolveUrl.searchParams.set('tenant', tenant);
  const headers = {
    'x-aurapunk-cloud-gateway-key': cloudIdeGatewayKey,
    'x-forwarded-host': request.headers.host ?? '',
  };
  if (request.headers.cookie) headers.cookie = request.headers.cookie;

  const upstreamResponse = await fetch(resolveUrl, { headers });
  const text = await upstreamResponse.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!upstreamResponse.ok) {
    return {
      status: upstreamResponse.status >= 500 ? 502 : upstreamResponse.status,
      body: body ?? { error: 'Cloud IDE is unavailable' },
    };
  }

  const host = typeof body?.upstream?.host === 'string' ? body.upstream.host.trim().toLowerCase() : '';
  const port = Number(body?.upstream?.port);
  if (!cloudIdeAllowedUpstreamHosts.has(host) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return { status: 502, body: { error: 'Cloud IDE upstream is not allowed' } };
  }
  return { status: 200, body: { host, port } };
}

async function proxyCloudIde(request, response, tenant) {
  try {
    const resolved = await resolveCloudIde(request, tenant);
    if (resolved.status !== 200) {
      writeJson(response, resolved.status, resolved.body);
      return;
    }
    const origin = `http://${resolved.body.host}:${resolved.body.port}`;
    proxyRequest(request, response, origin);
  } catch (error) {
    console.error('Cloud IDE resolution error:', error);
    writeJson(response, 502, { error: 'Cloud IDE gateway unavailable' });
  }
}

function proxyRequest(request, response, origin, options = {}) {
  const target = new URL(request.url ?? '/', origin);
  const upstream = fetch(target, {
    method: request.method,
    headers: proxyHeaders(request, target, options),
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
  const cloudIdeTenant = cloudIdeTenantFromHost(request.headers.host);

  if (cloudIdeTenant) {
    void proxyCloudIde(request, response, cloudIdeTenant);
    return;
  }

  if (isDemoRequest(pathname)) {
    void serveDemo(request, response);
    return;
  }

  if (isVibeApiRequest(pathname) && !isCloudApiRequest(pathname)) {
    proxyRequest(request, response, vibeOrigin, {
      forwardCookie: true,
      forwardAuthorization: true,
    });
    return;
  }

  proxyRequest(request, response, websiteOrigin, {
    forwardCookie: true,
    forwardAuthorization: true,
  });
});

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const cloudIdeTenant = cloudIdeTenantFromHost(request.headers.host);

  if (cloudIdeTenant) {
    void resolveCloudIde(request, cloudIdeTenant).then((resolved) => {
      if (resolved.status !== 200) {
        socket.destroy();
        return;
      }
      const upstream = connect(resolved.body.port, resolved.body.host, () => {
        const headers = Object.entries(request.headers)
          .filter(([name, value]) => {
            const lower = name.toLowerCase();
            return value !== undefined && lower !== 'host' && lower !== 'cookie' && lower !== 'authorization' && lower !== 'connection';
          })
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join('\r\n');
        upstream.write(
          `${request.method} ${pathname}${new URL(request.url ?? '/', 'http://localhost').search} HTTP/1.1\r\nHost: ${resolved.body.host}:${resolved.body.port}\r\nConnection: Upgrade\r\n${headers}\r\n\r\n`,
        );
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    }).catch(() => socket.destroy());
    return;
  }

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
  console.log(`Cloud IDE tenant gateway: *.${cloudIdeBaseDomain}`);
});
