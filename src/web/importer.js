/** Local-only XLSX import. No network, formula execution, or external references. */
const REQUIRED_SHEETS = ['订单', 'Item Data', 'SKU数据'];
const text = value => value == null ? '' : String(value).trim();
const blank = value => text(value) === '';
const fail = message => { throw new Error(message); };

function id(value, label) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || Math.abs(value) >= 1e15)) fail(`${label}不是安全的整数标识（数值 ID 最多 15 位），请在 Excel 中保存为文本。`);
  const result = text(value);
  if (!result || result.startsWith('#') || /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(result)) fail(`${label}缺失或标识格式不可靠。`);
  return result;
}

function numeric(value, label, integer = false) {
  const raw = text(value);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) fail(`${label}缺失或不是数字。`);
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isSafeInteger(number))) fail(`${label}必须为非负${integer ? '整数' : '数值'}。`);
  return number;
}

function cents(value, label) {
  const number = numeric(value, label);
  const result = Math.round(number * 100);
  // Permit harmless XLSX floating-point serialization noise, never sub-cent money.
  if (!Number.isSafeInteger(result) || Math.abs(number * 100 - result) > 0.00001) fail(`${label}必须精确到分。`);
  return result;
}

function date(value, label) {
  let result;
  const raw = text(value);
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (serial < 61 || serial > 2958465) fail(`${label}超出支持的 Excel 日期范围。`);
    result = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
  } else if (/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z?)?$/.test(raw)) {
    result = raw.slice(0, 10);
  } else fail(`${label}应为 Excel 日期或 YYYY-MM-DD。`);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== result) fail(`${label}不是有效日期。`);
  return result;
}

function headers(rows, expected, sheet) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) fail(`缺少工作表：${sheet}`);
  for (const [index, label] of expected) {
    if (text(rows[0][index]).toLowerCase() !== label.toLowerCase()) fail(`${sheet} 表头发生变化：第 ${index + 1} 列应为 ${label}，请核对模板。`);
  }
}

/** tables: { [trimmedSheetName]: array of rows including header, each row an array of values }. */
export function normalizeTables(tables, { sourceName = '本地工作簿', importedAt = new Date().toISOString() } = {}) {
  const sheets = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name.trim(), rows]));
  const productRows = sheets['SKU数据'];
  const orderRows = sheets['订单'];
  const adRows = sheets['Item Data'];
  headers(productRows, [[0, 'SKU'], [1, 'Item ID'], [2, 'Product Name'], [8, 'Currency']], 'SKU数据');
  headers(orderRows, [[1, 'Order#'], [2, 'Order Date'], [4, 'Status'], [5, 'Qty'], [6, 'CON-SKU']], '订单');
  // User-confirmed physical layout is authoritative: I=unit price, J=discount, K=shipping.
  const oldMoneyHeaders = ['Discount', 'Shipping Cost', 'Fulfillment Entity'];
  const fixedMoneyHeaders = ['商品单价', '折扣', '运费'];
  if (![oldMoneyHeaders, fixedMoneyHeaders].some(labels => labels.every((label, i) => text(orderRows[0][i + 8]) === label))) fail('订单 I/J/K 列布局改变，请确认商品单价、折扣、运费映射。');
  headers(adRows, [[14, 'Date'], [15, 'Campaign Name'], [16, 'Campaign Id'], [21, 'Ad Group Id'], [22, 'Item Id'], [23, 'SKU Id'], [27, 'Impressions'], [28, 'Clicks'], [36, 'Ad Spend'], [37, 'Orders'], [39, 'Total Attributed Sales'], [40, 'Advertised SKU Sales'], [41, 'Other SKU Sales']], 'Item Data');
  const products = [], skuMap = new Map(), itemMap = new Map();
  let excludedProducts = 0, excludedOrders = 0, excludedAds = 0;
  for (let index = 1; index < productRows.length; index++) {
    const row = productRows[index] || [];
    if (row.every(blank)) continue;
    const label = `SKU数据第 ${index + 1} 行`;
    const sku = id(row[0], `${label} SKU`), itemId = id(row[1], `${label} Item ID`), name = id(row[2], `${label} Product Name`);
    if (skuMap.has(sku) || itemMap.has(itemId)) fail(`${label}存在重复 SKU 或 Item ID，无法确定商品映射。`);
    const groupId = /\b106\s*["″]/.test(name) ? 'sofa106' : /\b79\s*["″]/.test(name) ? 'sofa79' : null;
    const product = { sku, itemId, name, groupId, groupName: groupId === 'sofa106' ? '106英寸组合沙发' : '79英寸沙发床', currency: text(row[8]) };
    skuMap.set(sku, product); itemMap.set(itemId, product);
    if (!groupId) { excludedProducts++; continue; }
    if (product.currency !== 'USD') fail(`${label}币种应为 USD，暂不支持混合币种。`);
    products.push(product);
  }
  if (!products.length) fail('SKU数据中没有找到 106 英寸或 79 英寸产品。');
  const orders = [], orderKeys = new Set(), orderDates = new Map();
  for (let index = 1; index < orderRows.length; index++) {
    const row = orderRows[index] || [];
    // Formula-only tails in L onward are not transactions.
    if (row.slice(0, 11).every(blank)) continue;
    const label = `订单第 ${index + 1} 行`;
    const sku = id(row[6], `${label} SKU`), product = skuMap.get(sku);
    if (!product) fail(`${label} SKU 未在 SKU数据中找到。`);
    if (!product.groupId) { excludedOrders++; continue; }
    const orderId = id(row[1], `${label} Order#`), lineId = JSON.stringify([orderId, sku]);
    const orderDate = date(row[2], `${label}日期`);
    if (orderDates.has(orderId) && orderDates.get(orderId) !== orderDate) fail(`${label}同一订单编号跨 SKU 的日期不一致，请核对订单日期。`);
    orderDates.set(orderId, orderDate);
    if (orderKeys.has(lineId)) fail(`${label}订单编号与 SKU 重复；缺少订单行 ID，不能安全合并。`);
    orderKeys.add(lineId);
    const quantity = numeric(row[5], `${label}数量`, true);
    if (quantity === 0) fail(`${label}数量必须大于零。`);
    const unitPriceCents = cents(row[8], `${label} I列商品单价`);
    const discountCents = cents(row[9], `${label} J列折扣（正数扣减）`);
    const shippingCents = cents(row[10], `${label} K列运费`);
    if (quantity > 1 && (discountCents || shippingCents)) fail(`${label}数量大于 1 且有折扣或运费，请先确认每件/每行口径。`);
    const itemSubtotalCents = unitPriceCents * quantity;
    if (!Number.isSafeInteger(itemSubtotalCents) || discountCents > itemSubtotalCents) fail(`${label}商品金额或折扣异常。`);
    const status = id(row[4], `${label}状态`);
    if (!/^(created|acknowledged|shipped|delivered|cancelled|canceled)$/i.test(status)) fail(`${label}状态 ${status} 未映射，请先确认是否有效订单。`);
    orders.push({ orderId, lineId, sku, groupId: product.groupId, date: orderDate, quantity, itemSubtotalCents, discountCents, shippingCents, gmvCents: /^cancel/i.test(status) ? 0 : itemSubtotalCents - discountCents, status });
  }
  const ads = [], adKeys = new Set();
  for (let index = 1; index < adRows.length; index++) {
    const row = adRows[index] || [];
    if (row.slice(14, 42).every(blank)) continue;
    const label = `Item Data第 ${index + 1} 行`;
    const itemId = id(row[22], `${label} Item Id`), product = itemMap.get(itemId);
    if (!product) fail(`${label} Item Id 未在 SKU数据中找到。`);
    if (!product.groupId) { excludedAds++; continue; }
    const sku = id(row[23], `${label} SKU Id`);
    if (sku !== product.sku) fail(`${label} SKU 与 Item Id 映射冲突。`);
    const day = date(row[14], `${label}日期`), campaignId = id(row[16], `${label} Campaign Id`), adGroupId = id(row[21], `${label} Ad Group Id`);
    const key = JSON.stringify([day, campaignId, adGroupId, itemId]);
    if (adKeys.has(key)) fail(`${label}广告日期、活动、广告组、商品组合重复，请先去重。`);
    adKeys.add(key);
    const normalized = { date: day, campaignId, adGroupId, itemId, sku, groupId: product.groupId, campaignName: text(row[15]), impressions: numeric(row[27], `${label}曝光`, true), clicks: numeric(row[28], `${label}点击`, true), spendCents: cents(row[36], `${label}花费`), attributedOrders: numeric(row[37], `${label}归因订单`, true), attributedSalesCents: cents(row[39], `${label}归因销售额`), directSalesCents: cents(row[40], `${label}本商品归因销售额`), otherSalesCents: cents(row[41], `${label}其他商品归因销售额`) };
    if (normalized.clicks > normalized.impressions) fail(`${label}点击大于曝光，请核对数据口径。`);
    if (normalized.attributedSalesCents !== normalized.directSalesCents + normalized.otherSalesCents) fail(`${label}归因销售额不等于本商品与其他商品之和，请核对数据口径。`);
    ads.push(normalized);
  }
  const range = rows => { const days = rows.map(row => row.date).sort(); return [days[0] || null, days.at(-1) || null]; };
  const [salesStart, salesEnd] = range(orders), [adsStart, adsEnd] = range(ads);
  const warnings = [
    '订单按用户确认的 I=商品单价、J=折扣、K=运费读取；商品 GMV 扣折扣、不含运费。原销售额公式未采用。',
    '源表没有退款明细；GMV 尚未扣除退款，不能视为净回款。',
    '源表没有订单行 ID；当前以订单编号 + SKU 唯一校验，重复记录会拒绝导入。',
    '日期范围为本次记录的最早/最晚日期，不证明中间每天完整；记录范围外不自动补零。',
    '广告归因窗口及报表日期口径待确认；归因销售额可能包含其他商品，不能用归因订单直接推算自然单。',
    `仅导入两类沙发；排除 ${excludedProducts} 个其他商品、${excludedOrders} 条订单和 ${excludedAds} 条广告记录。`
  ];
  if (!orders.length) warnings.push('没有两类沙发的订单记录。');
  if (!ads.length) warnings.push('没有两类沙发的广告记录。');
  if (salesEnd !== adsEnd) warnings.push('销售与广告最近日期不同；跨来源比率应选择共同日期区间。');
  return { version: 1, sourceName, importedAt, products, orders, ads, coverage: { salesStart, salesEnd, adsStart, adsEnd }, warnings };
}

function xml(source, label) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail(`${label}包含不支持的 XML 声明。`);
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) fail(`${label} XML 格式错误。`);
  return doc;
}
const elements = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

async function openZip(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (bytes.length > 64 * 1024 * 1024) fail('XLSX 文件超过 64 MB，请裁剪后重试。');
  if (bytes.length < 22) fail('不是有效的 XLSX 文件。');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 65557) fail('没有找到 XLSX ZIP 目录。');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) fail('不支持多卷 ZIP。');
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 65535 || offset === 0xffffffff || offset + directorySize > end) fail('不支持 ZIP64 或目录损坏的工作簿。');
  const entries = new Map(), decoder = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) fail('XLSX ZIP 目录损坏。');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true), localOffset = view.getUint32(offset + 42, true);
    if (offset + 46 + nameLength + extraLength + commentLength > end) fail('XLSX ZIP 文件名损坏。');
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (entries.has(name)) fail('XLSX 中存在重复路径。');
    entries.set(name, { flags, method, compressed, size, localOffset, checksum: view.getUint32(offset + 16, true) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  let expandedBytes = 0;
  return async (name, optional = false) => {
    const entry = entries.get(name);
    if (!entry) { if (optional) return null; fail(`工作簿缺少 ${name}`); }
    const { flags, method, compressed, size, localOffset, checksum } = entry;
    if (flags & 1) fail('不支持加密 XLSX，请先移除密码。');
    if (size > 32 * 1024 * 1024 || (expandedBytes += size) > 96 * 1024 * 1024) fail('工作簿解压数据过大，请裁剪不需要的工作表后重试。');
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) fail('XLSX 数据区损坏。');
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (start + compressed > bytes.length) fail('XLSX 数据超出文件边界。');
    const payload = bytes.subarray(start, start + compressed);
    let output;
    if (method === 0) output = payload;
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') fail('浏览器不支持本地 XLSX 解压，请使用新版 Chrome 或 Edge。');
      let stream;
      try { stream = new DecompressionStream('deflate-raw'); } catch { fail('浏览器不支持本地 XLSX 解压，请使用新版 Chrome 或 Edge。'); }
      const reader = new Blob([payload]).stream().pipeThrough(stream).getReader(), chunks = [];
      let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > size) { await reader.cancel(); fail('XLSX 解压大小与目录不符。'); }
        chunks.push(value);
      }
      output = new Uint8Array(length);
      let position = 0;
      for (const chunk of chunks) { output.set(chunk, position); position += chunk.length; }
    } else fail('XLSX 使用了不支持的压缩方式。');
    if (output.length !== size) fail('XLSX 数据长度校验失败。');
    if (crc32(output) !== checksum) fail('XLSX 数据校验失败，文件可能损坏，请重新导出。');
    return decoder.decode(output);
  };
}

// Kept pure for parser-boundary tests: numeric XML cells must never become text IDs.
export function parseNumericCell(raw) {
  if (raw == null || text(raw) === '') return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) fail('工作表数值单元格格式无效。');
  const value = Number(raw);
  if (!Number.isFinite(value)) fail('工作表数值单元格超出支持范围。');
  return value;
}

function worksheet(doc, strings) {
  const rows = [];
  for (const row of elements(doc, 'row')) {
    const number = Number(row.getAttribute('r'));
    if (!Number.isSafeInteger(number) || number < 1 || number > 200000) fail('工作表行号无效或超过 200000 行限制。');
    const values = [];
    for (const cell of elements(row, 'c')) {
      const reference = cell.getAttribute('r') || '';
      const match = /^([A-Z]+)\d+$/.exec(reference);
      if (!match) fail('工作表单元格地址无效。');
      let column = 0;
      for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
      if (column > 61) continue; // Only the audited source columns are used.
      const type = cell.getAttribute('t'), raw = elements(cell, 'v')[0]?.textContent;
      if (type === 's') {
        const index = Number(raw);
        if (raw == null || !Number.isSafeInteger(index) || index < 0 || index >= strings.length) fail('工作簿共享字符串索引无效。');
        values[column - 1] = strings[index];
      } else if (type === 'inlineStr') values[column - 1] = elements(cell, 't').map(node => node.textContent).join('');
      // Preserve the distinction between numeric and text IDs: Excel numbers can
      // lose precision past 15 digits, whereas text IDs must remain exact.
      else values[column - 1] = raw == null ? null : (!type || type === 'n') ? parseNumericCell(raw) : raw;
      // Cached results only. Formula text is never evaluated.
    }
    rows[number - 1] = values;
  }
  return rows;
}

/** Read selected sheets only; use cached cell values and never execute formulas. */
export async function readWorkbookTables(file, { sheetNames = REQUIRED_SHEETS, allowSingleSheet = false } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') fail('请选择 XLSX 文件。');
  if (file.size > 64 * 1024 * 1024) fail('XLSX 文件超过 64 MB，请裁剪后重试。');
  const read = await openZip(await file.arrayBuffer());
  const workbook = xml(await read('xl/workbook.xml'), 'workbook');
  if (elements(workbook, 'workbookPr').some(node => ['1', 'true'].includes(node.getAttribute('date1904')))) fail('暂不支持 1904 日期系统，请转换为 1900 日期系统。');
  const relations = xml(await read('xl/_rels/workbook.xml.rels'), 'relationships');
  const targets = new Map(elements(relations, 'Relationship').filter(node => node.getAttribute('TargetMode') !== 'External').map(node => [node.getAttribute('Id'), node.getAttribute('Target')]));
  const shared = await read('xl/sharedStrings.xml', true);
  const strings = shared ? elements(xml(shared, 'sharedStrings'), 'si').map(node => elements(node, 't').map(part => part.textContent).join('')) : [];
  const tables = {};
  const workbookSheets = elements(workbook, 'sheet');
  for (const sheet of workbookSheets) {
    const name = text(sheet.getAttribute('name'));
    if (!sheetNames.includes(name) && !(allowSingleSheet && workbookSheets.length === 1)) continue;
    if (tables[name]) fail(`重复工作表：${name}`);
    const relation = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sheet.getAttribute('r:id');
    const target = targets.get(relation);
    if (!target || target.includes('..') || target.includes('\\') || target.includes(':')) fail('工作表关系路径无效。');
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) fail('工作表路径不受支持。');
    tables[name] = worksheet(xml(await read(path), name), strings);
  }
  return tables;
}

export async function importWorkbook(file) {
  return normalizeTables(await readWorkbookTables(file), { sourceName: file.name || '本地工作簿' });
}
