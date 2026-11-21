'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const ordersRouter = require('../routes/orders');
const customersRouter = require('../routes/customers');
const store = require('../lib/store');

const listOrdersHandler = ordersRouter.stack
  .find((layer) => layer.route && layer.route.path === '/orders' && layer.route.methods.get)
  .route.stack[0].handle;

const settleCustomerHandler = customersRouter.stack
  .find((layer) => layer.route && layer.route.path === '/customers/:id/settle' && layer.route.methods.post)
  .route.stack[0].handle;

function createInMemoryDb() {
  return {
    products: [],
    orders: [
      { id: 1001, date: '31/12/2021', customer: 'December' },
      { id: 1002, date: '01/01/2022', customer: 'January one' },
      { id: 1003, date: '02/02/2022', customer: 'February' }
    ],
    customers: [{
      id: 10,
      name: 'Asha Rao',
      creditLimit: 5000,
      openingBalance: 0,
      totalBilled: 1000,
      totalSettled: 0
    }],
    settlements: [],
    auditLog: [],
    nextOrderId: 1004,
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

function listOrders(db, query) {
  const response = responseRecorder();
  withInMemoryStore(db, () => listOrdersHandler({ query }, response));
  return response.body;
}

function recordSettlement(db, amount) {
  const response = responseRecorder();
  withInMemoryStore(db, () => settleCustomerHandler({
    params: { id: '10' },
    body: { amount, mode: 'cash', note: 'test payment' }
  }, response));
  return response;
}

test('order history sorts DD/MM/YYYY dates in descending calendar order', () => {
  const db = createInMemoryDb();

  const result = listOrders(db, {});

  assert.deepEqual(result.map((order) => order.id), [1003, 1002, 1001]);
});

test('date range filters include only matching dates, including both endpoints', () => {
  const db = createInMemoryDb();

  const fromResults = listOrders(db, { from: '2022-01-01' });
  const toResults = listOrders(db, { to: '2022-01-01' });

  assert.deepEqual(fromResults.map((order) => order.id), [1003, 1002]);
  assert.deepEqual(toResults.map((order) => order.id), [1002, 1001]);
});

test('consecutive settlements from the amount input add numeric totals', () => {
  const db = createInMemoryDb();

  const first = recordSettlement(db, '200');
  const second = recordSettlement(db, '100');

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.equal(db.customers[0].totalSettled, 300);
  assert.equal(db.customers[0].balance, 700);
  assert.deepEqual(db.settlements.map((settlement) => settlement.amount), [100, 200]);
});

test('CURRENT BEHAVIOUR: settlement larger than the outstanding balance is accepted', () => {
  const db = createInMemoryDb();
  db.customers[0].totalBilled = 100;

  const response = recordSettlement(db, '150');

  assert.equal(response.statusCode, 201);
  assert.equal(db.customers[0].balance, -50);
  assert.equal(db.settlements[0].amount, 150);
});
