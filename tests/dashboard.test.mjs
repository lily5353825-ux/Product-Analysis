import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, validateDataset, defaultWindow, dayCount, divide } from '../src/web/dashboard-metrics.js';

const product = (sku, groupId) => ({ sku, groupId, itemId: `item-${sku}`, currency: 'USD' });
const order = (orderId, sku, groupId, overrides = {}) => ({ orderId, lineId: `${orderId}-${sku}`, sku, groupId, date: '2026-10-20', quantity: 1, itemSubtotalCents: 50000, discountCents: 1000, shippingCents: 7000, gmvCents: 49000, status: 'Shipped', ...overrides });
const ad = (sku, groupId, overrides = {}) => ({ date: '2026-10-20', campaignId: 'c1', adGroupId: 'a1', sku, groupId, itemId: `item-${sku}`, impressions: 100, clicks: 10, spendCents: 1000, attributedOrders: 1, attributedSalesCents: 20000, directSalesCents: 18000, otherSalesCents: 2000, ...overrides });
const fixture = () => ({ version: 1, products: [product('A', 'sofa106'), product('B', 'sofa106'), product('C', 'sofa79')], orders: [order('one', 'A', 'sofa106'), order('one', 'B', 'sofa106'), order('one', 'C', 'sofa79'), order('two', 'A', 'sofa106'), order('two', 'C', 'sofa79')], ads: [ad('A', 'sofa106'), ad('C', 'sofa79')] });
const window = { start: '2026-10-20', end: '2026-10-20' };

test('unique overall orders and per-category target attainment use separate counts', () => {
  const metrics = computeMetrics(validateDataset(fixture()), window);
  assert.equal(metrics.orders, 2);
  assert.equal(metrics.units, 5);
  assert.equal(metrics.targetOrderCount, 4);
  assert.equal(metrics.target, 4);
  assert.equal(metrics.progress, 1);
  assert.equal(metrics.gap, 0);
  assert.equal(metrics.gmv, 245000);
  assert.equal(metrics.shipping, 35000);
  assert.equal(metrics.series[0].targetOrderCount, 4);
  assert.deepEqual(metrics.comparisons.map(r => r.orders), [2, 2]);
});

test('efficiency uses direct sales, not halo total, and sales GMV excludes shipping', () => {
  const m = computeMetrics(validateDataset(fixture()), window);
  assert.equal(m.spend, 2000);
  assert.equal(m.directSales, 36000);
  assert.equal(m.attributedSales, 40000);
  assert.equal(m.acos, 2000 / 36000);
  assert.equal(m.roas, 18);
  assert.equal(m.tacos, 2000 / 245000);
  assert.equal(m.comparable, true);
});

test('cancelled-only dates remain recorded but contribute zero orders, units and GMV', () => {
  const f = fixture(); f.orders = [order('cancelled', 'A', 'sofa106', { status: 'Canceled', gmvCents: 0 })];
  const m = computeMetrics(validateDataset(f), { ...window, groupId: 'sofa106' });
  assert.equal(m.orders, 0); assert.equal(m.gmv, 0); assert.equal(m.units, 0);
  assert.equal(m.hasSalesRecords, true); assert.equal(m.series[0].hasSalesRecords, true);
  assert.equal(m.comparisons[0].hasSalesRecords, true); assert.equal(m.cancelledRows, 1);
});

test('inclusive calendar goals and filters respect selected categories', () => {
  const f = validateDataset(fixture());
  assert.equal(dayCount('2026-10-20', '2026-10-22'), 3);
  const m = computeMetrics(f, { start: '2026-10-20', end: '2026-10-22', groupId: 'sofa79', dailyTarget: 2 });
  assert.equal(m.target, 6); assert.equal(m.orders, 2); assert.equal(m.gap, -4);
  assert.equal(m.series[1].hasSalesRecords, false);
  assert.equal(m.comparable, false);
  assert.throws(() => computeMetrics(f, { ...window, dailyTarget: 2.5 }), /整数/);
  assert.throws(() => computeMetrics(f, { ...window, dailyTarget: NaN }), /整数/);
  assert.throws(() => dayCount('2026-02-30', '2026-03-01'), /有效/);
  assert.throws(() => computeMetrics(f, { start: '2000-01-01', end: '2026-10-20' }), /10 年/);
});

test('zero denominators remain unavailable and missing ads are distinguished from zero spend', () => {
  assert.equal(divide(1, 0), null);
  const f = fixture(); f.ads = [];
  const m = computeMetrics(validateDataset(f), window);
  assert.equal(m.hasAds, false); assert.equal(m.acos, null); assert.equal(m.roas, null); assert.equal(m.comparable, false);
  f.ads = [ad('A', 'sofa106', { spendCents: 0, directSalesCents: 0, otherSalesCents: 0, attributedSalesCents: 0, attributedOrders: 0 })];
  const z = computeMetrics(validateDataset(f), { ...window, groupId: 'sofa106' });
  assert.equal(z.hasAds, true); assert.equal(z.spend, 0); assert.equal(z.roas, null); assert.equal(z.acos, null);
});

test('coverage is computed from records, defaults to intersection, and missing category coverage is not comparable', () => {
  const f = fixture(); f.coverage = { salesStart: '2000-01-01' };
  f.orders.push(order('late', 'A', 'sofa106', { date: '2026-10-23' }));
  f.ads.push(ad('A', 'sofa106', { date: '2026-10-21' }));
  const data = validateDataset(f);
  assert.deepEqual(defaultWindow(data), { start: '2026-10-20', end: '2026-10-21', overlap: true });
  assert.equal(computeMetrics(data, { start: '2026-10-20', end: '2026-10-21' }).comparable, false);
});

test('invalid or missing numerics, duplicate lines and bad dates are rejected', () => {
  for (const invalid of [null, undefined, '', '0', NaN, Infinity, -1, 1.1]) {
    const f = fixture(); f.orders[0].gmvCents = invalid;
    assert.throws(() => validateDataset(f), /gmvCents/);
  }
  let f = fixture(); f.orders.push({ ...f.orders[0] }); assert.throws(() => validateDataset(f), /重复订单/);
  f = fixture(); f.ads[0].date = '2026-02-30'; assert.throws(() => validateDataset(f), /日期/);
  f = fixture(); delete f.orders[0].status; assert.throws(() => validateDataset(f), /状态/);
  f = fixture(); f.orders[0].status = 'Returned'; assert.throws(() => validateDataset(f), /状态/);
  f = fixture(); f.orders[0].date = '2026-10-21'; assert.throws(() => validateDataset(f), /同一订单编号.*日期不一致/);
});

test('JSON imports enforce foreign keys, currency and financial consistency', () => {
  let f = fixture(); f.products[0].currency = 'EUR'; assert.throws(() => validateDataset(f), /USD/);
  f = fixture(); f.products.push({ ...f.products[0] }); assert.throws(() => validateDataset(f), /重复/);
  f = fixture(); f.orders[0].groupId = 'sofa79'; assert.throws(() => validateDataset(f), /不一致/);
  f = fixture(); f.orders[0].quantity = 0; assert.throws(() => validateDataset(f), /数量/);
  f = fixture(); f.orders[0].gmvCents++; assert.throws(() => validateDataset(f), /GMV/);
  f = fixture(); f.orders[0].discountCents = 60000; assert.throws(() => validateDataset(f), /折扣/);
  f = fixture(); f.ads[0].itemId = 'different'; assert.throws(() => validateDataset(f), /Item ID/);
  f = fixture(); f.ads[0].clicks = 101; assert.throws(() => validateDataset(f), /点击/);
  f = fixture(); f.ads[0].otherSalesCents++; assert.throws(() => validateDataset(f), /之和/);
  f = fixture(); f.ads.push({ ...f.ads[0] }); assert.throws(() => validateDataset(f), /重复广告/);
});

test('overflow is rejected instead of displaying corrupted aggregate amounts', () => {
  const f = fixture();
  f.orders[0].itemSubtotalCents = Number.MAX_SAFE_INTEGER;
  f.orders[0].discountCents = 0; f.orders[0].gmvCents = Number.MAX_SAFE_INTEGER;
  assert.throws(() => validateDataset(f), /安全范围/);
});

test('JSON text remains inert strings; warnings cannot inject structured UI values', () => {
  const f = fixture(); f.sourceName = '<img src=x onerror=alert(1)>';
  f.warnings = ['<script>alert(1)</script>', { html: 'x' }];
  const d = validateDataset(f);
  assert.equal(d.sourceName, f.sourceName); assert.deepEqual(d.warnings, ['<script>alert(1)</script>']);
});
