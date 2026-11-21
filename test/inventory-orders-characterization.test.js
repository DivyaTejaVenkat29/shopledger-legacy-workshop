'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const inventory = require('../lib/inventory');
const ordersRouter = require('../routes/orders');
const store = require('../lib/store');

const postOrderHandler = ordersRouter.stack
  .find((layer) => layer.route && layer.route.path === '/orders' && layer.route.methods.post)
  .route.stack[0].handle;

const cancelOrderHandler = ordersRouter.stack
  .find((layer) => layer.route && layer.route.path === '/orders/:id/cancel' && layer.route.methods.post)
  .route.stack[0].handle;

function createInMemoryDb(stock) {
  return {
    products: [{ id: 1, sku: 'TEA-001', name: 'Tea', price: 10, stock, reserved: 0 }],
    orders: [],
    customers: [],
    settlements: [],
    auditLog: [],
    nextOrderId: 1001,
    nextSettlementId: 501
  };
}

function withInMemoryStore(db, run) {
  const originalRead = store.read;
  const originalWrite = store.write;
  store.read = () => db;
  store.write = () => {};
  try {
    return run();
  } finally {
    store.read = originalRead;
    store.write = originalWrite;
  }
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    }
  };
}

test('inventory check accepts selling exactly the last sellable unit', () => {
  const products = [{ id: 1, name: 'Tea', stock: 1, reserved: 0 }];

  assert.deepEqual(inventory.check(products, [{ id: 1, qty: 1 }]), { ok: true });
});

test('order route accepts the last unit and deducts stock', () => {
  const db = createInMemoryDb(1);
  const response = responseRecorder();

  withInMemoryStore(db, () => postOrderHandler({ body: { items: [{ id: 1, qty: 1 }] } }, response));

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.items[0].qty, 1);
  assert.equal(db.products[0].stock, 0);
  assert.equal(db.orders.length, 1);
});

test('cancelling an order restores its deducted stock', () => {
  const db = createInMemoryDb(2);
  const placeResponse = responseRecorder();
  const cancelResponse = responseRecorder();

  withInMemoryStore(db, () => {
    postOrderHandler({ body: { items: [{ id: 1, qty: 1 }] } }, placeResponse);
    assert.equal(db.products[0].stock, 1);
    cancelOrderHandler({ params: { id: '1001' }, body: {} }, cancelResponse);
  });

  assert.equal(placeResponse.statusCode, 201);
  assert.equal(cancelResponse.statusCode, 200);
  assert.equal(db.orders[0].status, 'cancelled');
  assert.equal(db.products[0].stock, 2);
  assert.equal(db.products[0].reserved, 0);
});
