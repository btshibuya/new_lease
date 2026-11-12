import { h, card, select, download, toast, ask, table, amt } from '../dom.js';
import { journalCard, kpi, emptyState, groupJournals, contentKey, contentName, contentOrder, pairLabel, aggregateLines } from '../components.js';
import { update } from '../store.js';
import { TEMPLATES, CARRY_DEFS, CARRY_MODES, carryModeOf, carryWarnings, generateAll, openingTrace, overrideKey, overrideDiff, overrideSuggestions } from '../../engine/elimination.js';
import { goTo, chooseAndGo, rememberReturn, setRestoreHook } from '../nav.js';
import { guard } from '../app.js';
import { setReportUnit } from './contracts.js';
import { openCalc } from '../panel.js';
import { accountLabel, ACCOUNTS } from '../../engine/accounts.js';
import { toCsv, sanitizeManual } from '../../engine/data.js';
import { fmt, indexToYm, indexToJp } from '../../engine/util.js';

// 表示の状態（画面を移っても保つ）
const filter = { kind: 'all', contract: 'all', content: 'all', account: '', mode: 'contract', q: '', company: 'all' };
const MODES = [['contract', '契約単位'], ['company', '会社単位'], ['total', '合計']];
// 「元の画面へ戻る」で仕訳帳の絞り込みも戻す
setRestoreHook({ save: () => ({ ...filter }), load: (x) => Object.assign(filter, x) });

/** 他の画面（連結精算表など）から、条件を指定して仕訳帳・元帳を開く */
export function focusJournals(opts = {}) {
  guard(() => {
    rememberReturn();
    Object.assign(filter, { kind: 'all', contract: 'all', content: 'all', account: '', q: '', company: 'all' }, opts);
    if (location.hash === '#journals') window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = '#journals';
    setTimeout(() => document.getElementById(opts.account ? 'ledger' : 'journal-book')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  });
}

export function renderJournals(ctx) {
  const { gen, pol, names, companies, period, data } = ctx;
  // 会社マスタで削除・コード変更された会社が選んだままになっていたら、すべての会社に戻す
  if (filter.company !== 'all' && filter.company !== 'CONSOL' && !companies.some((c) => c.code === filter.company)) filter.company = 'all';
  const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const match = (j) => (filter.kind === 'all' || j.kind === filter.kind) && (filter.contract === 'all' || j.contractId === filter.contract) && (filter.content === 'all' || contentKey(j) === filter.content || (j.src || j.tpl) === filter.content || (filter.content === 'OPEN' && (String(j.tpl).startsWith('C-01') || j.tpl === 'M-01O')));
  // 金額・科目名で探す：帳簿の金額（桁区切り・△可）または科目名の一部から、その金額・科目を含む仕訳を逆引きする
  const qNum = (() => { const t = filter.q.replace(/[,，\s円]/g, '').replace(/^[△▲-]/, ''); return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null; })();
  const qHit = (j) => !filter.q || j.lines.some((l) => (qNum !== null ? Math.abs(l.amt) === qNum : accountLabel(l, pol, names).includes(filter.q.trim())));
  // 会社で抽出：その会社の行を含む仕訳。集計・元帳・CSV はその会社の行だけ（連結＝会社に属さない組替の行）
  const lineOk = (l) => filter.company === 'all' || l.co === filter.company;
  const js = gen.journals.filter((j) => match(j) && qHit(j) && j.lines.some(lineOk));
  const lines = js.flatMap((j) => j.lines).filter(lineOk);
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
    h('label', null, '会社 ', select([['all', 'すべての会社'], ...companies.map((c) => [c.code, `${c.code} ${c.name}`]), ['CONSOL', '連結（会社に属さない組替）']], filter.company, (v) => { filter.company = v; rerender(); })),
    h('label', null, '契約 ', select([['all', 'すべて'], ...data.contracts.map((c) => [c.id, `${c.id} ${c.name}`])], filter.contract, (v) => { filter.contract = v; rerender(); })),
    h('label', null, '金額・科目で探す ', h('input', { type: 'search', value: filter.q, placeholder: '例）4,580 または リース負債に係る利息費用', 'aria-label': '金額・科目で探す', class: 'q-input', on: { change: (e) => { filter.q = e.target.value; rerender(); } } })),
    filter.q ? h('span', { class: 'muted small' }, `「${filter.q}」を含む仕訳 ${js.length}本`, ' ', h('button', { class: 'btn-link', type: 'button', on: { click: () => { filter.q = ''; rerender(); } } }, '解除')) : null,
    h('button', { class: 'btn', type: 'button', on: { click: () => exportCsv(js, ctx, lineOk) } }, filter.company === 'all' ? '仕訳帳を書き出す（CSV）' : '仕訳帳を書き出す（CSV：この会社の行）'));

  // 金額の確認からのリンク：元帳と、その行（科目・会社）に金額のある契約の登録画面。6件以上なら候補から選ぶ
  const links = (l, j) => {
    const label = accountLabel(l, pol, names);
    const parts = j ? (j.parts || [j]).filter((p) => p.lines.some((x) => accountLabel(x, pol, names) === label && x.co === l.co && x.amt)) : [];
    const t = contractTargets({ parts }, data);
    return [{ label: `元帳（${label}）`, go: () => focusJournals({ account: label }) },
      ...(t.length <= 5 ? t.map((x) => ({ label: `契約の登録（${x.contractId}）`, go: () => goTo(x) })) : [{ label: `契約の登録（${t.length}件から選ぶ）`, go: () => chooseAndGo(`契約（物件）の登録画面へ：${label}`, t) }])];
  };
  const grouped = groupJournals(js, filter.mode, ctx);
  const opening = grouped.filter((j) => String(j.tpl).startsWith('C-01') || j.tpl === 'M-01O');
  const current = grouped.filter((j) => !opening.includes(j));
  // 各仕訳：根拠の画面へ（候補が複数なら選ぶ）、金額の手修正（契約単位の自動作成の仕訳のみ）
  const actions = (j) => [
    contractButton(j, data),
    h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => chooseAndGo(`根拠の画面へ：${j.src ? `${j.tpl}・${j.src}` : j.tpl} ${j.title}`, relatedCandidates(j, ctx)) } }, '根拠の画面へ'),
    !j.parts && !j.manual && !j.carriedOverride ? h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => editOverride(j, ctx) } }, j.override ? '手修正を編集' : '金額を修正') : null,
  ];
  const qMatch = (l) => (qNum !== null ? Math.abs(l.amt) === qNum : accountLabel(l, pol, names).includes(filter.q.trim()));
  const hl = filter.q || filter.company !== 'all' ? (l) => (!filter.q || qMatch(l)) && lineOk(l) : null;
  const cards = (arr) => h('div', { class: 'journals' }, arr.map((j) => journalCard(j, { pol, names, companies }, { links, actions, hl, notice: (x) => overrideNotice(x, ctx) })));
  const modeNote = { contract: '契約ごとに、内容別の仕訳を表示しています。', company: '内容ごとに、会社（貸手→借手の組合せ。個社修正は会社）単位で合算して表示しています。', total: '内容ごとに、全契約を合算して表示しています。「会社別・契約別の内訳を表示」でドリルダウンできます。' }[filter.mode];

  return h('div', { class: 'page' },
    h('div', { class: 'kpi' },
      kpi('仕訳本数', `${grouped.length} 本`, filter.mode === 'contract' ? `個社修正 ${js.filter((j) => j.kind === 'IND').length}／連結修正 ${js.filter((j) => j.kind === 'CON').length}` : `元の仕訳 ${js.length} 本を合算`),
      kpi(filter.company === 'all' ? '借方合計 ／ 貸方合計' : `借方合計 ／ 貸方合計（${filter.company === 'CONSOL' ? '連結' : filter.company} の行）`, `${fmt(dr)} ／ ${fmt(cr)}`, filter.company === 'all' ? (dr === cr ? '一致' : '不一致') : '会社の行だけのため一致しないことがあります（仕訳全体では一致）'),
      kpi('当期の損益への影響（税引前）', fmt(pl), '表示中の仕訳による連結利益の増減'),
      kpi('法人税等調整額', fmt(tax), '＋は税金費用の増加')),
    card(null, controls, filterChips(data), h('p', { class: 'muted small' }, modeNote)),
    carryCard(ctx),
    h('section', { class: 'card', id: 'journal-book' }, h('h2', null, `当期の仕訳（${period.label}）`),
      opening.length ? h('h3', null, `開始仕訳（前期末からの繰越）・洗替：${opening.length}本`) : null,
      opening.length ? cards(opening) : null,
      h('h3', null, `当期の仕訳：${current.length}本`),
      current.length ? cards(current) : emptyState('該当する仕訳はありません')),
    nextOpeningCard(ctx, match),
    summaryCard(js, ctx, lineOk),
    ledgerCard(js, ctx, lineOk),
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
  // 累計（期首から）の表示では、翌期＝次の年度（期首が同じ次の累計期間の開始仕訳は当期と同じになるため）
  if (period.ytd) {
    if (period.end === period.fyEnd) {
      const y = ctx.yearPeriods.find((p) => p.start === period.fyEnd + 1);
      return y || { start: period.fyEnd + 1, end: period.fyEnd + 12, label: '翌年度', fyEnd: period.fyEnd + 12 };
    }
    // 年度の途中までの累計：その末の残高を引き継ぐ翌月首の開始仕訳（参考）
    return { start: period.end + 1, end: period.end + 1, label: `${indexToJp(period.end + 1)}（参考）`, fyEnd: period.fyEnd };
  }
  if (periods[periodIndex + 1]) return periods[periodIndex + 1];
  const len = period.end - period.start + 1;
  return { start: period.end + 1, end: period.end + len, label: `${period.label}の翌期`, fyEnd: period.fyEnd + (len === 12 ? 12 : 0) };
}

/** 翌期の開始仕訳：内容別・会社別に作成し、前期以前のどの年度の仕訳から生じたかをトレースする */
const nextMemo = new WeakMap(); // スケジュールの計算結果（データの版ごと）→ 期間 → 翌期の仕訳
function nextOpeningCard(ctx, match) {
  const { data, pol, names, companies, schedCache, yearPeriods, period } = ctx;
  const np = nextPeriodOf(ctx);
  let gen2;
  // 翌期の仕訳は、同じデータ（スケジュールの計算結果）・同じ期間なら使い回す（絞り込みの変更のたびに計算し直さない）
  const memo = nextMemo.get(schedCache) || nextMemo.set(schedCache, new Map()).get(schedCache);
  const mk = `${np.start}|${np.end}|${np.ytd ? 1 : 0}`;
  try { gen2 = memo.get(mk) || memo.set(mk, generateAll(data, np, pol, { schedCache })).get(mk); } catch (e) { return card('翌期の開始仕訳', h('div', { class: 'alert alert-err' }, e.message)); }
  const opens = gen2.journals.filter((j) => ['C-01', 'C-01T', 'C-01N', 'M-01O'].includes(j.tpl) && (filter.contract === 'all' || j.contractId === filter.contract) && (filter.kind === 'all' || j.kind === filter.kind));
  if (!opens.length) return card(`翌期の開始仕訳（${np.label}の期首）`, emptyState(pol['POL-03'] === 'balance' ? '会計方針 POL-03 が「期末残高一括消去」のため、開始仕訳は作りません。' : '翌期に引き継ぐ仕訳はありません。'));
  // 会社別：すべての会社を表示するときは、連結（CONSOL）の行をその仕訳の貸手の会社に含める（組替の相手勘定のため、貸借がそろう）。
  // 会社で絞り込むときは、当期の仕訳・精算表と同じく行の会社（l.co）で分ける（連結の行は「連結」を選ぶと表示）
  const coOf = filter.company === 'all' ? (j, l) => (l.co === 'CONSOL' ? j.lessorCo || 'CONSOL' : l.co) : (j, l) => l.co;
  const groups = new Map();
  for (const j of opens) {
    const r = gen2.results.find((x) => x.contract.id === j.contractId);
    const tr = r && j.src ? openingTrace(r, j, yearPeriods, pol, companies) : [];
    for (const co of [...new Set(j.lines.map((l) => coOf(j, l)))]) {
      if (filter.company !== 'all' && co !== filter.company) continue;
      const k = `${contentKey(j)}|${co}`;
      const g = groups.get(k) || groups.set(k, { j0: j, co, parts: [], trace: [] }).get(k);
      g.parts.push({ ...j, company: co, lines: j.lines.filter((l) => coOf(j, l) === co) });
      g.trace.push(...tr.filter((x) => coOf(j, x) === co).map((x) => ({ ...x, contract: j.contractId })));
    }
  }
  const list = [...groups.values()].filter((g) => filter.company === 'all' || g.co === filter.company).sort((a, b) => contentOrder(a.j0, b.j0) || String(a.co).localeCompare(String(b.co)));
  const coName = (code) => (code === 'CONSOL' ? '連結' : companies.find((c) => c.code === code)?.name || code);
  const cardsEl = list.map((g) => {
    const lines = aggregateLines(g.parts.flatMap((p) => p.lines), pol, names);
    const partial = lines.reduce((a, l) => a + l.amt, 0) !== 0; // 会社で絞り込み、相手の行が別の会社・連結にある
    const agg = { id: `N-${contentKey(g.j0)}-${g.co}`, tpl: g.j0.tpl, src: g.j0.src, kind: g.j0.kind, title: contentName(g.j0), company: g.co, groupLabel: `${coName(g.co)}：${g.parts.length}契約`, lines, parts: g.parts, partial };
    const years = [...new Set(g.trace.map((x) => x.year))];
    const traceRows = g.trace.slice().sort((a, b) => years.indexOf(a.year) - years.indexOf(b.year) || a.contract.localeCompare(b.contract));
    // 年度別の内訳の表は、開いたときに作る（翌期の開始仕訳は本数が多く、すべて作ると表示が遅くなるため）
    const traceBody = () => h('div', { class: 'tbl-wrap scroll-y' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, ['年度', '元の仕訳', '契約', '科目', '借方', '貸方'].map((t) => h('th', null, t)))),
        h('tbody', null, years.flatMap((y) => {
          const rs = traceRows.filter((x) => x.year === y);
          return [...rs.map((x) => h('tr', null, h('td', { class: 'nw' }, x.year), h('td', { class: 'small' }, x.note), h('td', { class: 'nw' }, x.contract), h('td', null, accountLabel({ acc: x.acc, meta: {} }, pol, names)), amt(x.amt > 0 ? x.amt : null), amt(x.amt < 0 ? -x.amt : null))),
            h('tr', { class: 'total' }, h('td', null, `${y} 計`), h('td'), h('td'), h('td'), amt(rs.filter((x) => x.amt > 0).reduce((a, x) => a + x.amt, 0)), amt(-rs.filter((x) => x.amt < 0).reduce((a, x) => a + x.amt, 0)))];
        }))));
    const traceTbl = traceRows.length ? h('details', { class: 'basis', on: { toggle: (e) => { const d = e.currentTarget; if (d.open && !d.dataset.built) { d.dataset.built = '1'; d.append(traceBody()); } } } }, h('summary', null, `前期以前のどの仕訳から生じたか（年度別：${years.length}年度・${traceRows.length}行）`)) : (g.j0.tpl === 'M-01O' ? h('p', { class: 'muted small' }, '手入力仕訳（翌期以降も引き継ぐ設定）の開始仕訳です。') : null);
    return h('div', { class: 'next-open' }, journalCard(agg, { pol, names, companies }, {}), traceTbl);
  });
  return h('section', { class: 'card', id: 'next-opening' }, h('h2', null, `翌期の開始仕訳（${np.label}の期首）：${list.length}本`),
    h('div', { class: 'alert alert-info' }, `${period.label}末の残高を翌期に引き継ぐ開始仕訳です。内容別・会社別に作成し、損益の科目は利益剰余金期首に置き換えています。各仕訳の「前期以前のどの仕訳から生じたか」で、年度別の内訳（元の仕訳・契約・科目）を確認できます。「繰越なし」の内容は含みません。`),
    h('div', { class: 'journals' }, cardsEl));
}

/** 科目別集計表（内容別）：科目×仕訳の内容。借方＋／貸方△ */
function summaryCard(js, ctx, lineOk = () => true) {
  const { pol, names, companies, period } = ctx;
  const cols = [...new Map([...js].sort(contentOrder).map((j) => [contentKey(j), j])).values()];
  const accs = new Map();
  for (const j of js) for (const l of j.lines.filter(lineOk)) {
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
function ledgerCard(js, ctx, lineOk = () => true) {
  const { pol, names, companies } = ctx;
  const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const accLabels = [...new Set(js.flatMap((j) => j.lines.filter(lineOk).map((l) => accountLabel(l, pol, names))))].sort();
  const tSel = h('label', null, '科目 ', select([['', '— 科目を選択 —'], ...accLabels.map((a) => [a, a])], filter.account, (v) => { filter.account = v; rerender(); }));
  if (!filter.account) return h('section', { class: 'card', id: 'ledger' }, h('h2', null, '元帳（勘定科目別の明細）'), tSel, emptyState('科目を選ぶと、借方・貸方の明細を元帳（T勘定）形式で表示します。'));
  const coName = (code) => (code === 'CONSOL' ? '連結' : companies.find((c) => c.code === code)?.name || code);
  const items = [...js].sort(contentOrder).flatMap((j) => j.lines.filter((l) => lineOk(l) && accountLabel(l, pol, names) === filter.account).map((l) => ({ j, l })));
  const td = items.filter((x) => x.l.amt > 0).reduce((a, x) => a + x.l.amt, 0), tc = -items.filter((x) => x.l.amt < 0).reduce((a, x) => a + x.l.amt, 0);
  let bal = 0;
  const rows = items.map(({ j, l }) => { bal += l.amt; return h('tr', null, h('td', { class: 'nw' }, j.src ? `${j.tpl}・${j.src}` : j.tpl), h('td', null, contentName(j)), h('td', { class: 'nw' }, j.manual || !j.contractId || j.contractId === '—' ? '手入力' : h('button', { class: 'btn-link contract-link', type: 'button', title: '契約の登録画面を開く', on: { click: () => goTo({ page: 'contracts', contractId: j.contractId, target: 'contract-editor' }) } }, j.contractId)), h('td', null, coName(l.co)), amt(l.amt > 0 ? l.amt : null), amt(l.amt < 0 ? -l.amt : null), amt(bal)); });
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

function exportCsv(js, ctx, lineOk = () => true) {
  const { pol, names, companies, period } = ctx;
  const rows = [['期間', '仕訳ID', '区分', 'テンプレート', '摘要', '契約', '貸手', '借手', '貸借', '科目キー', '科目', '会社', '金額', '根拠']];
  for (const j of js) {
    for (const l of j.lines.filter(lineOk)) {
      rows.push([period.label, j.id, j.kind === 'IND' ? '個社修正' : '連結修正', j.src ? `${j.tpl}・${j.src}` : j.tpl, j.title, j.contractId, j.lessorCo, j.lesseeCo, l.amt > 0 ? '借方' : '貸方', l.acc, accountLabel(l, pol, names), l.co === 'CONSOL' ? '連結' : l.co, Math.abs(l.amt), (l.bases || []).slice(0, 3).join(' / ')]);
    }
  }
  const co = filter.company === 'all' ? '' : `_${filter.company}`;
  download(`仕訳帳_${period.label}${co}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
}

// ── 仕訳の手修正・根拠の画面への移動 ──

/** 仕訳の内容ごとの、根拠となる画面（候補） */
const RELATED = {
  'C-02': ['contract', 'yearly', 'pay', 'pol:POL-07'],
  'C-03': ['contract', 'monthly', 'pol:POL-06'],
  'C-04': ['contract', 'yearly', 'monthly', 'pay', 'pol:POL-09'],
  'C-17': ['contract', 'monthly'],
  'C-20': ['mods', 'contract', 'monthly'],
  'C-10': ['yearly', 'pay', 'check:CHK-14'],
  'C-11': ['contract', 'pol:POL-04'],
  'C-12': ['contract', 'pol:POL-05'],
  'C-13': ['tax', 'coTax', 'pol:POL-02', 'check:CHK-11'],
  'C-14': ['nci', 'coNci', 'pol:POL-01', 'check:CHK-11'],
  'IND-01': ['coLegacy', 'contract'],
  'IND-02': ['coLegacy', 'yearly'],
};

export function relatedCandidates(j, ctx) {
  const K = j.src || j.tpl;
  const keys = [...(RELATED[K] || ['contract'])];
  const cids = [...new Set((j.parts || [j]).filter((p) => !p.manual).map((p) => p.contractId))].filter((x) => x && x !== '—');
  const out = [];
  if (String(j.tpl).startsWith('C-01') && j.tpl !== 'C-01R' && !j.parts && !j.carriedOverride) out.push({ title: '開始仕訳の年度別内訳（前期以前のどの仕訳から生じたか）', desc: '右の「計算の確認」に表示', go: () => showTrace(j, ctx) });
  const perContract = (cid) => ({
    contract: { title: `契約情報：${cid}`, desc: '契約の編集画面', page: 'contracts', contractId: cid, target: 'contract-editor' },
    yearly: { title: `返済スケジュール（年度別サマリー）：${cid}`, desc: '期首・期末のリース負債、利息、元本、流動部分', page: 'contracts', contractId: cid, target: 'contract-yearly' },
    // 月次の表で開く（直前に年度表示にしていても月ごとの明細に着地するように）
    monthly: { title: `償却・返済の月次スケジュール：${cid}`, desc: '月ごとの支払・利息・償却費・残高・イベント', go: () => { setReportUnit('month'); goTo({ page: 'contracts', contractId: cid, target: 'contract-monthly' }); } },
    pay: { title: `返済スケジュール（支払額）の手修正：${cid}`, desc: '支払月ごとの支払額', page: 'contracts', contractId: cid, target: 'payment-schedule' },
    mods: { title: `条件変更・再測定：${cid}`, desc: '契約の編集画面の条件変更', page: 'contracts', contractId: cid, label: '条件変更・再測定（変更月の月初から適用）' },
  });
  for (const k of keys) {
    if (perContract('x')[k]) for (const cid of cids.slice(0, 8)) out.push(perContract(cid)[k]);
    else if (k === 'tax') out.push({ title: '税効果のプルーフ', desc: '会社別の純資産修正額 × 法定実効税率（期首・期末）', page: 'worksheet', target: 'tax-proof' });
    else if (k === 'nci') out.push({ title: '非支配株主持分のプルーフ', desc: '税効果後の修正額 × 借手の非支配株主持分比率', page: 'worksheet', target: 'nci-proof' });
    else if (k === 'coTax') out.push({ title: '会社マスタ：法定実効税率・繰延税金資産の計上割合', page: 'companies', label: '法定実効税率（％）' });
    else if (k === 'coNci') out.push({ title: '会社マスタ：非支配株主持分比率', page: 'companies', label: '非支配株主持分比率（％）' });
    else if (k === 'coLegacy') out.push({ title: '会社マスタ：旧科目名・流動区分', page: 'companies', label: '旧科目名を使用' });
    else if (k.startsWith('pol:')) out.push({ title: `会計方針 ${k.slice(4)}`, desc: '選択肢と根拠', page: 'policies', target: k.slice(4) });
    else if (k.startsWith('check:')) out.push({ title: `検算 ${k.slice(6)}`, desc: '独立計算との比較', page: 'checks', target: k.slice(6) });
  }
  if (j.override) for (const s of overrideSuggestions(overrideDiff({ lines: j.lines, orig: j.origLines }))) out.unshift({ title: `修正候補：${s.label}`, desc: `手修正した科目に関係する項目（${s.why}）`, page: s.page, contractId: s.page === 'contracts' ? j.contractId : undefined, label: s.target ? undefined : s.label, target: s.target });
  return out;
}

/** 開始仕訳の年度別内訳を「計算の確認」に表示 */
function showTrace(j, ctx) {
  const r = ctx.gen.results.find((x) => x.contract.id === j.contractId);
  if (!r) return;
  const tr = openingTrace(r, j, ctx.yearPeriods, ctx.pol, ctx.companies);
  const coName = (code) => (code === 'CONSOL' ? '連結' : ctx.companies.find((c) => c.code === code)?.name || code);
  openCalc({ fresh: true, context: `${j.title}（${j.contractId}）`, title: '開始仕訳の年度別内訳', value: j.lines.filter((l) => l.amt > 0).reduce((a, l) => a + l.amt, 0),
    breakdown: { title: `前期以前の仕訳（${tr.length}行）`, cols: [{ label: '年度', key: 'year' }, { label: '科目', key: 'accName' }, { label: '会社', key: 'coName' }, { label: '金額（借方＋）', key: 'amt', num: true }], rows: tr.map((x) => ({ ...x, accName: accountLabel({ acc: x.acc, meta: {} }, ctx.pol, ctx.names), coName: coName(x.co) })) },
    notes: [...new Set(tr.map((x) => x.note))].slice(0, 10), sources: [{ label: '前期末からの繰越', kind: 'carry' }] });
}

/** 手修正した仕訳の注意書き：差額・契約情報の修正候補（押すと該当箇所へ移動）・元に戻す */
export function overrideNotice(j, ctx) {
  if (j.carriedOverride) return h('div', { class: 'alert alert-warn ov-notice' }, '前期以前に手修正した仕訳の差額（手修正後−修正前）を、開始仕訳で引き継いでいます。元の手修正を取り消すと、この仕訳もなくなります。');
  if (!j.override) return null;
  const { pol, names, companies } = ctx;
  const diff = overrideDiff({ lines: j.lines, orig: j.origLines });
  const sug = overrideSuggestions(diff);
  const coName = (code) => (code === 'CONSOL' ? '連結' : companies.find((c) => c.code === code)?.name || code);
  return h('div', { class: 'alert alert-warn ov-notice' },
    h('div', null, h('b', null, '手修正あり：'), `理由「${j.override.reason}」（${j.override.at || ''}）。修正前との差額：`, diff.map((d) => `${accountLabel({ acc: d.acc, meta: j.lines.find((l) => l.acc === d.acc)?.meta || {} }, pol, names)}（${coName(d.co)}）${d.amt > 0 ? '＋' : ''}${fmt(d.amt)}`).join('、') || 'なし'),
    j.override.stale ? h('div', null, h('b', null, '注意：'), '手修正したあとに、元の計算（契約・会計方針など）が変わりました。手修正を見直してください。') : null,
    sug.length ? h('div', null, h('b', null, '契約情報等の修正候補：'), '仕訳の金額だけを直すと、翌期以降の計算・注記・検算と食い違います。可能なら次の項目を直して、手修正を元に戻してください。') : null,
    h('div', { class: 'actions' },
      ...sug.map((s) => h('button', { class: 'btn btn-sm', type: 'button', title: s.why, on: { click: () => goTo({ page: s.page, contractId: s.page === 'contracts' ? j.contractId : undefined, label: s.target ? undefined : s.label, target: s.target }) } }, `${s.page === 'companies' ? '会社マスタ：' : ''}${s.label} →`)),
      h('button', { class: 'btn btn-sm btn-danger', type: 'button', on: { click: async () => {
        if (!(await ask({ title: '手修正を元に戻しますか？', message: 'アプリの計算値に戻します。翌期以降の開始仕訳への引継もなくなります。', okLabel: '元に戻す', danger: true }))) return;
        update((d) => { d.overrides.journals = (d.overrides.journals || []).filter((o) => o.key !== j.override.key); }, '仕訳の手修正の取消', `${j.contractId} ${j.tpl}${j.src ? `・${j.src}` : ''}`);
        toast('元に戻しました');
      } } }, '手修正を元に戻す')));
}

/** 仕訳の金額の手修正（貸借一致・理由必須。監査ログに記録） */
export function editOverride(j, ctx) {
  const { pol, names, companies, period } = ctx;
  const orig = j.origLines || j.lines;
  const rows = j.lines.map((l) => ({ acc: l.acc, co: l.co, meta: l.meta, dr: l.amt > 0 ? l.amt : '', cr: l.amt < 0 ? -l.amt : '' }));
  const accOpts = Object.entries(ACCOUNTS).filter(([k]) => !['MANUAL', 'MANUAL_PL'].includes(k)).map(([k, v]) => [k, v.name]);
  const coOpts = [['CONSOL', '連結'], ...companies.map((c) => [c.code, `${c.code} ${c.name}`])];
  const body = h('tbody');
  const bal = h('div', { class: 'muted' });
  const recalc = () => {
    const d = rows.reduce((a, r) => a + (Number(r.dr) || 0), 0), c = rows.reduce((a, r) => a + (Number(r.cr) || 0), 0);
    bal.textContent = `借方 ${fmt(d)} ／ 貸方 ${fmt(c)}${d === c ? '（一致）' : `（差額 ${fmt(d - c)}）`}`;
    bal.className = d === c ? 'muted' : 'red';
  };
  const draw = () => {
    body.replaceChildren(...rows.map((r, i) => h('tr', null,
      h('td', null, r.fixed !== false && orig.some((o) => o.acc === r.acc && o.co === r.co) ? accountLabel({ acc: r.acc, meta: r.meta || {} }, pol, names) : select(accOpts, r.acc, (v) => { r.acc = v; })),
      h('td', null, orig.some((o) => o.acc === r.acc && o.co === r.co) && r.fixed !== false ? (r.co === 'CONSOL' ? '連結' : r.co) : select(coOpts, r.co, (v) => { r.co = v; })),
      h('td', null, h('input', { type: 'number', step: 'any', min: 0, value: r.dr, 'aria-label': '借方', on: { input: (e) => { r.dr = e.target.value; recalc(); } } })),
      h('td', null, h('input', { type: 'number', step: 'any', min: 0, value: r.cr, 'aria-label': '貸方', on: { input: (e) => { r.cr = e.target.value; recalc(); } } })),
      h('td', { class: 'small muted' }, (() => { const o = orig.filter((x) => x.acc === r.acc && x.co === r.co).reduce((a, x) => a + x.amt, 0); return o ? `計算値 ${o > 0 ? '借' : '貸'} ${fmt(Math.abs(o))}` : '（追加）'; })()),
      h('td', null, h('button', { class: 'btn-link danger', type: 'button', on: { click: () => { rows.splice(i, 1); draw(); recalc(); } } }, '削除')))));
  };
  draw(); recalc();
  const reason = h('textarea', { rows: 2, maxlength: 300, placeholder: '例）借手の帳簿の利息と端数処理が異なるため帳簿に合わせた', 'aria-label': '手修正の理由' });
  reason.value = j.override?.reason || '';
  let overlay;
  const close = () => overlay.remove();
  const save = () => {
    const lines = rows.map((r) => ({ acc: r.acc, co: r.co, amt: (Number(r.dr) || 0) - (Number(r.cr) || 0) })).filter((l) => l.amt);
    const sum = lines.reduce((a, l) => a + l.amt, 0);
    if (sum !== 0) return toast('借方と貸方の合計を一致させてください', 'error');
    if (!reason.value.trim()) return toast('手修正の理由を入力してください', 'error');
    const key = overrideKey(period, j);
    const rec = { key, periodStart: indexToYm(period.start), periodEnd: indexToYm(period.end), contractId: j.contractId, tpl: j.tpl, src: j.src || '', lines, orig: orig.map((l) => ({ acc: l.acc, co: l.co, amt: l.amt })), reason: reason.value.trim(), at: new Date().toLocaleString('ja-JP') };
    update((d) => { d.overrides = d.overrides || { journals: [] }; d.overrides.journals = [...(d.overrides.journals || []).filter((o) => o.key !== key), rec]; }, '仕訳の手修正', `${j.contractId} ${j.tpl}${j.src ? `・${j.src}` : ''}（${period.label}）：${reason.value.trim().slice(0, 80)}`);
    close();
    toast('手修正を保存しました。契約情報の修正候補を確認してください');
  };
  const box = h('div', { class: 'modal ask', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ov-title' },
    h('div', { class: 'modal-head' }, h('b', { id: 'ov-title' }, `仕訳の金額を修正：${j.tpl}${j.src ? `・${j.src}` : ''} ${j.title}（${j.contractId}・${period.label}）`)),
    h('p', { class: 'ask-msg' }, 'この期間のこの仕訳だけを修正します（繰越ありの内容は、差額を翌期以降の開始仕訳に引き継ぎます）。仕訳の金額だけを直すと契約情報と食い違うため、保存後に表示される「契約情報等の修正候補」も確認してください。'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl compact ov-table' }, h('thead', null, h('tr', null, ['科目', '会社', '借方', '貸方', '修正前', ''].map((t) => h('th', null, t)))), body)),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => { rows.push({ acc: 'LL_NC', co: j.lesseeCo || 'CONSOL', dr: '', cr: '', fixed: false }); draw(); } } }, '＋ 行を追加'), bal),
    h('label', { class: 'fg-label' }, '手修正の理由（必須・監査ログに記録）'), reason,
    h('div', { class: 'row ask-actions' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', on: { click: close } }, 'キャンセル'), h('button', { class: 'btn btn-primary', type: 'button', on: { click: save } }, '保存')));
  overlay = h('div', { class: 'modal-bg', on: { keydown: (e) => { if (e.key === 'Escape') close(); } } }, box);
  document.body.appendChild(overlay);
  box.querySelector('input')?.focus();
}

/** 仕訳に紐づく契約（物件）の登録画面への移動先 */
function contractTargets(j, data) {
  const ids = [...new Set((j.parts || [j]).filter((p) => !p.manual && p.contractId && p.contractId !== '—').map((p) => p.contractId))];
  return ids.map((id) => ({ page: 'contracts', contractId: id, target: 'contract-editor', title: `契約の登録：${id} ${data.contracts.find((c) => c.id === id)?.name || ''}`, desc: '契約（物件）の登録・編集画面' }));
}
function contractButton(j, data) {
  const t = contractTargets(j, data);
  if (!t.length) return null;
  return h('button', { class: 'btn btn-sm', type: 'button', title: '仕訳に紐づく契約（物件）の登録画面を開く', on: { click: () => chooseAndGo('契約（物件）の登録画面へ', t) } }, t.length === 1 ? `契約 ${t[0].contractId} を開く` : `契約を開く（${t.length}件）`);
}

/** 絞り込み中の条件をチップで表示し、1つずつ・まとめて解除できるようにする（ジャンプで来たときに条件が分かるように） */
function filterChips(data) {
  const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const chips = [];
  const chip = (label, clear) => chips.push(h('span', { class: 'chip filter-chip' }, label, h('button', { class: 'chip-x', type: 'button', 'aria-label': `${label} を解除`, on: { click: () => { clear(); rerender(); } } }, '×')));
  if (filter.kind !== 'all') chip(`区分：${filter.kind === 'IND' ? '個社修正' : '連結修正'}`, () => { filter.kind = 'all'; });
  if (filter.content !== 'all') chip(`内容：${filter.content === 'OPEN' ? '開始仕訳・洗替' : filter.content.replace(':', '・')}`, () => { filter.content = 'all'; });
  if (filter.company !== 'all') chip(`会社：${filter.company === 'CONSOL' ? '連結（会社に属さない組替）' : `${filter.company} ${data.companies.find((c) => c.code === filter.company)?.name || ''}`}`, () => { filter.company = 'all'; });
  if (filter.contract !== 'all') chip(`契約：${filter.contract} ${data.contracts.find((c) => c.id === filter.contract)?.name || ''}`, () => { filter.contract = 'all'; });
  if (filter.q) chip(`金額・科目：${filter.q}`, () => { filter.q = ''; });
  if (filter.account) chip(`元帳の科目：${filter.account}`, () => { filter.account = ''; });
  if (!chips.length) return null;
  return h('div', { class: 'filter-chips', role: 'group', 'aria-label': '絞り込み中の条件' }, h('span', { class: 'small muted' }, '絞り込み中：'), ...chips,
    chips.length > 1 ? h('button', { class: 'btn-link', type: 'button', on: { click: () => { Object.assign(filter, { kind: 'all', content: 'all', contract: 'all', q: '', account: '', company: 'all' }); rerender(); } } }, 'すべて解除') : null);
}
