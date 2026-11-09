'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OrderService,
  InvalidTransitionError,
  DriverBusyError,
  NotFoundError,
  ValidationError,
} = require('../src/orderService');

const sampleOrder = (over = {}) => ({
  customerName: 'Carla Mendoza',
  address: '123 Fake Street',
  items: [{ name: 'Pizza', quantity: 2, unitPrice: 9.5 }],
  ...over,
});

test('creates an order in placed state with a computed total', () => {
  const svc = new OrderService();
  const order = svc.createOrder(sampleOrder());
  assert.equal(order.status, 'placed');
  assert.equal(order.driverId, null);
  assert.equal(order.total, 19);
  assert.equal(order.history.length, 1);
  assert.deepEqual(svc.getOrder(order.id), order);
});

test('rejects invalid orders', () => {
  const svc = new OrderService();
  assert.throws(() => svc.createOrder(sampleOrder({ customerName: '  ' })), ValidationError);
  assert.throws(() => svc.createOrder(sampleOrder({ items: [] })), ValidationError);
  assert.throws(
    () => svc.createOrder(sampleOrder({ items: [{ name: 'x', quantity: 0, unitPrice: 1 }] })),
    ValidationError
  );
});

test('walks the happy path placed -> accepted -> assigned -> picked_up -> delivered', () => {
  const svc = new OrderService();
  const { id } = svc.createOrder(sampleOrder());

  assert.equal(svc.transition(id, 'accepted').status, 'accepted');
  const assigned = svc.transition(id, 'assigned', { driverId: 'drv_1' });
  assert.equal(assigned.status, 'assigned');
  assert.equal(assigned.driverId, 'drv_1');
  assert.equal(svc.transition(id, 'picked_up').status, 'picked_up');
  const delivered = svc.transition(id, 'delivered');
  assert.equal(delivered.status, 'delivered');
  assert.deepEqual(
    delivered.history.map((h) => h.status),
    ['placed', 'accepted', 'assigned', 'picked_up', 'delivered']
  );
});

test('rejects invalid transitions (skips, going back, repeats, after the end)', () => {
  const svc = new OrderService();
  const { id } = svc.createOrder(sampleOrder());

  // skip: placed -> picked_up
  assert.throws(() => svc.transition(id, 'picked_up'), InvalidTransitionError);
  // skip: placed -> delivered
  assert.throws(() => svc.transition(id, 'delivered'), InvalidTransitionError);
  // same state: placed -> placed
  assert.throws(() => svc.transition(id, 'placed'), InvalidTransitionError);

  svc.transition(id, 'accepted');
  // going back: accepted -> placed
  assert.throws(() => svc.transition(id, 'placed'), InvalidTransitionError);
  // repeat: accepted -> accepted
  assert.throws(() => svc.transition(id, 'accepted'), InvalidTransitionError);

  // a rejection must not change the state
  assert.equal(svc.getOrder(id).status, 'accepted');

  svc.transition(id, 'assigned', { driverId: 'drv_1' });
  svc.transition(id, 'picked_up');
  svc.transition(id, 'delivered');
  // final state: no further transitions
  assert.throws(() => svc.transition(id, 'delivered'), InvalidTransitionError);
  assert.throws(() => svc.transition(id, 'placed'), InvalidTransitionError);
});

test('unknown status and missing order', () => {
  const svc = new OrderService();
  const { id } = svc.createOrder(sampleOrder());
  assert.throws(() => svc.transition(id, 'flying'), ValidationError);
  assert.throws(() => svc.transition('ord_9999', 'accepted'), NotFoundError);
});

test('prevents assigning the same driver to two active orders at once', () => {
  const svc = new OrderService();
  const a = svc.createOrder(sampleOrder());
  const b = svc.createOrder(sampleOrder({ customerName: 'Diego Paredes' }));
  svc.transition(a.id, 'accepted');
  svc.transition(b.id, 'accepted');

  svc.transition(a.id, 'assigned', { driverId: 'drv_1' });

  // drv_1 is already busy with order A
  assert.throws(() => svc.transition(b.id, 'assigned', { driverId: 'drv_1' }), DriverBusyError);
  // and B has neither changed state nor received a driver
  const bAfter = svc.getOrder(b.id);
  assert.equal(bAfter.status, 'accepted');
  assert.equal(bAfter.driverId, null);

  // still busy while order A is picked_up
  svc.transition(a.id, 'picked_up');
  assert.throws(() => svc.transition(b.id, 'assigned', { driverId: 'drv_1' }), DriverBusyError);

  // a different driver is fine
  assert.equal(svc.transition(b.id, 'assigned', { driverId: 'drv_2' }).driverId, 'drv_2');
});

test('the driver is freed on delivery and can take another order', () => {
  const svc = new OrderService();
  const a = svc.createOrder(sampleOrder());
  const b = svc.createOrder(sampleOrder());
  svc.transition(a.id, 'accepted');
  svc.transition(b.id, 'accepted');

  svc.transition(a.id, 'assigned', { driverId: 'drv_1' });
  svc.transition(a.id, 'picked_up');
  svc.transition(a.id, 'delivered');

  assert.equal(svc.listDrivers().find((d) => d.id === 'drv_1').busy, false);
  assert.equal(svc.transition(b.id, 'assigned', { driverId: 'drv_1' }).driverId, 'drv_1');
});

test('the same order cannot be assigned twice (or have its driver swapped)', () => {
  const svc = new OrderService();
  const { id } = svc.createOrder(sampleOrder());
  svc.transition(id, 'accepted');
  svc.transition(id, 'assigned', { driverId: 'drv_1' });

  assert.throws(() => svc.transition(id, 'assigned', { driverId: 'drv_2' }), InvalidTransitionError);
  assert.equal(svc.getOrder(id).driverId, 'drv_1');
  // drv_2 is still free
  assert.equal(svc.listDrivers().find((d) => d.id === 'drv_2').busy, false);
});

test('assigning requires an existing driver', () => {
  const svc = new OrderService();
  const { id } = svc.createOrder(sampleOrder());
  svc.transition(id, 'accepted');
  assert.throws(() => svc.transition(id, 'assigned'), ValidationError);
  assert.throws(() => svc.transition(id, 'assigned', { driverId: 'drv_999' }), NotFoundError);
  assert.equal(svc.getOrder(id).status, 'accepted');
});
