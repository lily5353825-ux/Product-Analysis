// Pure metric functions. Import coverage, business dates, and attribution gates
// belong to the import/rules layers; these functions never infer missing data.
function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " must be a nonnegative safe integer");
  }
  return value;
}

function sum(values) {
  return values.reduce((total, value) => nonnegativeInteger(total + value, "sum"), 0);
}

function uniqueRows(rows, fields) {
  const seen = new Set();
  for (const row of rows) {
    for (const field of fields) {
      if (typeof row[field] !== "string" || !row[field].trim()) {
        throw new TypeError(field + " must be a nonempty string");
      }
    }
    const key = JSON.stringify(fields.map(field => row[field]));
    if (seen.has(key)) throw new Error("Duplicate row key: " + key);
    seen.add(key);
  }
}

export function safeRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) ||
      numerator < 0 || denominator < 0) {
    throw new TypeError("Ratio inputs must be finite nonnegative numbers");
  }
  if (denominator === 0) return null;
  const result = numerator / denominator;
  if (!Number.isFinite(result)) throw new RangeError("Ratio overflow");
  return result;
}

export function summarizeSales(rows) {
  uniqueRows(rows, ["order_id", "line_id"]);
  const orders = new Set();
  const values = rows.map(row => {
    for (const key of ["quantity", "cancelled_quantity", "item_subtotal_cents",
      "discount_cents", "cancelled_net_cents", "refund_cents"]) {
      nonnegativeInteger(row[key], key);
    }
    if (row.quantity === 0 || row.cancelled_quantity > row.quantity) {
      throw new RangeError("Invalid ordered/cancelled quantity");
    }
    const units = row.quantity - row.cancelled_quantity;
    const gmv = row.item_subtotal_cents - row.discount_cents - row.cancelled_net_cents;
    if (gmv < 0 || row.refund_cents > gmv || (units === 0 && gmv !== 0) ||
        (row.cancelled_quantity === 0 && row.cancelled_net_cents !== 0)) {
      throw new RangeError("Inconsistent sales amounts");
    }
    if (units > 0) orders.add(row.order_id);
    return { gmv, net: gmv - row.refund_cents, units };
  });
  const gmvCents = sum(values.map(value => value.gmv));
  return {
    gmvCents,
    netSalesCents: sum(values.map(value => value.net)),
    orders: orders.size,
    units: sum(values.map(value => value.units)),
    aovCents: safeRatio(gmvCents, orders.size)
  };
}

export function summarizeAdvertising(rows) {
  uniqueRows(rows, ["date", "campaign_id"]);
  for (const row of rows) {
    for (const key of ["impressions", "clicks", "spend_cents",
      "attributed_orders", "attributed_sales_cents"]) {
      nonnegativeInteger(row[key], key);
    }
    if (row.clicks > row.impressions) throw new RangeError("Clicks exceed impressions");
  }
  const total = key => sum(rows.map(row => row[key]));
  const spendCents = total("spend_cents");
  const attributedSalesCents = total("attributed_sales_cents");
  const impressions = total("impressions");
  const clicks = total("clicks");
  const attributedOrders = total("attributed_orders");
  return {
    spendCents, attributedSalesCents, impressions, clicks, attributedOrders,
    acos: safeRatio(spendCents, attributedSalesCents),
    roas: safeRatio(attributedSalesCents, spendCents),
    ctr: safeRatio(clicks, impressions),
    cpcCents: safeRatio(spendCents, clicks),
    cvr: safeRatio(attributedOrders, clicks)
  };
}

export function targetProgress(actual, target) {
  nonnegativeInteger(actual, "actual");
  if (target === null) return { target: null, delta: null, shortfall: null, completion: null };
  nonnegativeInteger(target, "target");
  return {
    target,
    delta: actual - target,
    shortfall: Math.max(target - actual, 0),
    completion: safeRatio(actual, target)
  };
}

// Sales/ads must have the same chosen SKU scope and a deliberately selected
// date window. The caller must label mismatched attribution date bases in UI.
export function calculateOverview(sales, ads, plan) {
  nonnegativeInteger(sales.gmvCents, "gmvCents");
  nonnegativeInteger(ads.spendCents, "spendCents");
  const { periodBudgetCents, elapsedBudgetCents, elapsedGmvTargetCents } = plan;
  for (const [key, value] of Object.entries({ periodBudgetCents, elapsedBudgetCents, elapsedGmvTargetCents })) {
    if (value !== null) nonnegativeInteger(value, key);
  }
  if (periodBudgetCents !== null && elapsedBudgetCents !== null &&
      elapsedBudgetCents > periodBudgetCents) {
    throw new RangeError("Elapsed budget exceeds period plan");
  }
  return {
    tacos: safeRatio(ads.spendCents, sales.gmvCents),
    adSalesShare: safeRatio(ads.attributedSalesCents, sales.gmvCents),
    budgetConsumption: periodBudgetCents === null ? null : safeRatio(ads.spendCents, periodBudgetCents),
    budgetRemainingCents: periodBudgetCents === null ? null : periodBudgetCents - ads.spendCents,
    spendPace: elapsedBudgetCents === null ? null : safeRatio(ads.spendCents, elapsedBudgetCents),
    gmvProgress: targetProgress(sales.gmvCents, elapsedGmvTargetCents)
  };
}
