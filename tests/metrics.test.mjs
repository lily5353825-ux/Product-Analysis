import test from "node:test";
import assert from "node:assert/strict";
import { safeRatio, summarizeSales, summarizeAdvertising, targetProgress, calculateOverview } from "../src/domain/metrics.mjs";

const line = (patch = {}) => ({
  order_id: "O1", line_id: "1", sku: "SKU_A",
  quantity: 1, cancelled_quantity: 0,
  item_subtotal_cents: 10000, discount_cents: 0,
  cancelled_net_cents: 0, refund_cents: 0, ...patch
});
const ad = (patch = {}) => ({
  date: "2026-10-20", campaign_id: "C1", impressions: 1000, clicks: 20,
  spend_cents: 3400, attributed_orders: 2, attributed_sales_cents: 17000, ...patch
});
const rows = [
  line({ quantity: 2, cancelled_quantity: 1, item_subtotal_cents: 20000, discount_cents: 2000, cancelled_net_cents: 9000 }),
  line({ line_id: "2", sku: "SKU_B", item_subtotal_cents: 15000 }),
  line({ order_id: "O2", refund_cents: 2000 }),
  line({ order_id: "O3", cancelled_quantity: 1, cancelled_net_cents: 10000 })
];

test("GMV handles discounts/cancellations; refunds affect only net sales", () => {
  assert.deepEqual(summarizeSales(rows), { gmvCents: 34000, netSalesCents: 32000, orders: 2, units: 3, aovCents: 17000 });
});

test("cross-SKU orders are deduplicated; SKU counts are not additive", () => {
  const a = summarizeSales(rows.filter(row => row.sku === "SKU_A"));
  const b = summarizeSales(rows.filter(row => row.sku === "SKU_B"));
  assert.equal(a.orders, 2);
  assert.equal(b.orders, 1);
  assert.equal(summarizeSales(rows).orders, 2);
  assert.equal(a.gmvCents + b.gmvCents, 34000);
});

test("full refunds retain original order count", () => {
  assert.equal(summarizeSales([line({ refund_cents: 10000 })]).orders, 1);
  assert.equal(summarizeSales([line({ refund_cents: 10000 })]).netSalesCents, 0);
});

test("free goods can count as orders, full cancellations cannot", () => {
  assert.equal(summarizeSales([line({ item_subtotal_cents: 0 })]).orders, 1);
  assert.equal(summarizeSales([rows[3]]).orders, 0);
});

test("ad ratios use aggregate numerator/denominator", () => {
  const result = summarizeAdvertising([ad(), ad({ campaign_id: "C2", spend_cents: 100, attributed_sales_cents: 1000 })]);
  assert.equal(result.acos, 3500 / 18000);
  assert.notEqual(result.acos, (0.2 + 0.1) / 2);
  assert.equal(result.roas, 18000 / 3500);
});

test("overview separates shares, budget consumption, pace, and target gap", () => {
  const result = calculateOverview(summarizeSales(rows), summarizeAdvertising([ad()]), {
    periodBudgetCents: 10000, elapsedBudgetCents: 4000, elapsedGmvTargetCents: 40000
  });
  assert.equal(result.tacos, 0.1);
  assert.equal(result.adSalesShare, 0.5);
  assert.equal(result.budgetConsumption, 0.34);
  assert.equal(result.spendPace, 0.85);
  assert.equal(result.budgetRemainingCents, 6600);
  assert.deepEqual(result.gmvProgress, { target: 40000, delta: -6000, shortfall: 6000, completion: 0.85 });
});

test("zero denominators remain null and overspend remains negative", () => {
  assert.equal(safeRatio(1, 0), null);
  assert.equal(safeRatio(0, 0), null);
  assert.equal(targetProgress(10, 0).completion, null);
  const result = calculateOverview(summarizeSales([]), summarizeAdvertising([ad()]), {
    periodBudgetCents: 0, elapsedBudgetCents: 0, elapsedGmvTargetCents: 0
  });
  assert.equal(result.tacos, null);
  assert.equal(result.budgetConsumption, null);
  assert.equal(result.spendPace, null);
  assert.equal(result.budgetRemainingCents, -3400);
});

test("missing plans stay unknown", () => {
  const result = calculateOverview(summarizeSales(rows), summarizeAdvertising([ad()]), {
    periodBudgetCents: null, elapsedBudgetCents: null, elapsedGmvTargetCents: null
  });
  assert.equal(result.budgetRemainingCents, null);
  assert.equal(result.gmvProgress.delta, null);
});

test("ad sales share above 100 percent is not clipped", () => {
  const result = calculateOverview(summarizeSales([line()]), summarizeAdvertising([ad()]), {
    periodBudgetCents: null, elapsedBudgetCents: null, elapsedGmvTargetCents: null
  });
  assert.equal(result.adSalesShare, 1.7);
});

test("duplicate rows are rejected instead of doubling results", () => {
  assert.throws(() => summarizeSales([rows[0], rows[0]]), /Duplicate/);
  assert.throws(() => summarizeAdvertising([ad(), ad()]), /Duplicate/);
});

test("invalid amounts and quantities are rejected", () => {
  for (const patch of [
    { quantity: 0 }, { cancelled_quantity: 2 }, { spend_cents: -1, refund_cents: -1 },
    { discount_cents: 20000 }, { refund_cents: 10001 }, { quantity: "1" },
    { cancelled_net_cents: 1 }, { cancelled_quantity: 1, cancelled_net_cents: 0 }
  ]) assert.throws(() => summarizeSales([line(patch)]));
  assert.throws(() => summarizeAdvertising([ad({ clicks: 1001 })]));
  assert.throws(() => summarizeAdvertising([ad({ attributed_sales_cents: null })]));
  assert.throws(() => safeRatio(Infinity, 1));
  assert.throws(() => calculateOverview(summarizeSales(rows), summarizeAdvertising([ad()]), {
    periodBudgetCents: 1, elapsedBudgetCents: 2, elapsedGmvTargetCents: 0
  }));
});

test("aggregate overflow is rejected", () => {
  assert.throws(() => summarizeSales([
    line({ item_subtotal_cents: Number.MAX_SAFE_INTEGER }),
    line({ order_id: "overflow", item_subtotal_cents: 1 })
  ]), /safe integer/);
});
