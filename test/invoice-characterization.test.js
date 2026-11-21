'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const invoice = require('../lib/invoice');
const reports = require('../lib/reports');
const store = require('../lib/store');
const orderRouter = require('../routes/orders');

const postOrderHandler = orderRouter.stack
  .find((layer) => layer.route && layer.route.path === '/orders' && layer.route.methods.post)
  .route.stack[0].handle;

function createInMemoryDb() {
  return {
    products: [{
      id: 1,
      sku: 'RICE-001',
      name: 'Rice',
      hsn: '1006',
      price: 2000,
      stock: 5,
      reserved: 0
    }],
    orders: [],
    customers: [],
    settlements: [],
    auditLog: [],
    nextOrderId: 1001,
    nextSettlementId: 501
  };
}

function submitOrderInMemory(db, body) {
  const originalRead = store.read;
  const originalWrite = store.write;
  let writtenDb;
  const res = {
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

  store.read = () => db;
  store.write = (value) => { writtenDb = value; };
  try {
    postOrderHandler({ body }, res);
    return { response: res, writtenDb };
  } finally {
    store.read = originalRead;
    store.write = originalWrite;
  }
}

test('invoice matches the HSN GST, capped discount, and total billed to the customer', () => {
  const db = createInMemoryDb();
  const { response } = submitOrderInMemory(db, {
    items: [{ id: 1, qty: 1 }],
    coupon: 'SAVE10',
    paymentMode: 'cash'
  });

  const figures = invoice.computeInvoiceFigures(response.body);

  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.rows[0].lineTax, 92.5);
  assert.equal(figures.subtotal, response.body.subtotal);
  assert.equal(figures.discount, response.body.discount);
  assert.equal(figures.tax, response.body.tax);
  assert.equal(figures.cgst, 46.25);
  assert.equal(figures.sgst, 46.25);
  assert.equal(figures.total, response.body.total);
  assert.equal(invoice.render(response.body).includes('Accountant Reconciliation Notice'), false);
});

test('CURRENT BEHAVIOUR: order route bills by HSN rate after applying the capped coupon', () => {
  const db = createInMemoryDb();
  const { response, writtenDb } = submitOrderInMemory(db, {
    items: [{ id: 1, qty: 1 }],
    coupon: 'SAVE10',
    paymentMode: 'cash'
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.subtotal, 2000);
  assert.equal(response.body.discount, 150);
  assert.equal(response.body.tax, 92.5);
  assert.equal(response.body.total, 1942.5);
  assert.equal(writtenDb.orders[0].total, 1942.5);
  assert.equal('gstRate' in writtenDb.orders[0].items[0], false);
});

test('invoice resolves the configured HSN slab when an order line has no gstRate', () => {
  const result = invoice.computeInvoiceFigures({
    items: [{ name: 'Rice', sku: 'RICE-001', hsn: '1006', price: 2000, qty: 1 }],
    coupon: ''
  });

  assert.equal(result.rows[0].gstPercent, 5);
  assert.equal(result.tax, 100);
  assert.equal(result.total, 2100);
});

test('invoice applies percentage coupon to subtotal, respects its cap, and taxes discounted value', () => {
  const result = invoice.computeInvoiceFigures({
    items: [{ name: 'Rice', sku: 'RICE-001', hsn: '1006', gstRate: 5, price: 2000, qty: 1 }],
    coupon: 'SAVE10'
  });

  assert.equal(result.tax, 92.5);
  assert.equal(result.discount, 150);
  assert.equal(result.total, 1942.5);
});

test('reconciliation matches invoice to billed order and skips cancelled orders', () => {
  const db = createInMemoryDb();
  const { response } = submitOrderInMemory(db, {
    items: [{ id: 1, qty: 1 }],
    coupon: 'SAVE10',
    paymentMode: 'cash'
  });
  const savedOrder = response.body;
  db.orders.push(Object.assign({}, savedOrder, { id: 1002, status: 'cancelled' }));

  const result = reports.getGstReconciliation(db);

  assert.equal(result.totalChecked, 1);
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.rows[0].ledgerTotal, 1942.5);
  assert.equal(result.rows[0].invoiceTotal, 1942.5);
  assert.equal(result.rows[0].delta, 0);
  assert.equal(result.rows[0].matched, true);
});
