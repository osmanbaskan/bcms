import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const publicDir = path.join(rootDir, 'apps/web/dist/web/browser');
const port = Number(process.env.WEB_PORT ?? 4200);
const host = process.env.WEB_HOST ?? '0.0.0.0';
const apiTarget = new URL(process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000');

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const isProxyPath = (pathname) => pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/webhooks/');

function sendError(res, statusCode, message) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function proxyRequest(req, res) {
  const target = new URL(req.url ?? '/', apiTarget);
  target.hostname = apiTarget.hostname;
  target.port = apiTarget.port;
  target.protocol = apiTarget.protocol;

  const proxy = http.request(
    target,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: apiTarget.host,
        'x-forwarded-host': req.headers.host ?? '',
        'x-forwarded-proto': 'http',
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxy.on('error', () => {
    sendError(res, 502, 'API proxy unavailable');
  });

  req.pipe(proxy);
}

async function resolveAsset(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relativePath = decoded === '/' ? '/index.html' : decoded;
  const requested = path.normalize(path.join(publicDir, relativePath));

  if (!requested.startsWith(publicDir)) {
    return null;
  }

  try {
    const fileStat = await stat(requested);
    if (fileStat.isFile()) return requested;
  } catch {
    return path.join(publicDir, 'index.html');
  }

  return path.join(publicDir, 'index.html');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (isProxyPath(url.pathname)) {
      proxyRequest(req, res);
      return;
    }

    const filePath = await resolveAsset(url.pathname);
    if (!filePath) {
      sendError(res, 403, 'Forbidden');
      return;
    }

    const extension = path.extname(filePath);
    const cacheControl = filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, {
      'cache-control': cacheControl,
      'content-type': mimeTypes.get(extension) ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendError(res, 500, 'Internal server error');
  }
});

server.listen(port, host, () => {
  console.log(`BCMS Web static server listening at http://${host}:${port}`);
  console.log(`Proxying API requests to ${apiTarget.origin}`);
});
