'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { OrderService, DomainError } = require('./orderService');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 100 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { httpStatus: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { httpStatus: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(service, req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'orders', ':id', 'status']
  const method = req.method;

  // GET /api/drivers
  if (parts[1] === 'drivers' && parts.length === 2 && method === 'GET') {
    return sendJson(res, 200, service.listDrivers());
  }

  if (parts[1] === 'orders') {
    // GET /api/orders?status=placed
    if (parts.length === 2 && method === 'GET') {
      const status = url.searchParams.get('status') || undefined;
      return sendJson(res, 200, service.listOrders({ status }));
    }
    // POST /api/orders
    if (parts.length === 2 && method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 201, service.createOrder(body));
    }
    // GET /api/orders/:id
    if (parts.length === 3 && method === 'GET') {
      return sendJson(res, 200, service.getOrder(parts[2]));
    }
    // POST /api/orders/:id/status   { "status": "assigned", "driverId": "drv_1" }
    if (parts.length === 4 && parts[3] === 'status' && method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, service.transition(parts[2], body.status, { driverId: body.driverId }));
    }
  }

  return sendJson(res, 404, { error: 'Route not found' });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  // Prevent path traversal (../../etc/passwd)
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createServer(service = new OrderService()) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(service, req, res, url);
      }
      return serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof DomainError || err.httpStatus) {
        return sendJson(res, err.httpStatus, { error: err.message });
      }
      console.error(err);
      return sendJson(res, 500, { error: 'Internal error' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const service = new OrderService();
  // Sample (fictional) orders so the dashboard doesn't start empty.
  service.createOrder({
    customerName: 'Carla Mendoza',
    address: '123 Fake Street, Apt 2',
    items: [{ name: 'Margherita pizza', quantity: 2, unitPrice: 9.5 }, { name: 'Water 1L', quantity: 1, unitPrice: 1.8 }],
  });
  service.createOrder({
    customerName: 'Diego Paredes',
    address: '456 Fictional Ave',
    items: [{ name: 'Caesar salad', quantity: 1, unitPrice: 7.25 }],
  });
  createServer(service).listen(port, () => {
    console.log(`Server ready at http://localhost:${port}`);
  });
}

module.exports = { createServer };
