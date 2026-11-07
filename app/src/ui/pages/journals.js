import { h, card, select, download, toast, ask, table, amt } from '../dom.js';
import { journalCard, kpi, emptyState, groupJournals, contentKey, contentName, contentOrder, pairLabel, aggregateLines } from '../components.js';
import { update } from '../store.js';
import { TEMPLATES, CARRY_DEFS, CARRY_MODES, carryModeOf, carryWarnings, generateAll, openingTrace } from '../../engine/elimination.js';
import { accountLabel, ACCOUNTS } from '../../engine/accounts.js';
import { toCsv, sanitizeManual } from '../../engine/data.js';
import { fmt, indexToYm, indexToJp } from '../../engine/util.js';

// 表示の状態（画面を移っても保つ）
const filter = { kind: 'all', contract: 'all', content: 'all', account: '', mode: 'contract' };
const MODES = [['contract', '契約単位'], ['company', '会社単位'], ['total', '合計']];

/** 他の画面（連結精算表など）から、条件を指定して仕訳帳・元帳を開く */
export function focusJournals(opts = {}) {
  Object.assign(filter, { kind: 'all', contract: 'all', content: 'all', account: '' }, opts);
  if (location.hash === '#journals') window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = '#journals';
  setTimeout(() => document.getElementById(opts.account ? 'ledger' : 'journal-book')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
}

export function renderJournals(ctx) {
  const { gen, pol, names, companies, period, data } = ctx;
  const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const match = (j) => (filter.kind === 'all' || j.kind === filter.kind) && (filter.contract === 'all' || j.contractId === filter.contract) && (filter.content === 'all' || contentKey(j) === filter.content || (j.src || j.tpl) === filter.content || (filter.content === 'OPEN' && (String(j.tpl).startsWith('C-01') || j.tpl === 'M-01O')));
  const js = gen.journals.filter(match);
  const lines = js.flatMap((j) => j.lines);
  const pl = lines.filter((l) => ACCOUNTS[l.acc]?.type === 'PL' && !['TAX_ADJ', 'NCI_PL'].includes(l.acc)).reduce((a, l) => a - l.amt, 0);
  const tax = lines.filter((l) => l.acc === 'TAX_ADJ').reduce((a, l) => a + l.amt, 0);
  const dr = lines.filter((l) => l.amt > 0).reduce((a, l) => a + l.amt, 0);
  const cr = -lines.filter((l) => l.amt < 0).reduce((a, l) => a + l.amt, 0);
  const contents = [...new Map([...gen.journals].sort(contentOrder).map((j) => [contentKey(j), contentName(j)])).entries()];
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '仕訳の表示単位' }, MODES.map(([v, l]) => h('button', { type: 'button', class: filter.mode === v ? 'on' : '', on: { click: () => { filter.mode = v; rerender(); } } }, l)));
  const controls = h('div', { class: 'filters' },
    h('span', { class: 'fg-label' }, '表示単位'), seg,
    h('label', null, '区分 ', select([['all', 'すべて'], ['IND', '個社修正'], ['CON', '連結修正']], filter.kind, (v) => { filter.kind = v; rerender(); })),
    h('label', null, '内容 ', select([['all', 'すべて'], ['OPEN', '開始仕訳・洗替（すべて）'], ...contents.map(([k, t]) => [k, `${k.replace(':', '・')} ${t}`])], filter.content, (v) => { filter.content = v; rerender(); })),
    h('label', null, '契約 ', select([['all', 'すべて'], ...data.contracts.map((c) => [c.id, `${c.id} ${c.name}`])], filter.contract, (v) => { filter.contract = v; rerender(); })),
    h('button', { class: 'btn', type: 'button', on: { click: () => exportCsv(js, ctx) } }, '仕訳帳を書き出す（CSV）'));

  const links = (l) => [{ label: `元帳（${accountLabel(l, pol, names)}）`, go: () => focusJournals({ account: accountLabel(l, pol, names) }) }];
  const grouped = groupJournals(js, filter.mode, ctx);
  const opening = grouped.filter((j) => String(j.tpl).startsWith('C-01') || j.tpl === 'M-01O');
  const current = grouped.filter((j) => !opening.includes(j));
  const cards = (arr) => h('div', { class: 'journals' }, arr.map((j) => journalCard(j, { pol, names, companies }, { links })));
  const modeNote = { contract: '契約ごとに、内容別の仕訳を表示しています。', company: '内容ごとに、会社（貸手→借手の組合せ。個社修正は会社）単位で合算して表示しています。', total: '内容ごとに、全契約を合算して表示しています。「会社別・契約別の内訳を表示」でドリルダウンできます。' }[filter.mode];

  return h('div', { class: 'page' },
    h('div', { class: 'kpi' },
      kpi('仕訳本数', `${grouped.length} 本`, filter.mode === 'contract' ? `個社修正 ${js.filter((j) => j.kind === 'IND').length}／連結修正 ${js.filter((j) => j.kind === 'CON').length}` : `元の仕訳 ${js.length} 本を合算`),
      kpi('借方合計 ／ 貸方合計', `${fmt(dr)} ／ ${fmt(cr)}`, dr === cr ? '一致' : '不一致'),
      kpi('当期の損益への影響（税引前）', fmt(pl), '表示中の仕訳による連結利益の増減'),
      kpi('法人税等調整額', fmt(tax), '＋は税金費用の増加')),
    card(null, controls, h('p', { class: 'muted small' }, modeNote)),
    carryCard(ctx),
    h('section', { class: 'card', id: 'journal-book' }, h('h2', null, `当期の仕訳（${period.label}）`),
      opening.length ? h('h3', null, `開始仕訳（前期末からの繰越）・洗替：${opening.length}本`) : null,
      opening.length ? cards(opening) : null,
      h('h3', null, `当期の仕訳：${current.length}本`),
      current.length ? cards(current) : emptyState('該当する仕訳はありません')),
    nextOpeningCard(ctx, match),
    summaryCard(js, ctx),
    ledgerCard(js, ctx),
    manualCard(ctx));
}

/** 連結修正仕訳の繰越設定（内容別）：初期値はアプリが持ち、利用者が切り替えられる */
function carryCard(ctx) {
  const { data, pol } = ctx;
  const cfg = data.config.carry || {};
  const warns = carryWarnings(cfg);
  const rows = CARRY_DEFS.map((d) => {
    const mode = carryModeOf(cfg, d.tpl);
    const sel = d.fixed ? h('span', null, CARRY_MODES[mode], h('span', { class: 'muted small' }, '（変更不可）')) : select(Object.entries(CARRY_MODES), mode, async (v) => {
      if (d.re && v === 'none' && !(await ask({ title: '「繰越なし」にしますか？', message: `${d.tpl} ${TEMPLATES[d.tpl].title}は翌期の利益剰余金に影響する仕訳です。「繰越なし」にすると翌期の開始仕訳に引き継がれず、翌期の連結上の利益剰余金期首・残高が正しくなりません（検算が NG になります）。`, okLabel: '繰越なしにする', danger: true }))) { window.dispatchEvent(new HashChangeEvent('hashchange')); return; }
      update((x) => { x.config.carry = { ...(x.config.carry || {}), [d.tpl]: v }; if (v === d.default) delete x.config.carry[d.tpl]; }, '繰越設定の変更', `${d.tpl}：${CARRY_MODES[mode]} → ${CARRY_MODES[v]}`);
    });
    return h('tr', { class: d.re && mode === 'none' ? 'warn-row' : '' },
      h('td', { class: 'nw' }, h('b', null, d.tpl)), h('td', null, TEMPLATES[d.tpl].title),
      h('td', null, d.re ? h('span', { class: 'badge caution' }, 'あり') : h('span', { class: 'badge' }, 'なし')),
      h('td', null, sel), h('td', { class: 'small muted' }, CARRY_MODES[d.default]), h('td', { class: 'small' }, d.why));
  });
  const balanceMode = pol['POL-03'] === 'balance';
  return h('details', { class: 'card carry-card', open: warns.length > 0 },
    h('summary', null, h('b', null, '連結修正仕訳の繰越設定（内容別）'), h('span', { class: 'muted small' }, `　${warns.length ? `警告 ${warns.length}件` : 'すべての内容が適切に設定されています'}`)),
    warns.length ? h('div', { class: 'alert alert-warn' }, h('b', null, '警告：'), h('ul', null, warns.map((w) => h('li', null, w)))) : null,
    balanceMode ? h('div', { class: 'alert alert-info' }, '会計方針 POL-03 が「期末残高一括消去」のため、開始仕訳を作らず毎期末に残高を一括で消去します。この設定は使われません。') : null,
    h('div', { class: 'alert alert-info' }, '繰越あり－洗替あり：前期末の残高を開始仕訳で引き継ぎ、当期首に洗い替え（戻し）、期末に全額を計上し直します。繰越あり－洗替なし：前期末の残高を開始仕訳で引き継ぎ、当期は増減だけを計上します。繰越なし：開始仕訳を作りません。どの「繰越あり」を選んでも連結の残高・損益は同じです。翌期の利益剰余金に影響する仕訳を「繰越なし」にすると警告します。'),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl compact' },
      h('thead', null, h('tr', null, ['内容', '', '翌期の剰余金への影響', '繰越方法', '初期値', '理由'].map((t) => h('th', null, t)))), h('tbody', null, rows))));
}

/** 期間の翌期（同じ区切り）。一覧の最後なら同じ長さで作る */
function nextPeriodOf(ctx) {
  const { periods, periodIndex, period } = ctx;
  if (periods[periodIndex + 1]) return periods[periodIndex + 1];
  const len = period.end - period.start + 1;
  return { start: period.end + 1, end: period.end + len, label: `${period.label}の翌期`, fyEnd: period.fyEnd + (len === 12 ? 12 : 0) };
}

/** 翌期の開始仕訳：内容別・会社別に作成し、前期以前のどの年度の仕訳から生じたかをトレースする */
function nextOpeningCard(ctx, match) {
  const { data, pol, names, companies, schedCache, yearPeriods, period } = ctx;
  const np = nextPeriodOf(ctx);
  let gen2;
  try { gen2 = generateAll(data, np, pol, { schedCache }); } catch (e) { return card('翌期の開始仕訳', h('div', { class: 'alert alert-err' }, e.message)); }
  const opens = gen2.journals.filter((j) => ['C-01', 'C-01T', 'C-01N', 'M-01O'].includes(j.tpl) && (filter.contract === 'all' || j.contractId === filter.contract) && (filter.kind === 'all' || j.kind === filter.kind));
  if (!opens.length) return card(`翌期の開始仕訳（${np.label}の期首）`, emptyState(pol['POL-03'] === 'balance' ? '会計方針 POL-03 が「期末残高一括消去」のため、開始仕訳は作りません。' : '翌期に引き継ぐ仕訳はありません。'));
  // 会社別：連結（CONSOL）の行は、その仕訳の貸手の会社に含める（組替の相手勘定のため）
  const coOf = (j, l) => (l.co === 'CONSOL' ? j.lessorCo || 'CONSOL' : l.co);
  const groups = new Map();
  for (const j of opens) {
    const r = gen2.results.find((x) => x.contract.id === j.contractId);
    const tr = r && j.src ? openingTrace(r, j, yearPeriods, pol, companies) : [];
    for (const co of [...new Set(j.lines.map((l) => coOf(j, l)))]) {
      const k = `${contentKey(j)}|${co}`;
      const g = groups.get(k) || groups.set(k, { j0: j, co, parts: [], trace: [] }).get(k);
      g.parts.push({ ...j, company: co, lines: j.lines.filter((l) => coOf(j, l) === co) });
      g.trace.push(...tr.filter((x) => (x.co === 'CONSOL' ? j.lessorCo : x.co) === co).map((x) => ({ ...x, contract: j.contractId })));
    }
  }
  const list = [...groups.values()].sort((a, b) => contentOrder(a.j0, b.j0) || String(a.co).localeCompare(String(b.co)));
  const coName = (code) => (code === 'CONSOL' ? '連結' : companies.find((c) => c.code === code)?.name || code);
  const cardsEl = list.map((g) => {
    const agg = { id: `N-${contentKey(g.j0)}-${g.co}`, tpl: g.j0.tpl, src: g.j0.src, kind: g.j0.kind, title: contentName(g.j0), company: g.co, groupLabel: `${coName(g.co)}：${g.parts.length}契約`, lines: aggregateLines(g.parts.flatMap((p) => p.lines), pol, names), parts: g.parts };
    const years = [...new Set(g.trace.map((x) => x.year))];
    const traceRows = g.trace.slice().sort((a, b) => years.indexOf(a.year) - years.indexOf(b.year) || a.contract.localeCompare(b.contract));
    const traceTbl = traceRows.length ? h('details', { class: 'basis' }, h('summary', null, `前期以前のどの仕訳から生じたか（年度別：${years.length}年度・${traceRows.length}行）`),
      h('div', { class: 'tbl-wrap scroll-y' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, ['年度', '元の仕訳', '契約', '科目', '借方', '貸方'].map((t) => h('th', null, t)))),
        h('tbody', null, years.flatMap((y) => {
          const rs = traceRows.filter((x) => x.year === y);
          return [...rs.map((x) => h('tr', null, h('td', { class: 'nw' }, x.year), h('td', { class: 'small' }, x.note), h('td', { class: 'nw' }, x.contract), h('td', null, accountLabel({ acc: x.acc, meta: {} }, pol, names)), amt(x.amt > 0 ? x.amt : null), amt(x.amt < 0 ? -x.amt : null))),
            h('tr', { class: 'total' }, h('td', null, `${y} 計`), h('td'), h('td'), h('td'), amt(rs.filter((x) => x.amt > 0).reduce((a, x) => a + x.amt, 0)), amt(-rs.filter((x) => x.amt < 0).reduce((a, x) => a + x.amt, 0)))];
        }))))) : (g.j0.tpl === 'M-01O' ? h('p', { class: 'muted small' }, '手入力仕訳（翌期以降も引き継ぐ設定）の開始仕訳です。') : null);
    return h('div', { class: 'next-open' }, journalCard(agg, { pol, names, companies }, {}), traceTbl);
  });
  return h('section', { class: 'card', id: 'next-opening' }, h('h2', null, `翌期の開始仕訳（${np.label}の期首）：${list.length}本`),
    h('div', { class: 'alert alert-info' }, `${period.label}末の残高を翌期に引き継ぐ開始仕訳です。内容別・会社別に作成し、損益の科目は利益剰余金期首に置き換えています。各仕訳の「前期以前のどの仕訳から生じたか」で、年度別の内訳（元の仕訳・契約・科目）を確認できます。「繰越なし」の内容は含みません。`),
    h('div', { class: 'journals' }, cardsEl));
}

/** 科目別集計表（内容別）：科目×仕訳の内容。借方＋／貸方△ */
function summaryCard(js, ctx) {
  const { pol, names, companies, period } = ctx;
  const cols = [...new Map([...js].sort(contentOrder).map((j) => [contentKey(j), j])).values()];
  const accs = new Map();
  for (const j of js) for (const l of j.lines) {
    const a = accountLabel(l, pol, names);
    const row = accs.get(a) || accs.set(a, { label: a, type: ACCOUNTS[l.acc]?.type, acc: l.acc, v: {}, items: {} }).get(a);
    const k = contentKey(j);
    row.v[k] = (row.v[k] || 0) + l.amt;
    (row.items[k] ||= []).push({ contract: j.manual ? `手入力 ${j.id}` : j.contractId, co: l.co, amt: l.amt, pair: pairLabel(j, companies) });
  }
  const order = Object.keys(ACCOUNTS);
  const rows = [...accs.values()].sort((a, b) => (a.type === b.type ? order.indexOf(a.acc) - order.indexOf(b.acc) : a.type === 'BS' ? -1 : 1));
  for (const r of rows) r.total = Object.values(r.v).reduce((a, x) => a + x, 0);
  const coName = (code) => (code === 'CONSOL' ? '連結' : companies.find((c) => c.code === code)?.name || code);
  const info = (r, k, title) => () => {
    const items = k ? r.items[k] || [] : Object.values(r.items).flat();
    return { context: `科目別集計表・${period.label}`, title: `${r.label}：${title}`, value: k ? r.v[k] || 0 : r.total,
      breakdown: { title: `会社・契約ごとの内訳（${items.length}件）`, cols: [{ label: '会社', key: 'coName' }, { label: '契約', key: 'contract' }, { label: '金額', key: 'amt', num: true }], rows: [...items.map((x) => ({ ...x, coName: coName(x.co) })), { coName: '合計', contract: '', amt: items.reduce((a, x) => a + x.amt, 0), total: true }] },
      sources: [{ label: '仕訳', kind: 'journal' }],
      links: [{ label: `元帳（${r.label}）`, go: () => focusJournals({ account: r.label }) }, ...(k ? [{ label: `仕訳帳（${k}）`, go: () => focusJournals({ content: k }) }] : [])] };
  };
  const tcols = [
    { label: '科目', render: (r) => h('td', null, r.label, h('span', { class: 'co' }, r.type === 'PL' ? '損益' : '貸借')) },
    ...cols.map((j) => ({ label: `${contentKey(j).replace(':', '・')} ${contentName(j).replace(/^開始仕訳：/, '開始：').replace(/^洗替：/, '洗替：').slice(0, 16)}`, title: contentName(j), num: true, render: (r) => r.v[contentKey(j)] ?? null, calc: (r) => info(r, contentKey(j), contentName(j))() })),
    { label: '合計', render: (r) => amt(r.total, { strong: true, calc: info(r, null, '合計') }) },
  ];
  const exportSum = () => download(`科目別集計表_${period.label}.csv`, toCsv([['科目', ...cols.map((j) => `${contentKey(j)} ${contentName(j)}`), '合計'], ...rows.map((r) => [r.label, ...cols.map((j) => r.v[contentKey(j)] ?? ''), r.total])]), 'text/csv;charset=utf-8');
  return h('section', { class: 'card', id: 'account-summary' }, h('h2', null, '科目別集計表（仕訳の内容別、借方＋／貸方△）'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: exportSum } }, '集計表を書き出す（CSV）'), h('span', { class: 'muted small' }, '表示中の条件（区分・内容・契約）の仕訳を集計しています。金額を押すと会社・契約ごとの内訳と、元帳・仕訳帳へのリンクを表示します。')),
    rows.length ? table(tcols, rows, { className: 'sum-table' }) : emptyState('該当する仕訳はありません'));
}

/** 元帳（勘定科目別）：T勘定と明細 */
function ledgerCard(js, ctx) {
  const { pol, names, companies } = ctx;
  const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const accLabels = [...new Set(js.flatMap((j) => j.lines.map((l) => accountLabel(l, pol, names))))].sort();
  const tSel = h('label', null, '科目 ', select([['', '— 科目を選択 —'], ...accLabels.map((a) => [a, a])], filter.account, (v) => { filter.account = v; rerender(); }));
  if (!filter.account) return h('section', { class: 'card', id: 'ledger' }, h('h2', null, '元帳（勘定科目別の明細）'), tSel, emptyState('科目を選ぶと、借方・貸方の明細を元帳（T勘定）形式で表示します。'));
  const coName = (code) => (code === 'CONSOL' ? '連結' : companies.find((c) => c.code === code)?.name || code);
  const items = [...js].sort(contentOrder).flatMap((j) => j.lines.filter((l) => accountLabel(l, pol, names) === filter.account).map((l) => ({ j, l })));
  const td = items.filter((x) => x.l.amt > 0).reduce((a, x) => a + x.l.amt, 0), tc = -items.filter((x) => x.l.amt < 0).reduce((a, x) => a + x.l.amt, 0);
  let bal = 0;
  const rows = items.map(({ j, l }) => { bal += l.amt; return h('tr', null, h('td', { class: 'nw' }, j.src ? `${j.tpl}・${j.src}` : j.tpl), h('td', null, contentName(j)), h('td', { class: 'nw' }, j.manual ? '手入力' : j.contractId), h('td', null, coName(l.co)), amt(l.amt > 0 ? l.amt : null), amt(l.amt < 0 ? -l.amt : null), amt(bal)); });
  return h('section', { class: 'card', id: 'ledger' }, h('h2', null, `元帳：${filter.account}`), tSel,
    h('div', { class: 't-account' },
      h('div', { class: 't-body' }, h('div', null, h('div', { class: 't-head' }, '借方'), h('div', { class: 't-total' }, `計 ${fmt(td)}`)), h('div', null, h('div', { class: 't-head' }, '貸方'), h('div', { class: 't-total' }, `計 ${fmt(tc)}`))),
      h('div', { class: 't-net' }, `純額：${td >= tc ? '借方' : '貸方'} ${fmt(Math.abs(td - tc))}`)),
    h('div', { class: 'tbl-wrap scroll-y' }, h('table', { class: 'tbl compact' },
      h('thead', null, h('tr', null, ['内容', '仕訳', '契約', '会社', '借方', '貸方', '残高（借方＋）'].map((t) => h('th', null, t)))),
      h('tbody', null, rows, h('tr', { class: 'total' }, h('td', null, '合計'), h('td'), h('td'), h('td'), amt(td), amt(tc), amt(td - tc))))));
}

/** 手入力仕訳（理由必須・監査ログ記録） */
function manualCard(ctx) {
  const { data, period, companies } = ctx;
  const draft = { title: '', contractId: '', kind: 'CON', carry: 'none', reason: '', evidence: '', lines: [{ acc: 'MANUAL_PL', label: '', co: 'CONSOL', dr: '', cr: '' }, { acc: 'MANUAL', label: '', co: 'CONSOL', dr: '', cr: '' }] };
  const accOpts = [['MANUAL_PL', '（科目名を入力：損益計算書）'], ['MANUAL', '（科目名を入力：貸借対照表）'], ...Object.entries(ACCOUNTS).filter(([k]) => k !== 'MANUAL' && k !== 'MANUAL_PL').map(([k, v]) => [k, `${v.name}（${v.type === 'PL' ? '損益' : '貸借'}）`])];
  const coOpts = [['CONSOL', '連結'], ...companies.map((c) => [c.code, `${c.code} ${c.name}`])];
  const body = h('tbody');
  const bal = h('span', { class: 'muted' });
  const recalc = () => {
    const d = draft.lines.reduce((a, l) => a + (Number(l.dr) || 0), 0), c = draft.lines.reduce((a, l) => a + (Number(l.cr) || 0), 0);
    bal.textContent = `借方 ${fmt(d)} ／ 貸方 ${fmt(c)} ${d === c && d > 0 ? '（一致）' : '（不一致）'}`;
  };
  const drawRows = () => {
    body.replaceChildren(...draft.lines.map((l, i) => h('tr', null,
      h('td', null, select(accOpts, l.acc, (v) => { l.acc = v; })),
      h('td', null, h('input', { type: 'text', maxlength: 60, value: l.label, placeholder: '手入力科目のときの科目名', 'aria-label': '科目名', on: { input: (e) => { l.label = e.target.value; } } })),
      h('td', null, select(coOpts, l.co, (v) => { l.co = v; })),
      h('td', null, h('input', { type: 'number', min: 0, step: 1, value: l.dr, 'aria-label': '借方', on: { input: (e) => { l.dr = e.target.value; recalc(); } } })),
      h('td', null, h('input', { type: 'number', min: 0, step: 1, value: l.cr, 'aria-label': '貸方', on: { input: (e) => { l.cr = e.target.value; recalc(); } } })),
      h('td', null, h('button', { class: 'btn-link danger', type: 'button', on: { click: () => { draft.lines.splice(i, 1); drawRows(); recalc(); } } }, '削除')))));
  };
  drawRows();
  recalc();
  const save = () => {
    const isFree = (a) => a === 'MANUAL' || a === 'MANUAL_PL';
    const lines = draft.lines.map((l) => ({ acc: l.acc, label: isFree(l.acc) ? l.label.trim() : '', co: l.co, amt: Math.round((Number(l.dr) || 0) - (Number(l.cr) || 0)) })).filter((l) => l.amt);
    const total = lines.reduce((a, l) => a + l.amt, 0);
    if (!draft.reason.trim()) return toast('理由は必須です', 'error');
    if (lines.length < 2 || total !== 0) return toast('借方と貸方の合計が一致していません', 'error');
    if (lines.some((l) => isFree(l.acc) && !l.label)) return toast('手入力科目の科目名を入力してください', 'error');
    const m = sanitizeManual({ id: `M-${Date.now()}`, periodStart: indexToYm(period.start), periodEnd: indexToYm(period.end), kind: draft.kind, carry: draft.carry, contractId: draft.contractId, title: draft.title || '手入力仕訳', reason: draft.reason, evidence: draft.evidence, createdAt: new Date().toISOString(), lines });
    update((d) => { d.manualJournals = [...(d.manualJournals || []), m]; }, '手入力仕訳追加', `${period.label} ${m.title}：${m.reason}`);
    toast('手入力仕訳を追加しました');
  };
  const existing = (data.manualJournals || []).filter((m) => m.periodStart >= indexToYm(period.start) && m.periodEnd <= indexToYm(period.end));
  return card('手入力仕訳（理由必須・監査ログに記録）',
    h('div', { class: 'alert alert-info' }, '自動作成の対象外の調整（棚卸資産に含まれる償却費、変動リース料・非リース構成部分、決算日差異の調整など）を入力します。選択中の期間に計上され、精算表・期間確定の対象になります。年度の表示には、その年度内の四半期に入力した仕訳も含まれます。手入力仕訳には税効果・非支配株主持分の按分は自動計算されないため、必要なら別の行で入力してください。'),
    existing.length ? h('ul', null, existing.map((m) => h('li', null, `${m.title}（${m.reason}）`, ' ', h('button', { class: 'btn-link danger', type: 'button', on: { click: async () => {
      const why = await ask({ title: `手入力仕訳「${m.title}」を削除しますか？`, message: '削除の理由は監査ログに記録されます。', input: '削除の理由（必須）', okLabel: '削除する', danger: true });
      if (!why) return;
      update((d) => { d.manualJournals = d.manualJournals.filter((x) => x.id !== m.id); }, '手入力仕訳削除', `${m.title}：${why.slice(0, 200)}`);
    } } }, '削除')))) : null,
    h('details', null, h('summary', null, '手入力仕訳を追加する'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', null, '摘要'), h('input', { type: 'text', maxlength: 100, on: { input: (e) => { draft.title = e.target.value; } } })),
        h('div', { class: 'field' }, h('label', null, '関連する契約（任意）'), select([['', '—'], ...data.contracts.map((c) => [c.id, `${c.id} ${c.name}`])], '', (v) => { draft.contractId = v; })),
        h('div', { class: 'field' }, h('label', null, '理由（必須）'), h('input', { type: 'text', maxlength: 1000, on: { input: (e) => { draft.reason = e.target.value; } } })),
        h('div', { class: 'field' }, h('label', null, '区分'), select([['CON', '連結修正'], ['IND', '個社修正']], 'CON', (v) => { draft.kind = v; })),
        h('div', { class: 'field' }, h('label', null, '翌期以降の扱い'), select([['none', '当期のみ（翌期は再計上しない）'], ['carry', '翌期以降も開始仕訳として引き継ぐ（損益は利益剰余金期首へ）']], 'none', (v) => { draft.carry = v; })),
        h('div', { class: 'field' }, h('label', null, '証憑・計算資料'), h('input', { type: 'text', maxlength: 300, on: { input: (e) => { draft.evidence = e.target.value; } } }))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl compact' }, h('thead', null, h('tr', null, ['科目', '科目名（手入力科目）', '会社', '借方', '貸方', ''].map((t) => h('th', null, t)))), body)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => { draft.lines.push({ acc: 'MANUAL', label: '', co: 'CONSOL', dr: '', cr: '' }); drawRows(); } } }, '＋ 行を追加'), bal,
        h('button', { class: 'btn btn-primary', type: 'button', on: { click: save } }, '保存'))));
}

function exportCsv(js, ctx) {
  const { pol, names, companies, period } = ctx;
  const rows = [['期間', '仕訳ID', '区分', 'テンプレート', '摘要', '契約', '貸手', '借手', '貸借', '科目キー', '科目', '会社', '金額', '根拠']];
  for (const j of js) {
    for (const l of j.lines) {
      rows.push([period.label, j.id, j.kind === 'IND' ? '個社修正' : '連結修正', j.src ? `${j.tpl}・${j.src}` : j.tpl, j.title, j.contractId, j.lessorCo, j.lesseeCo, l.amt > 0 ? '借方' : '貸方', l.acc, accountLabel(l, pol, names), l.co === 'CONSOL' ? '連結' : l.co, Math.abs(l.amt), (l.bases || []).slice(0, 3).join(' / ')]);
    }
  }
  download(`仕訳帳_${period.label}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
}
