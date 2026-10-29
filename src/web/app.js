import { importWorkbook } from './importer.js';
import { GROUPS, validateDataset, defaultWindow, computeMetrics, datesBetween } from './dashboard-metrics.js';
import { initRankings } from './rank-view.js';

const $ = id => document.getElementById(id);
const money = cents => cents == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(cents / 100);
const number = value => value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
const percent = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const multiple = value => value == null ? '—' : `${value.toFixed(2)}×`;
const node = (tag, text, className) => { const e = document.createElement(tag); if (text != null) e.textContent = String(text); if (className) e.className = className; return e; };
let dataset = null;
let isDemo = false;
let generation = 0;
let lastFilters = null;

function feedback(message, error = false) { $('feedback').hidden = !message; $('feedback').textContent = message; $('feedback').classList.toggle('error', error); }
function makeTable(headers, rows) {
  const table = node('table'), head = node('thead'), tr = node('tr'), body = node('tbody');
  headers.forEach(text => { const th = node('th', text); th.scope = 'col'; tr.append(th); });
  head.append(tr); table.append(head, body);
  if (!rows.length) { const td = node('td', dataset ? '所选期间暂无可展示记录。' : '导入数据后显示明细。', 'table-empty'); td.colSpan = headers.length; const row = node('tr'); row.append(td); body.append(row); }
  rows.forEach(values => { const row = node('tr'); values.forEach(value => { const td = node('td'); td.append(value instanceof Node ? value : document.createTextNode(String(value))); row.append(td); }); body.append(row); });
  return table;
}
function productCell(name, sub) { const e = node('div'); e.append(node('span', name, 'product-name'), node('span', sub, 'product-sub')); return e; }
function kpis(metrics) {
  const sales = metrics?.hasSalesRecords, ads = metrics?.hasAds;
  const definitions = [
    ['商品 GMV', sales ? money(metrics.gmv) : '—', '订单商品金额 − 折扣 · 不含运费', '$'],
    ['有效订单', sales ? number(metrics.orders) : '—', sales ? `售出 ${number(metrics.units)} 件 · 按订单编号去重` : '按订单编号去重 · 取消订单不计入', '▤'],
    ['广告花费', ads ? money(metrics.spend) : '—', '广告预算未设置 · 不计算预算消耗率', '↗'],
    ['广告费占 GMV · TACOS', ads && sales && metrics.comparable ? percent(metrics.tacos) : '—', metrics && !metrics.comparable ? '记录范围不一致 · 暂无可比口径' : '广告花费 ÷ 商品 GMV · 仅供参考', '%'],
    ['直接商品 ACOS', ads ? percent(metrics.acos) : '—', '广告花费 ÷ 直接商品归因销售额', '◷'],
    ['直接商品 ROAS', ads ? multiple(metrics.roas) : '—', '直接商品归因销售额 ÷ 广告花费', '⇄'],
    ['直接商品归因销售额', ads ? money(metrics.directSales) : '—', '仅当前广告商品 · 按广告报表归因', '$'],
    ['品类订单目标进度', sales ? percent(metrics.progress) : '—', metrics ? `${number(metrics.targetOrderCount)} / ${number(metrics.target)} 品类订单 · ${metrics.days} 天` : '每类每天 2 单 · 两类合计 4 单', '✓']
  ];
  $('kpis').replaceChildren(...definitions.map(([label, value, note, icon]) => {
    const el = node('article', null, 'kpi'), title = node('div', label, 'kpi-label'); title.append(node('span', icon, 'kpi-icon'));
    el.append(title, node('div', value, `kpi-value${String(value).length > 12 ? ' small-value' : ''}`), node('div', note, 'kpi-note')); return el;
  }));
}
function renderAdKpis(m) {
  const definitions = [
    ['广告曝光', m?.hasAds ? number(m.impressions) : '—', '所选期间曝光次数合计'],
    ['广告点击', m?.hasAds ? number(m.clicks) : '—', '所选期间点击次数合计'],
    ['平均 CPC', m?.hasAds ? money(m.cpc) : '—', '广告总花费 ÷ 总点击'],
    ['点击率 · CTR', m?.hasAds ? percent(m.ctr) : '—', '总点击 ÷ 总曝光'],
    ['转化率 · CVR', m?.hasAds ? percent(m.cvr) : '—', '广告归因订单 ÷ 总点击']
  ];
  $('ad-kpis').replaceChildren(...definitions.map(([label, value, note]) => {
    const el = node('article', null, 'ad-kpi');
    el.append(node('div', label, 'kpi-label'), node('div', value, 'kpi-value'), node('div', note, 'kpi-note')); return el;
  }));
  $('ad-window').textContent = m ? `${$('start-date').value} — ${$('end-date').value} · ${$('group-filter').value === 'all' ? '全部产品' : GROUPS[$('group-filter').value]}` : '随上方日期与产品类别筛选更新';
}
function renderGoal(m) {
  const wrap = node('div'), total = node('div', null, 'goal-number');
  total.append(node('strong', m?.hasSalesRecords ? number(m.targetOrderCount) : '—'), node('span', `/ ${m ? number(m.target) : '—'} 单`), node('span', m?.hasSalesRecords ? percent(m.progress) : '—', 'goal-percent'));
  const track = node('div', null, 'progress-track'), fill = node('div', null, 'progress-fill'); fill.style.width = `${m?.progress != null ? Math.min(100, Math.max(0, m.progress * 100)) : 0}%`; track.append(fill);
  const summary = !m ? '导入数据后，查看距目标还差多少。' : !m.hasSalesRecords ? '当前区间无销售记录，无法确认实际完成情况。' : m.gap < 0 ? `已记录品类订单距目标还差 ${number(-m.gap)} 单。` : `已记录品类订单${m.gap === 0 ? '达到目标' : `超出目标 ${number(m.gap)} 单`}。`;
  wrap.append(total, track, node('p', summary, 'goal-summary'), node('p', '按自然日累计目标；跨类别同一订单可分别计入各类目标。完整交易覆盖仍待核对。', 'footnote'));
  $('goal').replaceChildren(wrap);
}
function renderChart(m) {
  if (!m) { $('trend').replaceChildren(node('div', '导入数据，查看每日品类订单与目标的距离。', 'chart-empty')); return; }
  const ns = 'http://www.w3.org/2000/svg', make = (tag, attrs = {}, text) => { const el = document.createElementNS(ns, tag); for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, String(val)); if (text != null) el.textContent = String(text); return el; };
  const width = 660, height = 210, left = 31, right = 17, top = 15, bottom = 34, innerH = height - top - bottom;
  const svg = make('svg', { viewBox: `0 0 ${width} ${height}`, class: 'trend-svg', role: 'img', 'aria-label': '每日品类订单与订单目标趋势；无销售记录日期为空心点' });
  const max = Math.max(4, ...m.series.map(r => Math.max(r.targetOrderCount, r.target))) * 1.2;
  const x = i => left + (m.series.length > 1 ? i / (m.series.length - 1) : .5) * (width - left - right), y = val => top + innerH * (1 - val / max);
  for (let i = 0; i <= 4; i++) { const val = max * i / 4, yy = y(val); svg.append(make('line', { x1: left, x2: width - right, y1: yy, y2: yy, stroke: '#eeeff6', 'stroke-width': 1 })); svg.append(make('text', { x: left - 10, y: yy + 4, fill: '#a2a9bb', 'font-size': 10, 'text-anchor': 'end' }, number(val))); }
  svg.append(make('line', { x1: left, x2: width - right, y1: y(m.series[0].target), y2: y(m.series[0].target), stroke: '#c3beda', 'stroke-width': 1.5, 'stroke-dasharray': '5 5' }));
  let segment = [];
  const appendSegment = () => { if (segment.length > 1) svg.append(make('polyline', { points: segment.join(' '), fill: 'none', stroke: '#756bdd', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })); segment = []; };
  m.series.forEach((r, i) => { if (r.hasSalesRecords) segment.push(`${x(i)},${y(r.targetOrderCount)}`); else appendSegment(); }); appendSegment();
  m.series.forEach((r, i) => { const dot = make('circle', { cx: x(i), cy: y(r.targetOrderCount), r: m.series.length > 90 ? 1.5 : 3.5, fill: r.hasSalesRecords ? '#756bdd' : '#fff', stroke: r.hasSalesRecords ? '#756bdd' : '#c9c5dc', 'stroke-width': 1.5 }); dot.append(make('title', {}, `${r.date}：${r.hasSalesRecords ? `${number(r.targetOrderCount)} 品类订单` : '无销售记录，交易完整性待确认'}；目标 ${r.target} 单`)); svg.append(dot); });
  const labelEvery = Math.max(1, Math.ceil(m.series.length / 6)); m.series.forEach((r, i) => { if (i % labelEvery === 0 || i === m.series.length - 1 && m.series.length % labelEvery > 1) svg.append(make('text', { x: x(i), y: height - 9, fill: '#9aa2b4', 'font-size': 10, 'text-anchor': 'middle' }, r.date.slice(5).replace('-', '/'))); });
  $('trend').replaceChildren(svg);
}
function renderTables(m) {
  $('comparison-table').replaceChildren(makeTable(['产品类别', 'GMV', '有效订单', '品类目标 / 差距', '广告花费', '直接 ACOS', '直接 ROAS'], (m?.comparisons ?? []).map(r => [productCell(GROUPS[r.groupId], `${dataset.products.filter(p => p.groupId === r.groupId).length} 个 SKU · 全部变体`), r.hasSalesRecords ? money(r.gmv) : '—', r.hasSalesRecords ? number(r.orders) : '—', `${number(r.target)} / ${r.hasSalesRecords ? (r.orders - r.target >= 0 ? '+' : '') + number(r.orders - r.target) : '待确认'}`, r.hasAds ? money(r.spend) : '—', r.hasAds ? percent(r.acos) : '—', r.hasAds ? multiple(r.roas) : '—'])));
  $('ads-table').replaceChildren(makeTable(['活动 / 商品', '产品类别', '曝光', '点击', '平均 CPC', '点击率 CTR', '转化率 CVR', '花费', '归因订单', '直接商品销售额', '总归因销售额', '直接 ACOS', '直接 ROAS'], (m?.campaigns ?? []).map(r => [productCell(r.campaignName || r.campaignId, `${r.sku} · 活动 ${r.campaignId}`), GROUPS[r.groupId], number(r.impressions), number(r.clicks), money(r.cpc), percent(r.ctr), percent(r.cvr), money(r.spend), number(r.attributedOrders), money(r.directSales), money(r.attributedSales), percent(r.acos), multiple(r.roas)])));
}
function renderGuidance(m) {
  const entries = [['先补齐投放决策口径', '尚未设置广告预算、目标 ACOS 与归因窗口。当前只提供诊断，不生成加预算、降预算或暂停广告指令。']];
  if (m?.hasSalesRecords && m.gap < 0) entries.push(['先看各类订单差距', `当前记录距品类订单目标还差 ${number(-m.gap)} 单。优先核对交易覆盖，再检查商品曝光、点击和成交情况。`]);
  if (m?.campaigns.some(r => r.spend > 0 && r.attributedOrders === 0)) entries.push(['检查有花费、无归因订单的活动', '部分活动已产生花费但未记录归因订单。先确认归因回填与报表完整性，再检查搜索词、商品页和转化。']);
  if (!m) entries.push(['从实际表现建立新品基线', '先查看销售与广告趋势，再补充目标 ACOS、当前日预算和归因窗口，逐步启用预算建议。']);
  $('suggestions').replaceChildren(...entries.map(([title, body], i) => { const row = node('div', null, 'suggestion'), copy = node('div'); copy.append(node('h3', title), node('p', body)); row.append(node('span', String(i + 1).padStart(2, '0'), 'suggestion-mark'), copy); return row; }));
  const issues = [
    '订单 I 列为商品单价，J 列为折扣，K 列为运费。GMV = 单价 × 数量 − 折扣；不含运费，未扣未提供的退款。',
    '广告归因窗口和按点击日 / 成交日统计口径尚未确认。ACOS、ROAS、TACOS 仅用于观察，不直接据此调预算。',
    '没有记录不等于零交易。需核对订单和广告导出是否覆盖选定期间，之后再确认目标完成情况。',
    ...(dataset?.warnings ?? [])
  ];
  if (m && !m.comparable) issues.unshift('当前选择超出至少一类产品的销售 / 广告共同记录范围，TACOS 暂不展示。');
  if (m?.cancelledRows) issues.push(`已排除 ${m.cancelledRows} 条取消订单行的订单数、件数与 GMV。`);
  $('data-issues').replaceChildren(...[...new Set(issues)].map(text => node('li', text)));
}
function render() {
  let m = null;
  if (dataset) m = computeMetrics(dataset, { start: $('start-date').value, end: $('end-date').value, groupId: $('group-filter').value, dailyTarget: Number($('daily-target').value) });
  $('empty-state').hidden = Boolean(dataset); $('demo-banner').hidden = !isDemo;
  $('clear-button').disabled = !dataset; $('start-date').disabled = !dataset; $('end-date').disabled = !dataset;
  document.body.classList.toggle('loaded', Boolean(dataset));
  $('source-name').textContent = dataset ? dataset.sourceName : '等待导入经营数据';
  $('import-time').textContent = dataset ? `导入于 ${new Date(dataset.importedAt).toLocaleString('zh-CN', { hour12: false })}` : '';
  $('window-label').textContent = m ? `${m.days} 个自然日 · ${$('group-filter').value === 'all' ? '2 类产品' : '1 类产品'}` : '先导入数据';
  $('target-label').textContent = `每类 ${$('daily-target').value} 单 / 天 · 合计 ${Number($('daily-target').value) * ($('group-filter').value === 'all' ? 2 : 1)} 单 / 天`;
  $('coverage-note').textContent = dataset ? `销售记录：${dataset.coverage.salesStart ?? '暂无'} — ${dataset.coverage.salesEnd ?? '暂无'}；广告记录：${dataset.coverage.adsStart ?? '暂无'} — ${dataset.coverage.adsEnd ?? '暂无'}。选定期间销售有记录 ${m.salesRecordDays} 天，广告有记录 ${m.adRecordDays} 天；记录完整性待确认。` : '日期默认使用销售与广告记录的重叠区间。无记录的日期不自动视为零交易。';
  kpis(m); renderAdKpis(m); renderGoal(m); renderChart(m); renderTables(m); renderGuidance(m);
  lastFilters = Object.fromEntries(['start-date', 'end-date', 'group-filter', 'daily-target'].map(id => [id, $(id).value]));
}
function acceptDataset(data, demo = false) {
  const validated = validateDataset(data), range = defaultWindow(validated);
  if (!range.start || !range.end) throw new Error('没有可用的订单或广告记录，请检查导出文件。');
  datesBetween(range.start, range.end);
  if ($('daily-target').value === '') throw new Error('每日订单目标不能为空。');
  computeMetrics(validated, { start: range.start, end: range.end, groupId: $('group-filter').value, dailyTarget: Number($('daily-target').value) });
  dataset = validated; isDemo = demo;
  $('start-date').value = range.start; $('end-date').value = range.end;
  render(); feedback(demo ? '' : `导入成功：${dataset.products.length} 个 SKU、${dataset.orders.length} 条订单行、${dataset.ads.length} 条广告记录。${range.overlap ? '已默认选择销售与广告的重叠日期。' : '销售与广告无共同记录区间，请核对日期。'}`);
}
function demoDataset() {
  const products = [{ sku: 'DEMO-106-GREY', itemId: 'DEMO-ITEM-106', groupId: 'sofa106', groupName: GROUPS.sofa106, name: '演示 · 106 英寸灰色组合沙发', currency: 'USD' }, { sku: 'DEMO-79-BLUE', itemId: 'DEMO-ITEM-79', groupId: 'sofa79', groupName: GROUPS.sofa79, name: '演示 · 79 英寸蓝色沙发床', currency: 'USD' }];
  const orders = [], ads = [], days = datesBetween('2026-10-15', '2026-10-28');
  const counts = [[1, 0, 1, 2, 1, 2, 1, 2, 3, 1, 2, 3, 2, 2], [1, 1, 1, 0, 1, 2, 1, 1, 2, 2, 1, 2, 3, 2]];
  for (const [i, date] of days.entries()) for (const [p, product] of products.entries()) {
    const price = p === 0 ? 49900 : 32900;
    for (let j = 0; j < counts[p][i]; j++) orders.push({ orderId: `DEMO-${i}-${p}-${j}`, lineId: '1', sku: product.sku, groupId: product.groupId, date, quantity: 1, itemSubtotalCents: price, discountCents: 0, shippingCents: 4900, gmvCents: price, status: 'Shipped' });
    const conversions = i % 4 === p ? 0 : 1;
    ads.push({ date, campaignId: `DEMO-CAMPAIGN-${p}`, adGroupId: `DEMO-ADGROUP-${p}`, itemId: product.itemId, sku: product.sku, groupId: product.groupId, campaignName: p === 0 ? '演示 · 组合沙发自动广告' : '演示 · 沙发床关键词广告', impressions: 3300 + i * 167 + p * 500, clicks: 24 + i * 2 + p * 7, spendCents: 2300 + i * 131 + p * 500, attributedOrders: conversions, directSalesCents: conversions * price, otherSalesCents: 0, attributedSalesCents: conversions * price });
  }
  return { version: 1, sourceName: '合成演示数据 · 非真实经营数据', products, orders, ads, warnings: ['当前是合成演示数据，不可用于真实投放决策。'] };
}
$('file-input').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  const token = ++generation;
  if (file.size > 30 * 1024 * 1024) { feedback('文件超过 30 MB，请按日期拆分后重试。', true); event.target.value = ''; return; }
  feedback('正在本地读取并检查数据，请稍候…'); $('upload-label').classList.add('busy');
  try {
    const data = /\.xlsx$/i.test(file.name) ? await importWorkbook(file) : /\.json$/i.test(file.name) ? JSON.parse(await file.text()) : (() => { throw new Error('请选择 .xlsx 或 .json 文件。'); })();
    if (token === generation) acceptDataset(data);
  } catch (error) { if (token === generation) feedback(`导入失败：${error.message} 当前已有数据仍保留。`, true); }
  finally { if (token === generation) $('upload-label').classList.remove('busy'); event.target.value = ''; }
});
$('upload-label').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('file-input').click(); } });
$('demo-button').addEventListener('click', () => { ++generation; $('upload-label').classList.remove('busy'); acceptDataset(demoDataset(), true); });
$('clear-button').addEventListener('click', () => { ++generation; dataset = null; isDemo = false; $('file-input').value = ''; $('start-date').value = ''; $('end-date').value = ''; feedback('已清空浏览器内存中的经营数据。'); render(); });
$('daily-target').addEventListener('input', () => {
  const value = $('daily-target').value, target = Number(value);
  if (value !== '' && Number.isInteger(target) && target >= 0 && target <= 10000) { render(); feedback(''); }
});
for (const id of ['start-date', 'end-date', 'group-filter', 'daily-target']) $(id).addEventListener('change', () => { try { const target = Number($('daily-target').value); if ($('daily-target').value === '' || !Number.isInteger(target) || target < 0 || target > 10000) throw new Error('每日订单目标须为 0–10,000 之间的整数。'); render(); feedback(''); } catch (error) { if (lastFilters) for (const [key, value] of Object.entries(lastFilters)) $(key).value = value; feedback(`${error.message} 已恢复上次有效的筛选条件。`, true); } });
render();
initRankings();
