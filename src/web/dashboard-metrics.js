export const GROUPS = { sofa106: '106 英寸组合沙发', sofa79: '79 英寸沙发床' };
const DAY = 86400000;
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function dayCount(start, end) {
  if (!validDate(start) || !validDate(end) || start > end) throw new Error('请选择有效的起止日期。');
  return Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
}
export function datesBetween(start, end) {
  const count = dayCount(start, end);
  if (count > 3660) throw new Error('一次最多查看 10 年数据。');
  return Array.from({ length: count }, (_, i) => new Date(Date.parse(start) + i * DAY).toISOString().slice(0, 10));
}
export const divide = (a, b) => b > 0 ? a / b : null;
const active = row => !/cancel|取消/i.test(row.status ?? '');
const sum = (rows, key) => rows.reduce((acc, row) => { const result = acc + row[key]; if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) throw new Error(`${key} 汇总数值超出安全范围。`); return result; }, 0);

/** Validate files before any aggregation. Missing numeric values are errors, never zero. */
export function validateDataset(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.orders) || !Array.isArray(input.ads) || !Array.isArray(input.products)) throw new Error('数据格式不正确：需要 version: 1，以及 products、orders、ads 数组。');
  if (input.orders.length + input.ads.length > 300000) throw new Error('数据超过 30 万行，请按时间拆分文件。');
  const checkString = (row, key, label, optional = false) => {
    if (optional && (row[key] == null || row[key] === '')) return;
    if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > 2000) throw new Error(`${label} 的 ${key} 缺失或格式错误。`);
  };
  const checkNumber = (row, key, label, integer = true) => {
    if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(row[key]))) throw new Error(`${label} 的 ${key} 必须是有效的非负${integer ? '整数' : '数值'}，不能留空。`);
  };
  const checkGroup = (row, label) => { if (!Object.hasOwn(GROUPS, row.groupId)) throw new Error(`${label} 的产品类别无效。`); };
  const lineKeys = new Set(), skuMap = new Map(), itemIds = new Set(), adKeys = new Set(), orderDates = new Map();
  for (const [i, row] of input.products.entries()) {
    const label = `商品第 ${i + 1} 行`;
    if (!row || typeof row !== 'object') throw new Error(`${label} 无效。`);
    checkGroup(row, label); checkString(row, 'sku', label); checkString(row, 'itemId', label);
    if (row.currency !== 'USD') throw new Error(`${label} 币种必须为 USD。`);
    if (skuMap.has(row.sku) || itemIds.has(row.itemId)) throw new Error(`${label} 的 SKU 或 Item ID 重复。`);
    skuMap.set(row.sku, row); itemIds.add(row.itemId);
  }
  for (const [i, row] of input.orders.entries()) {
    const label = `订单第 ${i + 1} 行`;
    if (!row || typeof row !== 'object') throw new Error(`${label} 无效。`);
    checkGroup(row, label);
    if (!validDate(row.date)) throw new Error(`${label} 的日期无效。`);
    for (const k of ['orderId', 'lineId', 'sku']) checkString(row, k, label);
    if (orderDates.has(row.orderId) && orderDates.get(row.orderId) !== row.date) throw new Error(`${label} 与同一订单编号的其他行日期不一致。`);
    orderDates.set(row.orderId, row.date);
    for (const k of ['quantity', 'itemSubtotalCents', 'discountCents', 'shippingCents', 'gmvCents']) checkNumber(row, k, label);
    if (!skuMap.has(row.sku) || skuMap.get(row.sku).groupId !== row.groupId) throw new Error(`${label} 的 SKU 与产品资料不一致。`);
    if (typeof row.status !== 'string' || !/^(created|acknowledged|shipped|delivered|cancelled|canceled)$/i.test(row.status)) throw new Error(`${label} 的状态缺失或尚未映射。`);
    if (row.quantity <= 0 || row.discountCents > row.itemSubtotalCents) throw new Error(`${label} 的数量或折扣无效。`);
    const expectedGMV = active(row) ? row.itemSubtotalCents - row.discountCents : 0;
    if (row.gmvCents !== expectedGMV) throw new Error(`${label} 的 GMV 与商品金额减折扣不一致。`);
    const key = JSON.stringify([row.orderId, row.lineId]);
    if (lineKeys.has(key)) throw new Error(`${label} 出现重复订单行，请先去重。`);
    lineKeys.add(key);
  }
  for (const [i, row] of input.ads.entries()) {
    const label = `广告第 ${i + 1} 行`;
    if (!row || typeof row !== 'object') throw new Error(`${label} 无效。`);
    checkGroup(row, label);
    if (!validDate(row.date)) throw new Error(`${label} 的日期无效。`);
    for (const k of ['sku', 'campaignId', 'itemId', 'adGroupId']) checkString(row, k, label);
    checkString(row, 'campaignName', label, true);
    for (const k of ['impressions', 'clicks', 'spendCents', 'attributedSalesCents', 'directSalesCents', 'otherSalesCents']) checkNumber(row, k, label);
    checkNumber(row, 'attributedOrders', label, false);
    if (!skuMap.has(row.sku) || skuMap.get(row.sku).groupId !== row.groupId || skuMap.get(row.sku).itemId !== row.itemId) throw new Error(`${label} 的 SKU、类别或 Item ID 与产品资料不一致。`);
    if (row.clicks > row.impressions) throw new Error(`${label} 的点击不能多于曝光。`);
    if (row.attributedSalesCents !== row.directSalesCents + row.otherSalesCents) throw new Error(`${label} 的总归因销售额不等于直接商品与其他商品销售额之和。`);
    const key = JSON.stringify([row.date, row.campaignId, row.adGroupId, row.itemId]);
    if (adKeys.has(key)) throw new Error(`${label} 出现重复广告日期、活动、广告组与商品。`);
    adKeys.add(key);
  }
  for (const key of ['quantity', 'itemSubtotalCents', 'discountCents', 'shippingCents', 'gmvCents']) sum(input.orders, key);
  for (const key of ['impressions', 'clicks', 'spendCents', 'attributedOrders', 'attributedSalesCents', 'directSalesCents', 'otherSalesCents']) sum(input.ads, key);
  const bounds = (rows) => {
    let start = null, end = null;
    for (const row of rows) { if (!start || row.date < start) start = row.date; if (!end || row.date > end) end = row.date; }
    return [start, end];
  };
  const [salesStart, salesEnd] = bounds(input.orders);
  const [adsStart, adsEnd] = bounds(input.ads);
  return { ...input, sourceName: typeof input.sourceName === 'string' ? input.sourceName.slice(0, 500) : '导入数据', importedAt: new Date().toISOString(), coverage: { salesStart, salesEnd, adsStart, adsEnd }, warnings: Array.isArray(input.warnings) ? input.warnings.filter(x => typeof x === 'string').slice(0, 200) : [] };
}

export function defaultWindow(data) {
  const c = data.coverage;
  if (c.salesStart && c.adsStart) {
    const start = c.salesStart > c.adsStart ? c.salesStart : c.adsStart;
    const end = c.salesEnd < c.adsEnd ? c.salesEnd : c.adsEnd;
    if (start <= end) return { start, end, overlap: true };
  }
  return { start: c.salesStart ?? c.adsStart, end: c.salesEnd ?? c.adsEnd, overlap: false };
}

export function computeMetrics(data, { start, end, groupId = 'all', dailyTarget = 2 }) {
  const days = datesBetween(start, end);
  if (!Number.isInteger(dailyTarget) || dailyTarget < 0 || dailyTarget > 10000) throw new Error('每日订单目标应为 0–10,000 之间的整数。');
  if (groupId !== 'all' && !Object.hasOwn(GROUPS, groupId)) throw new Error('请选择有效产品类别。');
  const groups = groupId === 'all' ? Object.keys(GROUPS) : [groupId];
  const inWindow = row => row.date >= start && row.date <= end && groups.includes(row.groupId);
  const salesRecords = data.orders.filter(inWindow);
  const orders = salesRecords.filter(active);
  const ads = data.ads.filter(inWindow);
  const aggregate = (orderRows, adRows) => {
    const gmv = sum(orderRows, 'gmvCents');
    const spend = sum(adRows, 'spendCents');
    const directSales = sum(adRows, 'directSalesCents');
    return { orders: new Set(orderRows.map(r => r.orderId)).size, units: sum(orderRows, 'quantity'), gmv, shipping: sum(orderRows, 'shippingCents'), spend, directSales, attributedSales: sum(adRows, 'attributedSalesCents'), attributedOrders: sum(adRows, 'attributedOrders'), clicks: sum(adRows, 'clicks'), impressions: sum(adRows, 'impressions'), acos: divide(spend, directSales), roas: divide(directSales, spend), tacos: divide(spend, gmv), ctr: divide(sum(adRows, 'clicks'), sum(adRows, 'impressions')), cpc: divide(spend, sum(adRows, 'clicks')), hasSales: orderRows.length > 0, hasAds: adRows.length > 0 };
  };
  const totals = aggregate(orders, ads);
  const target = days.length * dailyTarget * groups.length;
  const comparisons = groups.map(id => ({ groupId: id, ...aggregate(orders.filter(r => r.groupId === id), ads.filter(r => r.groupId === id)), hasSalesRecords: salesRecords.some(r => r.groupId === id), target: days.length * dailyTarget }));
  const targetOrderCount = comparisons.reduce((total, row) => total + row.orders, 0);
  const series = days.map(date => ({ date, ...aggregate(orders.filter(r => r.date === date), ads.filter(r => r.date === date)), hasSalesRecords: salesRecords.some(r => r.date === date), targetOrderCount: groups.reduce((total, id) => total + new Set(orders.filter(r => r.date === date && r.groupId === id).map(r => r.orderId)).size, 0), target: dailyTarget * groups.length }));
  const campaignMap = new Map();
  for (const row of ads) {
    const key = JSON.stringify([row.campaignId, row.groupId, row.sku]);
    if (!campaignMap.has(key)) campaignMap.set(key, { ...row, rows: [] });
    campaignMap.get(key).rows.push(row);
  }
  const campaigns = [...campaignMap.values()].map(({ rows, ...row }) => ({ ...row, ...aggregate([], rows) })).sort((a, b) => b.spend - a.spend);
  const comparable = groups.every(id => {
    const sales = data.orders.filter(r => r.groupId === id).map(r => r.date).sort();
    const advertising = data.ads.filter(r => r.groupId === id).map(r => r.date).sort();
    return sales.length && advertising.length && start >= sales[0] && end <= sales.at(-1) && start >= advertising[0] && end <= advertising.at(-1);
  });
  return { ...totals, target, targetOrderCount, days: days.length, progress: divide(targetOrderCount, target), gap: targetOrderCount - target, comparisons, series, campaigns, comparable: Boolean(comparable), hasSalesRecords: salesRecords.length > 0, salesRecordDays: new Set(salesRecords.map(r => r.date)).size, adRecordDays: new Set(ads.map(r => r.date)).size, cancelledRows: salesRecords.length - orders.length };
}
