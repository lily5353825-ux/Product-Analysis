import { readWorkbookTables } from './importer.js';

const HEADERS = ['日期', 'SKU', 'Item ID', '商品名称', '产品类别', '商品类型', '商品状态', '曝光排名', '点击排名', '加购排名', '销售排名'];
const RANKS = ['impressionsRank', 'clicksRank', 'cartRank', 'salesRank'];
const GROUPS = new Map([['106英寸组合沙发', 'sofa106'], ['79英寸沙发床', 'sofa79'], ['sofa106', 'sofa106'], ['sofa79', 'sofa79']]);
const text = value => value == null ? '' : String(value).trim();
const fail = message => { throw new Error(message); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function identifier(value, label, optional = false) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || Math.abs(value) >= 1e15 || value < 0)) fail(`${label}数值 ID 不可靠，请将 ID 以文本格式保存。`);
  const result = text(value);
  if (!result && optional) return '';
  if (!result || /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(result) || result.startsWith('#')) fail(`${label}缺失或 ID 格式不可靠。`);
  return result;
}

function day(value, label) {
  let result = text(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 61 || value > 2958465) fail(`${label}必须是有效的整天日期。`);
    result = new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) fail(`${label}应为 YYYY-MM-DD 或 Excel 日期。`);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== result) fail(`${label}不是有效日期。`);
  return result;
}

function rank(value, label) {
  if (text(value) === '') return null;
  if ((typeof value !== 'number' && !/^\d+$/.test(text(value))) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) fail(`${label}应为正整数，未知排名请留空。`);
  return Number(value);
}

function validateRecord(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail(`${label}记录格式错误。`);
  const groupId = GROUPS.get(text(record.groupId));
  if (!groupId) fail(`${label}产品类别仅支持 106英寸组合沙发 或 79英寸沙发床。`);
  const productType = text(record.productType);
  if (!productType) fail(`${label}商品类型必填，排名变化需要相同类型才能比较。`);
  const normalized = {
    date: day(record.date, `${label}日期`), sku: identifier(record.sku, `${label} SKU`),
    itemId: identifier(record.itemId, `${label} Item ID`, true), name: text(record.name), groupId,
    productType, condition: text(record.condition)
  };
  for (const field of RANKS) normalized[field] = rank(record[field], `${label} ${HEADERS[7 + RANKS.indexOf(field)]}`);
  if (RANKS.every(field => normalized[field] === null)) fail(`${label}至少填写一项排名。`);
  return normalized;
}

function validateRecords(records, label) {
  if (!Array.isArray(records) || records.length > 200000) fail(`${label}应为最多 200000 行的排名记录。`);
  const keys = new Set(), groups = new Map();
  return records.map((record, index) => {
    const normalized = validateRecord(record, `${label}第 ${index + 1} 条`);
    const key = JSON.stringify([normalized.date, normalized.sku]);
    if (keys.has(key)) fail(`${label}同一日期与 SKU 重复，请先去重。`);
    keys.add(key);
    if (groups.has(normalized.sku) && groups.get(normalized.sku) !== normalized.groupId) fail(`${label}同一 SKU 的产品类别与历史记录矛盾。`);
    groups.set(normalized.sku, normalized.groupId);
    return normalized;
  });
}

/** Normalize a matrix with the documented Chinese header row. Column order may vary. */
export function normalizeRankRows(rows) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) fail('排名表缺少表头。');
  if (rows.length > 200001) fail('排名表超过 200000 行限制。');
  const header = rows[0].map(value => text(value).replace(/^\uFEFF/, '').toLowerCase());
  const columns = HEADERS.map(name => {
    const matches = header.flatMap((value, index) => value === name.toLowerCase() ? [index] : []);
    if (matches.length !== 1) fail(`排名表头 ${name} 缺失或重复，请使用排名模板。`);
    return matches[0];
  });
  const records = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index] || [];
    if (!Array.isArray(row)) fail(`排名表第 ${index + 1} 行格式错误。`);
    if (row.every(value => text(value) === '')) continue;
    const values = columns.map(column => row[column]);
    records.push(validateRecord({ date: values[0], sku: values[1], itemId: values[2], name: values[3], groupId: values[4], productType: values[5], condition: values[6], ...Object.fromEntries(RANKS.map((field, n) => [field, values[n + 7]])) }, `排名表第 ${index + 1} 行`));
  }
  if (!records.length) fail('排名表没有可导入的记录。');
  return validateRecords(records, '排名表');
}

/** Strict RFC-style CSV handling: quoted commas, escaped quotes and embedded newlines. */
function csvRows(source) {
  const rows = [], row = [];
  let value = '', quoted = false, afterQuote = false;
  source = source.replace(/^\uFEFF/, '');
  const field = () => { row.push(value); value = ''; afterQuote = false; };
  const line = () => { field(); rows.push(row.splice(0)); if (rows.length > 200001) fail('排名表超过 200000 行限制。'); };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { value += '"'; index++; }
        else { quoted = false; afterQuote = true; }
      } else value += char;
    } else if (char === ',') field();
    else if (char === '\r' || char === '\n') { line(); if (char === '\r' && source[index + 1] === '\n') index++; }
    else if (char === '"') {
      if (value || afterQuote) fail('CSV 引号位置错误，请重新导出 UTF-8 CSV。');
      quoted = true;
    } else {
      if (afterQuote) fail('CSV 引号后存在无效字符，请重新导出 UTF-8 CSV。');
      value += char;
    }
  }
  if (quoted) fail('CSV 引号未闭合，请重新导出 UTF-8 CSV。');
  if (value !== '' || row.length || afterQuote) line();
  return rows;
}

export async function importRankings(file) {
  if (!file || typeof file.arrayBuffer !== 'function') fail('请选择 CSV 或 XLSX 排名文件。');
  if (file.size > 64 * 1024 * 1024) fail('排名文件超过 64 MB，请裁剪后重试。');
  const extension = text(file.name).split('.').at(-1).toLowerCase();
  if (extension === 'csv') {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > 64 * 1024 * 1024) fail('排名文件超过 64 MB，请裁剪后重试。');
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('CSV 不是有效的 UTF-8 编码，请另存为 CSV UTF-8。'); }
    return normalizeRankRows(csvRows(source));
  }
  if (extension === 'xlsx') {
    const tables = await readWorkbookTables(file, { sheetNames: ['SKU排名'], allowSingleSheet: true });
    const rows = tables['SKU排名'] || (Object.keys(tables).length === 1 ? Object.values(tables)[0] : null);
    if (!rows) fail('XLSX 请使用名为 SKU排名 的工作表，或仅保留一个工作表。');
    return normalizeRankRows(rows);
  }
  fail('排名导入仅支持 .csv 或 .xlsx 文件。');
}

/** Incoming same-day/SKU records replace existing ones; all other history survives. */
export function mergeRankings(existing, incoming) {
  const previous = validateRecords(existing, '历史排名'), next = validateRecords(incoming, '新排名');
  const merged = new Map(previous.map(record => [JSON.stringify([record.date, record.sku]), record]));
  const groups = new Map(previous.map(record => [record.sku, record.groupId]));
  for (const record of next) {
    if (groups.has(record.sku) && groups.get(record.sku) !== record.groupId) fail('同一 SKU 的产品类别与历史记录矛盾。');
    groups.set(record.sku, record.groupId);
    merged.set(JSON.stringify([record.date, record.sku]), record);
  }
  if (merged.size > 200000) fail('合并后排名历史超过 200000 行限制。');
  return [...merged.values()].sort((a, b) => compare(a.date, b.date) || compare(a.sku, b.sku));
}

/** Exact-date snapshot only. Positive change means improved ranking. */
export function rankingSnapshot(records, { date, groupId = 'all', sortBy = 'salesRank' } = {}) {
  const selectedDate = day(date, '筛选日期');
  if (!['all', 'sofa106', 'sofa79'].includes(groupId)) fail('排名筛选产品类别无效。');
  if (!RANKS.includes(sortBy)) fail('排名排序字段无效。');
  const normalized = validateRecords(records, '排名历史');
  const previous = new Map();
  for (const record of normalized) {
    if (record.date >= selectedDate) continue;
    const key = JSON.stringify([record.sku, record.productType]);
    if (!previous.has(key) || previous.get(key).date < record.date) previous.set(key, record);
  }
  return normalized.filter(record => record.date === selectedDate && (groupId === 'all' || record.groupId === groupId)).map(record => {
    const prior = previous.get(JSON.stringify([record.sku, record.productType]));
    return { ...record, previousDate: prior?.date || null, changes: Object.fromEntries(RANKS.map(field => [field, prior && prior[field] !== null && record[field] !== null ? prior[field] - record[field] : null])) };
  }).sort((a, b) => (a[sortBy] === null ? 1 : 0) - (b[sortBy] === null ? 1 : 0) || (a[sortBy] ?? 0) - (b[sortBy] ?? 0) || compare(a.sku, b.sku));
}
