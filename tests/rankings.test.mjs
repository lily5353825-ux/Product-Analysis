import test from 'node:test';
import assert from 'node:assert/strict';
import { importRankings, normalizeRankRows, mergeRankings, rankingSnapshot } from '../src/web/rankings.js';

const header = ['日期', 'SKU', 'Item ID', '商品名称', '产品类别', '商品类型', '商品状态', '曝光排名', '点击排名', '加购排名', '销售排名'];
function rows() {
  return [[...header], ['2026-10-28', 'S106-A', '00100', 'Grey sofa', '106英寸组合沙发', 'Sectional Sofas', '', 20, 15, '', 10], ['2026-10-28', 'S79-B', '', '', 'sofa79', 'Sofa Beds', 'New', 30, '', 16, '']];
}
function record(overrides = {}) {
  return { date: '2026-10-28', sku: 'S106-A', itemId: '00100', name: 'Grey sofa', groupId: 'sofa106', productType: 'Sectional Sofas', condition: 'New', impressionsRank: 20, clicksRank: 15, cartRank: null, salesRank: 10, ...overrides };
}
const csvField = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const csv = data => data.map(row => row.map(csvField).join(',')).join('\r\n');

test('normalizes template columns, group aliases, optional metadata and empty ranks', () => {
  const normalized = normalizeRankRows(rows());
  assert.deepEqual(normalized[0], record({ condition: '' }));
  assert.equal(normalized[1].groupId, 'sofa79');
  assert.equal(normalized[1].itemId, '');
  assert.equal(normalized[1].salesRank, null);
  assert.equal(normalized[0].condition, '');
  assert.equal(normalized[1].condition, 'New');
});

test('supports reordered headers with BOM, ignores fully blank rows', () => {
  const data = rows().map(row => [...row].reverse());
  data[0][0] = '\uFEFF' + data[0][0];
  data.push([]);
  assert.deepEqual(normalizeRankRows(data), normalizeRankRows(rows()));
});

test('validates template headers and required record fields', () => {
  for (const mutate of [data => data[0].pop(), data => data[0].push('SKU'), data => data[1][0] = '', data => data[1][1] = '', data => data[1][4] = 'Unknown', data => data[1][5] = '']) {
    const data = rows(); mutate(data);
    assert.throws(() => normalizeRankRows(data));
  }
  assert.throws(() => normalizeRankRows([header]), /没有可导入/);
});

test('validates calendar dates and converts numeric Excel dates in UTC', () => {
  const data = rows();
  data[1][0] = (Date.UTC(2026, 9, 28) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.equal(normalizeRankRows(data)[0].date, '2026-10-28');
  for (const invalid of ['2026-02-29', '2026-10-32', '2026-1-1', '10/28/2026', 60, 46323.5]) {
    data[1][0] = invalid;
    assert.throws(() => normalizeRankRows(data));
  }
});

test('rank values must be positive safe integers or blank, with at least one rank', () => {
  for (const value of [0, -1, 1.1, '1.1', '#VALUE!', '=SUM(A1:A2)', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const data = rows(); data[1][7] = value;
    assert.throws(() => normalizeRankRows(data), /正整数/);
  }
  const data = rows(); data[1].splice(7, 4, null, '', undefined, ' ');
  assert.throws(() => normalizeRankRows(data), /至少填写一项/);
});

test('rejects unsafe numeric or scientific IDs, preserves text and leading zeros', () => {
  for (const value of [1234567890123456, Number.MAX_SAFE_INTEGER + 1, 1.5, '1.234e16']) {
    const data = rows(); data[1][2] = value;
    assert.throws(() => normalizeRankRows(data), /ID/);
  }
  const data = rows(); data[1][2] = '12345678901234567890';
  assert.equal(normalizeRankRows(data)[0].itemId, '12345678901234567890');
});

test('rejects same-file duplicate date/SKU and inconsistent SKU categories across dates', () => {
  const data = rows(); data.push([...data[1]]);
  assert.throws(() => normalizeRankRows(data), /重复/);
  data[3][0] = '2026-10-27'; data[3][4] = 'sofa79';
  assert.throws(() => normalizeRankRows(data), /矛盾/);
});

test('imports UTF-8 BOM CSV with quoted commas, escaped quotes, embedded newlines and CRLF', async () => {
  const data = rows(); data[1][3] = 'Grey, "cloud"\nsofa';
  const result = await importRankings(new File(['\uFEFF', csv(data), '\r\n'], 'ranking.CSV'));
  assert.equal(result[0].name, 'Grey, "cloud"\nsofa');
  assert.equal(result[0].itemId, '00100');
  const simple = header.join(',') + '\n2026-10-28,S106-A,,,sofa106,Sectional Sofas,,20,15,,10';
  assert.equal((await importRankings(new File([simple], 'ranking.csv')))[0].salesRank, 10);
});

test('rejects malformed CSV quotes and invalid UTF-8 without accepting partial records', async () => {
  for (const source of ['a,"unclosed', 'ab"cd",ef', '"abc"x,ef']) {
    await assert.rejects(importRankings(new File([source], 'ranking.csv')), /CSV 引号/);
  }
  await assert.rejects(importRankings(new File([new Uint8Array([0xc3, 0x28])], 'ranking.csv')), /UTF-8/);
  await assert.rejects(importRankings(new File(['data'], 'ranking.xls')), /仅支持/);
});

test('merge overwrites same-day SKU while keeping all other historical records and input immutable', () => {
  const old = [record({ date: '2026-10-27', salesRank: 20 }), record(), record({ sku: 'S106-B', salesRank: 5 })];
  const next = [record({ salesRank: 7 }), record({ date: '2026-10-29', salesRank: 2 })];
  const oldCopy = structuredClone(old), nextCopy = structuredClone(next);
  const merged = mergeRankings(old, next);
  assert.equal(merged.length, 4);
  assert.equal(merged.find(row => row.date === '2026-10-28' && row.sku === 'S106-A').salesRank, 7);
  assert.equal(merged.find(row => row.date === '2026-10-27').salesRank, 20);
  assert.deepEqual(old, oldCopy); assert.deepEqual(next, nextCopy);
  merged[0].name = 'changed'; assert.deepEqual(old, oldCopy);
});

test('merge rejects conflicting historic categories including same-key replacement and duplicate incoming', () => {
  assert.throws(() => mergeRankings([record()], [record({ groupId: 'sofa79' })]), /矛盾/);
  assert.throws(() => mergeRankings([record()], [record({ date: '2026-10-29', groupId: 'sofa79' })]), /矛盾/);
  assert.throws(() => mergeRankings([], [record(), record()]), /重复/);
  assert.deepEqual(mergeRankings([], []), []);
});

test('snapshot uses exact date only; same SKU nearest earlier matching product type defines changes', () => {
  const history = [record({ date: '2026-10-25', salesRank: 30 }), record({ date: '2026-10-27', productType: 'Other Type', salesRank: 1 }), record({ date: '2026-10-24', salesRank: 40 }), record(), record({ date: '2026-10-29', salesRank: 1 })];
  const snapshot = rankingSnapshot(history, { date: '2026-10-28' });
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].previousDate, '2026-10-25');
  assert.equal(snapshot[0].changes.salesRank, 20);
  assert.equal(snapshot[0].changes.cartRank, null);
  assert.deepEqual(rankingSnapshot(history, { date: '2026-10-26' }), []);
  assert.equal(rankingSnapshot(history, { date: '2026-10-24' })[0].previousDate, null);
});

test('missing previous rank does not search older values; worsening change is negative', () => {
  const history = [record({ date: '2026-10-24', clicksRank: 50 }), record({ date: '2026-10-27', clicksRank: null, salesRank: 5 }), record()];
  const snapshot = rankingSnapshot(history, { date: '2026-10-28' });
  assert.equal(snapshot[0].previousDate, '2026-10-27');
  assert.equal(snapshot[0].changes.clicksRank, null);
  assert.equal(snapshot[0].changes.salesRank, -5);
});

test('snapshot filters categories and sorts rank ascending with null last and SKU tie-breaker', () => {
  const history = [record({ sku: 'B', salesRank: 1 }), record({ sku: 'A', salesRank: 1 }), record({ sku: 'Z', salesRank: null }), record({ sku: 'C', groupId: 'sofa79', salesRank: 2 })];
  assert.deepEqual(rankingSnapshot(history, { date: '2026-10-28' }).map(row => row.sku), ['A', 'B', 'C', 'Z']);
  assert.deepEqual(rankingSnapshot(history, { date: '2026-10-28', groupId: 'sofa79' }).map(row => row.sku), ['C']);
  assert.deepEqual(rankingSnapshot(history, { date: '2026-10-28', sortBy: 'clicksRank' }).map(row => row.sku), ['A', 'B', 'C', 'Z']);
  assert.throws(() => rankingSnapshot(history, { date: '2026-10-28', sortBy: 'name' }), /排序字段/);
});

test('snapshot does not mutate input and rejects conflicting persisted history', () => {
  const history = [record({ date: '2026-10-27' }), record()], copy = structuredClone(history);
  const snapshot = rankingSnapshot(history, { date: '2026-10-28' });
  snapshot[0].salesRank = 99; snapshot[0].changes.salesRank = 99;
  assert.deepEqual(history, copy);
  assert.throws(() => rankingSnapshot([record(), record({ date: '2026-10-27', groupId: 'sofa79' })], { date: '2026-10-28' }), /矛盾/);
});
