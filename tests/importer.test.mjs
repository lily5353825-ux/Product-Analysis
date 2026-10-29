import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTables, importWorkbook, parseNumericCell } from '../src/web/importer.js';

function fixture() {
  const orderHeader = ['PO#', 'Order#', 'Order Date', 'GTIN/UPC', 'Status', 'Qty', 'CON-SKU', 'Item Cost', 'Discount', 'Shipping Cost', 'Fulfillment Entity', '销售额'];
  const adHeader = [];
  for (const [column, name] of [[14, 'Date'], [15, 'Campaign Name'], [16, 'Campaign Id'], [21, 'Ad Group Id'], [22, 'Item Id'], [23, 'SKU Id'], [27, 'Impressions'], [28, 'Clicks'], [36, 'Ad Spend'], [37, 'Orders'], [39, 'Total Attributed Sales'], [40, 'Advertised SKU Sales'], [41, 'Other SKU Sales']]) adHeader[column] = name;
  const ad = [];
  for (const [column, value] of [[14, '2026-10-20'], [15, 'Synthetic campaign'], [16, '001'], [21, '009'], [22, '0100'], [23, 'S106'], [27, 100], [28, 2], [36, 2.21], [37, 1], [39, 200], [40, 180], [41, 20]]) ad[column] = value;
  return {
    'SKU数据': [['SKU', 'Item ID', 'Product Name', '', '', '', '', 'Price', 'Currency'], ['S106', '0100', 'Sofa 106" Grey', '', '', '', '', 200, 'USD'], ['S79', '0200', 'Sofa bed 79" Blue', '', '', '', '', 100, 'USD'], ['FOOT', '0300', 'Footstool', '', '', '', '', 50, 'USD']],
    '订单': [orderHeader, ['p1', '00001', '2026-10-20', '', 'Shipped', 1, 'S106', 'New', 200.10, 10, 69.99, 999999], ['p2', '00002', '2026-10-21', '', 'Delivered', 1, 'S79', 'New', 100, 0, 0, 100], ['p3', '00003', '2026-10-19', '', 'Delivered', 1, 'FOOT', 'New', 50, 0, 0]],
    'Item Data ': [adHeader, ad]
  };
}

test('groups all variants, excludes footstool, retains text IDs, computes GMV without shipping', () => {
  const result = normalizeTables(fixture(), { sourceName: 'synthetic.xlsx', importedAt: '2026-10-22T00:00:00Z' });
  assert.equal(result.version, 1);
  assert.equal(result.sourceName, 'synthetic.xlsx');
  assert.deepEqual(result.products.map(p => p.groupId), ['sofa106', 'sofa79']);
  assert.equal(result.orders.length, 2);
  assert.equal(result.orders[0].orderId, '00001');
  assert.equal(result.orders[0].itemSubtotalCents, 20010);
  assert.equal(result.orders[0].discountCents, 1000);
  assert.equal(result.orders[0].shippingCents, 6999);
  assert.equal(result.orders[0].gmvCents, 19010);
  assert.equal(result.ads[0].campaignId, '001');
  assert.equal(result.ads[0].itemId, '0100');
  assert.equal(result.ads[0].spendCents, 221);
  assert.deepEqual(result.coverage, { salesStart: '2026-10-20', salesEnd: '2026-10-21', adsStart: '2026-10-20', adsEnd: '2026-10-20' });
  assert.ok(result.warnings.some(w => w.includes('退款')));
});

test('same campaign can contain multiple items; no sales read from repeated ad helper columns', () => {
  const tables = fixture(), ad = [...tables['Item Data '][1]];
  ad[22] = '0200'; ad[23] = 'S79'; ad[1] = 999; ad[2] = 9999999;
  tables['Item Data '].push(ad);
  const result = normalizeTables(tables);
  assert.equal(result.ads.length, 2);
  assert.equal(result.orders.reduce((sum, row) => sum + row.gmvCents, 0), 29010);
});

test('rejects duplicate order+SKU and duplicate full advertising key', () => {
  let tables = fixture(); tables['订单'].push([...tables['订单'][1]]);
  assert.throws(() => normalizeTables(tables), /订单编号与 SKU 重复/);
  tables = fixture(); tables['Item Data '].push([...tables['Item Data '][1]]);
  assert.throws(() => normalizeTables(tables), /广告日期.*重复/);
});

test('requires consistent dates for one order across SKU lines', () => {
  const tables = fixture();
  tables['订单'][2][1] = tables['订单'][1][1];
  assert.throws(() => normalizeTables(tables), /同一订单编号跨 SKU 的日期不一致/);
  tables['订单'][2][2] = tables['订单'][1][2];
  assert.equal(normalizeTables(tables).orders.length, 2);
});

test('ignores formula-only tail rows outside raw input columns', () => {
  const tables = fixture(), order = [], ad = [];
  order[11] = '#VALUE!'; order[12] = '#N/A';
  ad[0] = '10月'; ad[2] = '#DIV/0!'; ad[60] = 0;
  tables['订单'].push(order); tables['Item Data '].push(ad);
  const result = normalizeTables(tables);
  assert.equal(result.orders.length, 2); assert.equal(result.ads.length, 1);
});

test('converts Excel serial days using UTC and validates calendar dates', () => {
  const tables = fixture();
  tables['订单'][1][2] = (Date.UTC(2026, 9, 20) - Date.UTC(1899, 11, 30)) / 86400000 + 0.75;
  assert.equal(normalizeTables(tables).orders[0].date, '2026-10-20');
  tables['订单'][1][2] = '2026-02-30';
  assert.throws(() => normalizeTables(tables), /有效日期/);
});

test('requires quantity discount/shipping semantics before accepting multi-unit rows', () => {
  const tables = fixture(); tables['订单'][1][5] = 2;
  assert.throws(() => normalizeTables(tables), /每件\/每行/);
  tables['订单'][1][9] = 0; tables['订单'][1][10] = 0;
  assert.equal(normalizeTables(tables).orders[0].gmvCents, 40020);
});

test('rejects unknown product mappings, conflicts and currencies', () => {
  let tables = fixture(); tables['订单'][1][6] = 'MISSING';
  assert.throws(() => normalizeTables(tables), /未在 SKU数据中找到/);
  tables = fixture(); tables['Item Data '][1][23] = 'S79';
  assert.throws(() => normalizeTables(tables), /映射冲突/);
  tables = fixture(); tables['SKU数据'][1][8] = 'CNY';
  assert.throws(() => normalizeTables(tables), /币种应为 USD/);
});

test('rejects missing money, formula errors, fractional cents and negative discount', () => {
  for (const value of [null, '#VALUE!', 1.001, -10]) {
    const tables = fixture(); tables['订单'][1][9] = value;
    assert.throws(() => normalizeTables(tables));
  }
  const tables = fixture(); tables['Item Data '][1][36] = 2.210000000000001;
  assert.equal(normalizeTables(tables).ads[0].spendCents, 221);
});

test('cancelled orders retain audit amounts with zero GMV; unknown status blocks', () => {
  const tables = fixture(); tables['订单'][1][4] = 'Cancelled';
  const order = normalizeTables(tables).orders[0];
  assert.equal(order.gmvCents, 0); assert.equal(order.itemSubtotalCents, 20010);
  tables['订单'][1][4] = 'Returned';
  assert.throws(() => normalizeTables(tables), /状态.*未映射/);
});

test('protects against changed layouts and unsafe numeric identifiers', () => {
  let tables = fixture(); tables['订单'][0][8] = 'Order Tax';
  assert.throws(() => normalizeTables(tables), /I\/J\/K/);
  tables = fixture(); tables['订单'][1][1] = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => normalizeTables(tables), /安全的整数标识/);
  tables = fixture(); tables['订单'][1][1] = '1e16';
  assert.throws(() => normalizeTables(tables), /格式不可靠/);
  tables = fixture(); tables['订单'][1][1] = 1234567890123456;
  assert.throws(() => normalizeTables(tables), /最多 15 位/);
  tables['订单'][1][1] = '12345678901234567890';
  assert.equal(normalizeTables(tables).orders[0].orderId, '12345678901234567890');
});

test('rejects inconsistent advertising impressions and sales components', () => {
  const tables = fixture();
  tables['Item Data '][1][28] = 101;
  assert.throws(() => normalizeTables(tables), /点击大于曝光/);
  tables['Item Data '][1][28] = 2;
  tables['Item Data '][1][39] = 199.99;
  assert.throws(() => normalizeTables(tables), /归因销售额不等于/);
});

test('rejects non-ZIP input and oversized files before XML parsing', async () => {
  await assert.rejects(importWorkbook(new File(['plain text'], 'bad.xlsx')), /有效的 XLSX/);
  await assert.rejects(importWorkbook({ size: 65 * 1024 * 1024, arrayBuffer() { throw new Error('should not read'); } }), /64 MB/);
});

test('XML numeric cell boundary preserves type and rejects rounded long IDs downstream', () => {
  assert.equal(typeof parseNumericCell('200015446336394'), 'number');
  assert.equal(parseNumericCell('2.21'), 2.21);
  assert.equal(parseNumericCell(null), null);
  assert.equal(parseNumericCell(''), null);
  assert.equal(parseNumericCell('  '), null);
  assert.throws(() => parseNumericCell('NaN'), /格式无效/);
  const tables = fixture();
  tables['订单'][1][9] = parseNumericCell('');
  assert.throws(() => normalizeTables(tables), /缺失或不是数字/);
  tables['订单'][1][9] = 10;
  for (const raw of ['1234567890123456', '12345678901234567890', '1.234567890123456e16']) {
    tables['订单'][1][1] = parseNumericCell(raw);
    assert.throws(() => normalizeTables(tables), /安全的整数标识/);
  }
});

function storedZipWithBadChecksum(advertisedSize) {
  const name = new TextEncoder().encode('xl/workbook.xml'), payload = new TextEncoder().encode('<workbook/>');
  const localSize = 30 + name.length + payload.length, centralSize = 46 + name.length;
  const bytes = new Uint8Array(localSize + centralSize + 22), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true); view.setUint32(18, payload.length, true); view.setUint32(22, payload.length, true); view.setUint16(26, name.length, true);
  bytes.set(name, 30); bytes.set(payload, 30 + name.length);
  view.setUint32(localSize, 0x02014b50, true); view.setUint32(localSize + 20, payload.length, true); view.setUint32(localSize + 24, advertisedSize ?? payload.length, true); view.setUint16(localSize + 28, name.length, true); bytes.set(name, localSize + 46);
  const end = localSize + centralSize;
  view.setUint32(end, 0x06054b50, true); view.setUint16(end + 8, 1, true); view.setUint16(end + 10, 1, true); view.setUint32(end + 12, centralSize, true); view.setUint32(end + 16, localSize, true);
  return new File([bytes], 'synthetic-invalid.xlsx');
}

test('rejects oversized ZIP entry declarations and corrupt CRC before XML parsing', async () => {
  await assert.rejects(importWorkbook(storedZipWithBadChecksum(33 * 1024 * 1024)), /解压数据过大/);
  await assert.rejects(importWorkbook(storedZipWithBadChecksum()), /数据校验失败/);
});
