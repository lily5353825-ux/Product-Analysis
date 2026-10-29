import { importRankings, mergeRankings, rankingSnapshot } from './rankings.js';

const GROUP_NAMES = { sofa106: '106 英寸组合沙发', sofa79: '79 英寸沙发床' };
const RANK_FIELDS = [
  ['impressionsRank', '曝光排名'], ['clicksRank', '点击排名'],
  ['cartRank', '加购排名'], ['salesRank', '销售排名']
];
const TEMPLATE_HEADER = '日期,SKU,Item ID,商品名称,产品类别,商品类型,商品状态,曝光排名,点击排名,加购排名,销售排名\r\n';
const create = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
};
const formatNumber = value => new Intl.NumberFormat('zh-CN').format(value);

/** Mount the independent, memory-only ranking workspace. Safe to call again. */
export function initRankings() {
  const container = document.getElementById('sku-ranking');
  if (!container || container.dataset.rankingsMounted === 'true') return;
  container.dataset.rankingsMounted = 'true';
  let records = [], selectedDate = '', selectedGroup = 'all', selectedSort = 'salesRank';
  let demo = false, sourceName = '', importedAt = '', generation = 0;

  const heading = create('div', null, 'card-heading rank-heading');
  const titleWrap = create('div');
  titleWrap.append(create('p', 'SKU RANKING', 'eyebrow'), create('h2', 'SKU 排名'));
  const actions = create('div', null, 'rank-actions');
  const input = create('input');
  input.type = 'file'; input.id = 'rank-file-input'; input.accept = '.xlsx,.csv'; input.hidden = true;
  input.setAttribute('aria-label', '选择 SKU 排名 Excel 或 CSV 文件');
  const importButton = create('label', '＋ 导入排名', 'button primary rank-button');
  importButton.htmlFor = input.id; importButton.tabIndex = 0;
  importButton.setAttribute('role', 'button'); importButton.setAttribute('aria-label', '导入 SKU 排名，支持 XLSX 和 CSV');
  const templateButton = create('button', '下载 CSV 模板', 'button secondary rank-button'); templateButton.type = 'button';
  const demoButton = create('button', '查看排名演示', 'button secondary rank-button'); demoButton.type = 'button';
  const clearButton = create('button', '清空排名', 'text-button rank-clear'); clearButton.type = 'button';
  actions.append(importButton, input, templateButton, demoButton, clearButton); heading.append(titleWrap, actions);

  const introduction = create('p', '独立导入 Walmart 排名记录，按日期更新。数字越小，排名越高；不从曝光量、点击量或销售额推算平台排名。', 'rank-intro');
  const status = create('div', '', 'rank-status'); status.hidden = true; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const demoBanner = create('div', null, 'rank-demo-banner'); demoBanner.hidden = true;
  demoBanner.append(create('strong', '合成排名演示'), create('span', '示例 SKU 和名次仅用于展示功能，不代表真实商品表现。导入真实文件时将自动移除演示历史。'));
  const source = create('div', null, 'rank-source');

  const filterBar = create('div', null, 'rank-filters');
  const dateSelect = create('select'); dateSelect.id = 'rank-date'; dateSelect.setAttribute('aria-label', '排名记录日期');
  const groupSelect = create('select'); groupSelect.id = 'rank-group'; groupSelect.setAttribute('aria-label', '排名产品类别');
  const sortSelect = create('select'); sortSelect.id = 'rank-sort'; sortSelect.setAttribute('aria-label', '排名排序指标');
  const option = (value, label) => { const el = create('option', label); el.value = value; return el; };
  groupSelect.append(option('all', '全部产品 · 2 类'), ...Object.entries(GROUP_NAMES).map(([key, value]) => option(key, value)));
  sortSelect.append(...RANK_FIELDS.map(([key, label]) => option(key, `${label} · 数字从小到大`))); sortSelect.value = selectedSort;
  for (const [label, select] of [['排名日期', dateSelect], ['产品类别', groupSelect], ['排序方式', sortSelect]]) {
    const field = create('div', null, 'rank-filter-field'), fieldLabel = create('label', label);
    fieldLabel.htmlFor = select.id; field.append(fieldLabel, select); filterBar.append(field);
  }
  const count = create('div', '', 'rank-record-count'); filterBar.append(count);
  const comparisonNote = create('p', '', 'rank-comparison-note');
  const tableWrap = create('div', null, 'rank-table-scroll'); tableWrap.tabIndex = 0; tableWrap.setAttribute('role', 'region'); tableWrap.setAttribute('aria-label', 'SKU 排名表，可横向滚动');
  const footnote = create('p', '模板必填：日期、SKU、产品类别、商品类型，以及至少一个排名。产品类别填写“106英寸组合沙发”或“79英寸沙发床”，商品类型使用原报表分类。其他字段可留空；“—”表示未提供。排名数据与经营数据分别保留在当前页面内存中，刷新后需重新导入。', 'footnote rank-footnote');
  container.replaceChildren(heading, introduction, status, demoBanner, source, filterBar, comparisonNote, tableWrap, footnote);

  function setStatus(message = '', error = false) {
    status.textContent = message; status.hidden = !message;
    status.classList.toggle('rank-status-error', error);
  }
  function sofaPlaceholder(groupId) {
    const figure = create('div', null, `rank-sofa-placeholder${groupId === 'sofa79' ? ' rank-sofa-bed' : ''}`);
    figure.setAttribute('role', 'img'); figure.setAttribute('aria-label', `${GROUP_NAMES[groupId] ?? '沙发'}示意图，非实际商品照片`);
    const sofa = create('span', null, 'rank-sofa');
    for (const part of ['back', 'seat', 'arm-left', 'arm-right', 'leg-left', 'leg-right']) sofa.append(create('span', null, `rank-sofa-${part}`));
    figure.append(sofa, create('span', '沙发示意', 'rank-placeholder-caption')); return figure;
  }
  function rankCell(row, field) {
    const cell = create('td', null, 'rank-value-cell'), value = row[field];
    cell.append(create('span', value == null ? '—' : formatNumber(value), 'rank-value'));
    const delta = row.changes?.[field];
    let changeLabel = '无可比值', changeClass = 'rank-change-neutral';
    if (value != null && delta != null && row.previousDate) {
      if (delta > 0) { changeLabel = `↑ ${formatNumber(delta)}`; changeClass = 'rank-change-up'; }
      else if (delta < 0) { changeLabel = `↓ ${formatNumber(-delta)}`; changeClass = 'rank-change-down'; }
      else changeLabel = '持平';
    }
    const change = create('span', changeLabel, `rank-change ${changeClass}`);
    const accessible = delta > 0 ? `进步 ${formatNumber(delta)} 名` : delta < 0 ? `下降 ${formatNumber(-delta)} 名` : '持平';
    change.setAttribute('aria-label', delta == null || value == null || !row.previousDate ? '没有可比较的前次排名' : `比 ${row.previousDate} ${accessible}`);
    change.title = change.getAttribute('aria-label'); cell.append(change); return cell;
  }
  function renderTable(rows) {
    const table = create('table', null, 'rank-table'), head = create('thead'), headRow = create('tr'), body = create('tbody');
    for (const title of ['商品信息', '类别 / 商品类型', ...RANK_FIELDS.map(([, label]) => label), '商品状态']) {
      const th = create('th', title); th.scope = 'col'; headRow.append(th);
    }
    head.append(headRow); table.append(head, body);
    if (!rows.length) {
      const row = create('tr'), cell = create('td', null, 'rank-empty'); cell.colSpan = 7;
      cell.append(create('strong', records.length ? '这个日期没有所选类别的排名记录' : '先导入一份 SKU 排名表'), create('span', records.length ? '可切换产品类别，或选择其他已导入日期。' : '支持 XLSX / CSV。可以先下载空白模板，或查看独立的合成排名演示。'));
      row.append(cell); body.append(row);
    }
    for (const row of rows) {
      const tr = create('tr'), productTd = create('td'), product = create('div', null, 'rank-product'), details = create('div', null, 'rank-product-copy');
      details.append(create('span', row.name || '商品名称未提供', 'rank-product-name'), create('span', `SKU · ${row.sku}`, 'rank-product-id'), create('span', `Item ID · ${row.itemId || '—'}`, 'rank-product-id'), create('span', row.previousDate ? `比较日期 · ${row.previousDate}` : '比较日期 · —（暂无前次记录）', 'rank-previous-date'));
      product.append(sofaPlaceholder(row.groupId), details); productTd.append(product);
      const categoryTd = create('td', null, 'rank-category'); categoryTd.append(create('span', GROUP_NAMES[row.groupId] ?? '—'), create('span', row.productType || '—', 'rank-product-type'));
      const conditionTd = create('td'), condition = create('span', row.condition || '—', 'rank-condition'); conditionTd.append(condition);
      tr.append(productTd, categoryTd, ...RANK_FIELDS.map(([field]) => rankCell(row, field)), conditionTd); body.append(tr);
    }
    tableWrap.replaceChildren(table);
  }
  function render() {
    const dates = [...new Set(records.map(row => row.date))].sort().reverse();
    if (dates.length && !dates.includes(selectedDate)) selectedDate = dates[0];
    const rows = records.length ? rankingSnapshot(records, { date: selectedDate, groupId: selectedGroup, sortBy: selectedSort }) : [];
    dateSelect.replaceChildren(...(dates.length ? dates.map(date => option(date, date)) : [option('', '尚未导入日期')]));
    dateSelect.value = selectedDate; dateSelect.disabled = !dates.length;
    groupSelect.value = selectedGroup; sortSelect.value = selectedSort;
    clearButton.disabled = !records.length; demoBanner.hidden = !demo;
    demoButton.disabled = records.length > 0 && !demo;
    demoButton.title = demoButton.disabled ? '已有排名数据；如需体验演示，请先清空排名' : '查看独立的合成排名示例';
    count.textContent = `${rows.length} 条当前记录${dates.length ? ` · ${dates.length} 个历史日期` : ''}`;
    comparisonNote.textContent = records.length ? `仅展示 ${selectedDate} 的记录；每个 SKU 与该 SKU 上次同商品类型的排名比较，前次日期列于商品信息中。排名日期独立于上方经营日期。` : '排名日期独立于经营看板；导入后只列出所选日期记录。同一天相同 SKU 的记录整行更新覆盖，其余日期历史保留。';
    source.replaceChildren();
    if (records.length) {
      source.append(create('span', `最近导入 · ${sourceName}`, 'rank-source-name'), create('span', `${records.length} 条历史记录 · ${dates.at(-1)} 至 ${dates[0]}`, 'rank-source-coverage'), create('span', `${importedAt} · 仅当前页面内存`, 'rank-source-time'));
    } else source.append(create('span', '尚未导入排名数据 · 可独立使用，无需先导入订单或广告表', 'rank-source-name'));
    renderTable(rows);
  }
  function applyIncoming(incoming, filename, isDemo = false) {
    if (!Array.isArray(incoming) || !incoming.length) throw new Error('文件中没有有效的 SKU 排名记录。');
    const candidate = mergeRankings(isDemo || demo ? [] : records, incoming);
    const date = incoming.map(row => row.date).sort().at(-1);
    // Validate the view before changing live state; errors keep the prior import intact.
    rankingSnapshot(candidate, { date, groupId: selectedGroup, sortBy: selectedSort });
    records = candidate; selectedDate = date; demo = isDemo; sourceName = filename;
    importedAt = new Date().toLocaleString('zh-CN', { hour12: false });
    render();
  }
  input.addEventListener('change', async () => {
    const file = input.files?.[0]; if (!file) return;
    const token = ++generation; importButton.removeAttribute('aria-busy');
    if (file.size > 30 * 1024 * 1024) { setStatus('文件超过 30 MB，请拆分日期后重新导入。已有排名保持不变。', true); input.value = ''; return; }
    setStatus('正在本地读取排名文件，请稍候…'); importButton.setAttribute('aria-busy', 'true');
    try {
      const incoming = await importRankings(file);
      if (token !== generation) return;
      applyIncoming(incoming, file.name);
      setStatus(`排名导入成功：本次读取 ${incoming.length} 条记录，已选择文件最新日期 ${selectedDate}。历史日期已保留；同日相同 SKU 的记录已整行更新。经营数据未受影响。`);
    } catch (error) { if (token === generation) setStatus(`排名导入失败：${error.message} 已有排名保持不变。`, true); }
    finally { if (token === generation) { input.value = ''; importButton.removeAttribute('aria-busy'); } }
  });
  importButton.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
  templateButton.addEventListener('click', () => {
    const blob = new Blob(['\ufeff', TEMPLATE_HEADER], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = create('a'); anchor.href = url; anchor.download = 'SKU排名导入模板.csv';
    anchor.hidden = true; container.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('空白 CSV 模板已生成。请填写真实日期、SKU、产品类别、商品类型及至少一个排名；留空的排名不会记为零。');
  });
  demoButton.addEventListener('click', () => {
    if (records.length > 0 && !demo) return;
    ++generation; input.value = ''; importButton.removeAttribute('aria-busy');
    try { applyIncoming(makeDemoRankings(), '合成排名演示 · 非真实商品', true); setStatus('已切换至合成排名演示。可切换两个日期查看名次变化；导入真实文件时将移除演示历史。'); }
    catch (error) { setStatus(`演示加载失败：${error.message}`, true); }
  });
  clearButton.addEventListener('click', () => {
    ++generation; records = []; selectedDate = ''; demo = false; sourceName = ''; importedAt = ''; input.value = ''; importButton.removeAttribute('aria-busy');
    render(); setStatus('已清空当前页面内存中的排名记录，经营数据未受影响。');
  });
  for (const [select, update] of [[dateSelect, value => { selectedDate = value; }], [groupSelect, value => { selectedGroup = value; }], [sortSelect, value => { selectedSort = value; }]]) select.addEventListener('change', () => { update(select.value); render(); });
  render();
}

function makeDemoRankings() {
  const base = [
    { sku: 'DEMO-RANK-106-GREY', itemId: 'DEMO-ITEM-106', name: '演示 · 106 英寸灰色组合沙发', groupId: 'sofa106', productType: 'Sectional Sofas', condition: 'New' },
    { sku: 'DEMO-RANK-79-BLUE', itemId: 'DEMO-ITEM-79', name: '演示 · 79 英寸蓝色沙发床', groupId: 'sofa79', productType: 'Sofas & Couches', condition: 'New' }
  ];
  return [
    { ...base[0], date: '2026-10-26', impressionsRank: 128, clicksRank: 94, cartRank: 76, salesRank: 62 },
    { ...base[1], date: '2026-10-26', impressionsRank: 181, clicksRank: 137, cartRank: 104, salesRank: 89 },
    { ...base[0], date: '2026-10-28', impressionsRank: 112, clicksRank: 83, cartRank: 76, salesRank: 55 },
    { ...base[1], date: '2026-10-28', impressionsRank: 169, clicksRank: 145, cartRank: null, salesRank: 93 }
  ];
}
