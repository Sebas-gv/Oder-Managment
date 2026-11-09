'use strict';

/**
 * Order business logic. Everything is in memory, with fictional data.
 *
 * Flow: placed -> accepted -> assigned -> picked_up -> delivered
 *
 * Rules:
 *  - An order can only move to the next state (no skipping, no going back).
 *  - An order can only be assigned once (the `assigned` state is never repeated).
 *  - A driver can only have one active order (assigned/picked_up) at a time.
 *  - The driver is freed when the order moves to `delivered`.
 *
 * Node runs this code on a single thread and `transition` is synchronous, so
 * "is the driver free?" + "assign" is atomic: two simultaneous requests cannot
 * assign the same driver. With a real database you would need a transaction
 * or a conditional UPDATE.
 */

const STATUSES = ['placed', 'accepted', 'assigned', 'picked_up', 'delivered'];

const NEXT_STATUS = {
  placed: 'accepted',
  accepted: 'assigned',
  assigned: 'picked_up',
  picked_up: 'delivered',
  delivered: null,
};

class DomainError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.name = this.constructor.name;
    this.httpStatus = httpStatus;
  }
}
class ValidationError extends DomainError {
  constructor(message) { super(message, 400); }
}
class NotFoundError extends DomainError {
  constructor(message) { super(message, 404); }
}
class InvalidTransitionError extends DomainError {
  constructor(message) { super(message, 409); }
}
class DriverBusyError extends DomainError {
  constructor(message) { super(message, 409); }
}

const DEFAULT_DRIVERS = [
  { id: 'drv_1', name: 'Ana Loma' },
  { id: 'drv_2', name: 'Luis Ortega' },
  { id: 'drv_3', name: 'Marta Soler' },
];

class OrderService {
  constructor({ drivers = DEFAULT_DRIVERS, now = () => new Date() } = {}) {
    this._now = now;
    this._orders = new Map();
    this._seq = 0;
    this._drivers = new Map(
      drivers.map((d) => [d.id, { id: d.id, name: d.name, currentOrderId: null }])
    );
  }

  createOrder(input) {
    const { customerName, address, items } = input || {};
    if (typeof customerName !== 'string' || !customerName.trim()) {
      throw new ValidationError('customerName is required');
    }
    if (typeof address !== 'string' || !address.trim()) {
      throw new ValidationError('address is required');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError('items must be a list with at least one item');
    }
    const cleanItems = items.map((it, i) => {
      const name = it && typeof it.name === 'string' ? it.name.trim() : '';
      const quantity = it && it.quantity;
      const unitPrice = it && it.unitPrice;
      if (!name) throw new ValidationError(`items[${i}].name is required`);
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new ValidationError(`items[${i}].quantity must be an integer >= 1`);
      }
      if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new ValidationError(`items[${i}].unitPrice must be a number >= 0`);
      }
      return { name, quantity, unitPrice };
    });

    const id = `ord_${String(++this._seq).padStart(4, '0')}`;
    const ts = this._now().toISOString();
    const total = cleanItems.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);
    const order = {
      id,
      customerName: customerName.trim(),
      address: address.trim(),
      items: cleanItems,
      total: Math.round(total * 100) / 100,
      status: 'placed',
      driverId: null,
      createdAt: ts,
      updatedAt: ts,
      history: [{ status: 'placed', at: ts }],
    };
    this._orders.set(id, order);
    return this._snapshot(order);
  }

  getOrder(id) {
    return this._snapshot(this._mustGet(id));
  }

  listOrders({ status } = {}) {
    if (status !== undefined && !STATUSES.includes(status)) {
      throw new ValidationError(`Invalid status: ${status}`);
    }
    return [...this._orders.values()]
      .filter((o) => !status || o.status === status)
      .map((o) => this._snapshot(o));
  }

  listDrivers() {
    return [...this._drivers.values()].map((d) => ({ ...d, busy: d.currentOrderId !== null }));
  }

  /**
   * Moves an order to a new state. `to` must be exactly the next one.
   * Assigning requires a `driverId`.
   */
  transition(orderId, to, { driverId } = {}) {
    const order = this._mustGet(orderId);

    if (!STATUSES.includes(to)) {
      throw new ValidationError(`Unknown status: ${to}`);
    }
    const expected = NEXT_STATUS[order.status];
    if (to !== expected) {
      const hint = expected ? `the next valid status is "${expected}"` : 'the order is already in a final state';
      throw new InvalidTransitionError(
        `Invalid transition ${order.status} -> ${to}: ${hint}`
      );
    }

    // All checks happen BEFORE mutating anything, so we never leave half-applied state.
    let driver = null;
    if (to === 'assigned') {
      if (typeof driverId !== 'string' || !driverId) {
        throw new ValidationError('driverId is required to assign an order');
      }
      driver = this._drivers.get(driverId);
      if (!driver) throw new NotFoundError(`Driver not found: ${driverId}`);
      if (driver.currentOrderId !== null) {
        throw new DriverBusyError(
          `Driver ${driver.name} is already assigned to order ${driver.currentOrderId}`
        );
      }
    }

    if (to === 'assigned') {
      driver.currentOrderId = order.id;
      order.driverId = driver.id;
    } else if (to === 'delivered') {
      const d = this._drivers.get(order.driverId);
      if (d && d.currentOrderId === order.id) d.currentOrderId = null;
    }

    const ts = this._now().toISOString();
    order.status = to;
    order.updatedAt = ts;
    order.history.push({ status: to, at: ts });
    return this._snapshot(order);
  }

  _mustGet(id) {
    const order = this._orders.get(id);
    if (!order) throw new NotFoundError(`Order not found: ${id}`);
    return order;
  }

  // Deep copy so callers cannot mutate internal state.
  _snapshot(order) {
    return JSON.parse(JSON.stringify(order));
  }
}

module.exports = {
  OrderService,
  STATUSES,
  NEXT_STATUS,
  DomainError,
  ValidationError,
  NotFoundError,
  InvalidTransitionError,
  DriverBusyError,
};
