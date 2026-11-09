'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { OrderService } = require('../src/orderService');

async function withServer(fn) {
  const server = createServer(new OrderService());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const order = {
  customerName: 'Carla Mendoza',
  address: '123 Fake Street',
  items: [{ name: 'Pizza', quantity: 1, unitPrice: 9.5 }],
};

test('API: full flow, 409 on invalid transition and on double assignment', async () => {
  await withServer(async (call) => {
    const created = await call('POST', '/api/orders', order);
    assert.equal(created.status, 201);
    const a = created.body.id;
    const b = (await call('POST', '/api/orders', order)).body.id;

    // invalid transition -> 409
    let r = await call('POST', `/api/orders/${a}/status`, { status: 'delivered' });
    assert.equal(r.status, 409);

    await call('POST', `/api/orders/${a}/status`, { status: 'accepted' });
    await call('POST', `/api/orders/${b}/status`, { status: 'accepted' });

    r = await call('POST', `/api/orders/${a}/status`, { status: 'assigned', driverId: 'drv_1' });
    assert.equal(r.status, 200);

    // same driver on another order -> 409
    r = await call('POST', `/api/orders/${b}/status`, { status: 'assigned', driverId: 'drv_1' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already assigned/);

    // order A reaches the end
    await call('POST', `/api/orders/${a}/status`, { status: 'picked_up' });
    r = await call('POST', `/api/orders/${a}/status`, { status: 'delivered' });
    assert.equal(r.body.status, 'delivered');
  });
});

test('API: validation (400) and not found (404)', async () => {
  await withServer(async (call) => {
    assert.equal((await call('POST', '/api/orders', { customerName: 'x' })).status, 400);
    assert.equal((await call('GET', '/api/orders/ord_9999')).status, 404);
    assert.equal((await call('GET', '/api/nothing')).status, 404);
  });
});

test('API: concurrent requests for the same driver -> only one wins', async () => {
  await withServer(async (call) => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = (await call('POST', '/api/orders', order)).body.id;
      await call('POST', `/api/orders/${id}/status`, { status: 'accepted' });
      ids.push(id);
    }
    const results = await Promise.all(
      ids.map((id) => call('POST', `/api/orders/${id}/status`, { status: 'assigned', driverId: 'drv_2' }))
    );
    const ok = results.filter((r) => r.status === 200).length;
    const conflict = results.filter((r) => r.status === 409).length;
    assert.equal(ok, 1);
    assert.equal(conflict, 4);
  });
});
