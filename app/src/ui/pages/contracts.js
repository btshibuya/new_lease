import { h, card, table, field, select, statusBadge, toast, amt } from '../dom.js';
import { COLORS, emptyState } from '../components.js';
import { gantt, barChart, lineChart } from '../charts.js';
import { state, update, setUi } from '../store.js';
import { validateContract, currentPortion } from '../../engine/schedule.js';
import { sanitizeContract } from '../../engine/data.js';
import { contractYearly } from '../../engine/reports.js';
import { ASSET_CLASSES, LESSEE_DEPT } from '../../engine/accounts.js';
import { fmt, ymToIndex, indexToJp, indexToYm, deepClone } from '../../engine/util.js';

const MODEL = { jgaap: '日本基準（IFRS第16号も同じ）', asc842ol: 'ASC第842号 オペレーティング・リース（単一費用）', offbalance: '短期・少額リース等（借手オフバランス）' };

function blankContract(data) {
  const lessor = data.companies.find((c) => c.isParent)?.code || data.companies[0]?.code || '';
  const lessee = data.companies.find((c) => c.code !== lessor)?.code || '';
  let n = data.contracts.length + 1;
  while (data.contracts.some((c) => c.id === `K-${String(n).padStart(3, '0')}`)) n++;
  return sanitizeContract({ id: `K-${String(n).padStart(3, '0')}`, name: '新規契約', lessorCo: lessor, lesseeCo: lessee, assetClass: 'building', commencement: '2027-04', termMonths: 60, frequencyMonths: 12, timing: 'arrears', payment: 1000, lessee: { model: 'jgaap', rate: 0.03, dept: 'sga' }, lessor: { assetId: '', assetCost: 0, ratio: 1 } });
}

export function renderContracts(ctx) {
  const { data, schedCache, period, yearPeriods } = ctx;
  const sel = state.ui.contractId && data.contracts.find((c) => c.id === state.ui.contractId);
  const co = (code) => data.companies.find((c) => c.code === code)?.name || code;

  const rows = data.contracts.map((c) => {
    const sc = schedCache.get(c.id);
    let start, end;
    try { start = ymToIndex(c.commencement); end = start + c.termMonths - 1; } catch { start = 0; end = 0; }
    const term = c.terminationYm ? ymToIndex(c.terminationYm) : null;
    return { label: `${c.id} ${c.name}`, start, end: term ?? end, termination: term, startLabel: indexToJp(start), endLabel: indexToJp(term ?? end), note: `${co(c.lessorCo)} → ${co(c.lesseeCo)}${term !== null ? '（中途解約）' : ''}`, onClick: () => setUi({ contractId: c.id }), color: sc ? 'var(--s1)' : 'var(--crit)' };
  });
  const minI = Math.min(...rows.map((r) => r.start), period.start);
  const maxI = Math.max(...rows.map((r) => r.end), period.end);
  const tl = rows.length ? gantt({ title: '契約タイムライン', subtitle: '帯：リース期間、✕：中途解約、網掛け：選択中の期間。行をクリックすると詳細を表示', rows, wide: true, min: minI, max: maxI, highlight: { start: period.start, end: period.end } }) : emptyState('契約がありません');

  const list = table([
    { label: '契約番号', render: (c) => h('td', null, h('a', { href: '#/contracts', on: { click: (e) => { e.preventDefault(); setUi({ contractId: c.id }); } } }, c.id)) },
    { label: '契約名', key: 'name' },
    { label: '貸手 → 借手', render: (c) => `${co(c.lessorCo)} → ${co(c.lesseeCo)}` },
    { label: '借手の会計モデル', render: (c) => MODEL[c.lessee.model] },
    { label: '開始', key: 'commencement' },
    { label: '期間', render: (c) => `${c.termMonths}か月` },
    { label: '1回リース料', num: true, render: (c) => c.payment },
    { label: '当初リース負債', num: true, render: (c) => schedCache.get(c.id)?.meta.L0 ?? null },
    { label: '入力検証', render: (c) => { const e = validateContract(c, data.companies); return h('td', null, e.length ? statusBadge('ng', `${e.length}件`) : statusBadge('ok')); } },
  ], data.contracts, { rowClass: (c) => (sel && c.id === sel.id ? 'selected' : '') });

  const actions = h('div', { class: 'actions' },
    h('button', { class: 'btn', type: 'button', on: { click: () => { const nc = blankContract(data); update((d) => d.contracts.push(nc), '契約追加', nc.id); setUi({ contractId: nc.id }); } } }, '＋ 契約を追加'));

  return h('div', { class: 'page' },
    h('h1', null, '契約・スケジュール'),
    card(null, tl),
    card('契約一覧', actions, list),
    sel ? renderDetail(sel, ctx) : card(null, emptyState('一覧またはタイムラインから契約を選ぶと、スケジュール・グラフ・編集画面を表示します。')));
}

function renderDetail(c, ctx) {
  const { data, schedCache, yearPeriods, unit } = ctx;
  const sc = schedCache.get(c.id);
  const errs = validateContract(c, data.companies);
  const parts = [h('h2', { class: 'section-title' }, `${c.id} ${c.name}`)];
  if (errs.length) parts.push(h('div', { class: 'alert' }, h('strong', null, '入力エラー：'), h('ul', null, errs.map((e) => h('li', null, e)))));
  if (sc) {
    const yr = contractYearly(sc, yearPeriods, currentPortion);
    const labels = yr.map((r) => r.label.replace('年', '/').replace('月期', ''));
    parts.push(h('div', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, 'リース負債の当初測定額'), h('div', { class: 'kpi-value' }, fmt(sc.meta.L0)), h('div', { class: 'kpi-sub' }, `割引率 ${(sc.meta.rate * 100).toFixed(3)}%（期間換算 ${(sc.meta.rp * 100).toFixed(4)}%）`)),
      h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, '使用権資産の取得原価'), h('div', { class: 'kpi-value' }, fmt(sc.meta.C0)), h('div', { class: 'kpi-sub' }, `うち初期直接費用 ${fmt(sc.meta.idc)}、償却 ${sc.meta.depMonths}か月`)),
      h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, 'リース料総額 ／ 利息総額'), h('div', { class: 'kpi-value' }, `${fmt(sc.meta.totalPayments)} ／ ${fmt(sc.meta.totalInterest)}`), h('div', { class: 'kpi-sub' }, `支払 ${sc.meta.K}回、最終回の端数調整 ${fmt(sc.meta.finalResidual || 0)}`))));
    parts.push(h('div', { class: 'grid2' },
      card(null, barChart({ title: '返済スケジュール（年度別）', subtitle: '棒：支払額の内訳（元本・利息）、線：年度末のリース負債残高', labels, series: [{ name: '元本返済', values: yr.map((r) => r.principal), color: COLORS.lessee }, { name: '利息', values: yr.map((r) => r.int), color: 'var(--s4)' }], stacked: true, line: { name: '期末リース負債', values: yr.map((r) => r.closeL), color: 'var(--s7)' }, unit })),
      card(null, lineChart({ title: '消去差額の発生の仕組み', subtitle: 'リース負債（実線）と使用権資産簿価（破線）の差が、連結上取り消す累積損益差', labels: ['開始', ...labels], series: [{ name: 'リース負債', values: [sc.meta.L0, ...yr.map((r) => r.closeL)], color: COLORS.lessee }, { name: '使用権資産簿価', values: [sc.meta.model === 'offbalance' ? 0 : sc.meta.C0, ...yr.map((r) => r.rouNet)], color: COLORS.lessor, dashed: true }], band: { upper: 0, lower: 1, name: '差額', color: COLORS.diff }, unit }))));
    parts.push(h('div', { class: 'grid2' },
      card(null, barChart({ title: '消去差額の推移（年度別）', subtitle: '棒：当期の連結損益への影響（借手費用−貸手収益−解約益−初期直接費用）、線：消去差額の累計（＝連結上の利益剰余金への影響）。期間終了時に0に戻ります', labels, series: [{ name: '当期差', values: yr.map((r) => r.plEffect), color: COLORS.diff }], line: { name: '消去差額（累計）', values: yr.map((r) => r.cumE), color: 'var(--s7)' }, unit })),
      card(null, barChart({ title: '借手の費用 vs 貸手の収益（年度別）', subtitle: '借手：減価償却費＋支払利息（逓減）、貸手：受取リース料（定額）。差が当期の連結損益への影響', labels, series: [{ name: '借手の費用', values: yr.map((r) => r.lesseeExp), color: COLORS.lessee }, { name: '貸手の収益', values: yr.map((r) => r.inc), color: COLORS.lessor }], unit }))));
    parts.push(card('年度別サマリー（要件定義書 第10章の表と同じ構成）', table([
      { label: '年度', key: 'label' },
      { label: '期首負債', key: 'openL', num: true },
      { label: '新規', key: 'newL', num: true },
      { label: '支払', key: 'pay', num: true },
      { label: '利息', key: 'int', num: true },
      { label: '元本', key: 'principal', num: true },
      { label: '期末負債', key: 'closeL', num: true },
      { label: 'うち流動', key: 'cur', num: true },
      { label: '使用権資産簿価', key: 'rouNet', num: true },
      { label: '償却費', key: 'dep', num: true },
      { label: '借手費用', key: 'lesseeExp', num: true },
      { label: '貸手収益', key: 'inc', num: true },
      { label: '当期差', key: 'diff', num: true },
      { label: '消去差額（累計）', key: 'cumE', num: true, title: 'リース負債＋未払−使用権資産簿価−貸手の未収' },
    ], yr)));
    parts.push(card(null, h('details', null, h('summary', null, `月次スケジュール（${sc.months.length}か月）を表示`), table([
      { label: '年月', render: (x) => indexToJp(x.m) },
      { label: '支払', num: true, render: (x) => x.lessee.pay || x.lessor.cash },
      { label: '利息', num: true, render: (x) => (x.lessee.int || 0) + (x.lessee.accr || 0) },
      { label: 'リース負債', num: true, render: (x) => x.lessee.L_end },
      { label: '償却費', num: true, render: (x) => x.lessee.dep },
      { label: '使用権資産簿価', num: true, render: (x) => (x.lessee.cost_end || 0) - (x.lessee.acc_end || 0) },
      { label: '受取リース料', num: true, render: (x) => x.lessor.inc },
      { label: '貸手の未収', num: true, render: (x) => x.lessor.R_end },
      { label: 'イベント', render: (x) => (x.lessee.commence ? '開始' : '') + (x.lessee.term ? (x.lessee.term.kind === 'termination' ? '中途解約' : '満了') : '') },
    ], sc.months, { className: 'compact' }))));
    parts.push(actualsCard(c, yr));
  }
  parts.push(editor(c, data));
  return h('div', { class: 'detail' }, ...parts);
}

function actualsCard(c, yr) {
  const draft = deepClone(c.actuals || {});
  const rows = yr.map((r) => {
    const key = indexToYm(r.end);
    const a = draft[key] || {};
    const inp = (f) => h('input', { type: 'number', step: 'any', value: a[f] ?? '', 'aria-label': `${r.label} ${f}`, on: { input: (e) => { draft[key] = draft[key] || {}; if (e.target.value === '') delete draft[key][f]; else draft[key][f] = Number(e.target.value); } } });
    const diff = (book, app) => (book === undefined || book === null ? h('td', { class: 'muted' }, '—') : Number(book) === app ? h('td', null, statusBadge('ok', '一致')) : h('td', null, statusBadge('ng', `差異 ${fmt(Number(book) - app)}`)));
    return h('tr', null, h('td', null, r.label),
      h('td', null, inp('L')), amt(r.closeL), diff(a.L, r.closeL),
      h('td', null, inp('rouNet')), amt(r.rouNet), diff(a.rouNet, r.rouNet),
      h('td', null, inp('inc')), amt(r.inc), diff(a.inc, r.inc));
  });
  return card('個別の帳簿残高（実績）との突合',
    h('p', { class: 'help' }, '借手・貸手の個別帳簿の金額を入力すると、アプリの計算値と比較します（検算 CHK-10）。差異があれば原因（割引率・支払条件・端数処理・計上漏れ等）を調査し、必要に応じて個社修正を行います。'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl compact' },
      h('thead', null, h('tr', null, h('th', null, '年度'), h('th', null, 'リース負債（帳簿）'), h('th', { class: 'num' }, '計算値'), h('th', null, '判定'), h('th', null, '使用権資産簿価（帳簿）'), h('th', { class: 'num' }, '計算値'), h('th', null, '判定'), h('th', null, '受取リース料（帳簿）'), h('th', { class: 'num' }, '計算値'), h('th', null, '判定'))),
      h('tbody', null, rows))),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => update((d) => { const t = d.contracts.find((x) => x.id === c.id); t.actuals = sanitizeContract({ ...t, actuals: draft }).actuals; }, '実績入力', c.id) } }, '実績を保存')));
}

function editor(c, data) {
  const f = deepClone(c);
  const num = (obj, key, opts = {}) => h('input', { type: 'number', step: opts.step || 'any', value: obj[key] ?? '', min: opts.min, on: { input: (e) => { obj[key] = e.target.value === '' ? (opts.nullable ? null : 0) : Number(e.target.value) * (opts.scale || 1); } } });
  const pct = (obj, key) => h('input', { type: 'number', step: 'any', value: obj[key] === null || obj[key] === undefined ? '' : +(obj[key] * 100).toFixed(6), on: { input: (e) => { obj[key] = e.target.value === '' ? 0 : Number(e.target.value) / 100; } } });
  const txt = (obj, key, max = 100) => h('input', { type: 'text', maxlength: max, value: obj[key] ?? '', on: { input: (e) => { obj[key] = e.target.value; } } });
  const month = (obj, key) => h('input', { type: 'month', value: obj[key] ?? '', on: { input: (e) => { obj[key] = e.target.value || null; } } });
  const sel = (obj, key, opts) => select(opts, obj[key], (v) => { obj[key] = isNaN(Number(v)) || v === '' ? v : (typeof obj[key] === 'number' ? Number(v) : v); });
  const coOpts = data.companies.map((x) => [x.code, `${x.code} ${x.name}`]);
  const stepsInput = h('input', { type: 'text', value: (f.steps || []).map((s) => `${s.fromPayment}:${s.amount}`).join(', '), placeholder: '例）25:55, 37:60', on: { input: (e) => {
    f.steps = e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [a, b] = x.split(':'); return { fromPayment: Number(a), amount: Number(b) }; });
  } } });
  if (!f.lessee.transition) f.lessee.transition = { method: 'none' };

  const grid = (...items) => h('div', { class: 'form-grid' }, ...items);
  const form = h('form', { class: 'form', on: { submit: (e) => {
    e.preventDefault();
    f.frequencyMonths = Number(f.frequencyMonths);
    const clean = sanitizeContract(f);
    const errs = validateContract(clean, data.companies);
    if (data.contracts.some((x) => x.id === clean.id && x.id !== c.id)) errs.push('契約番号が重複しています');
    if (errs.length) { toast(`保存できません：${errs[0]}${errs.length > 1 ? ` ほか${errs.length - 1}件` : ''}`, 'error'); return; }
    update((d) => { const i = d.contracts.findIndex((x) => x.id === c.id); d.contracts[i] = clean; }, '契約更新', `${c.id}${clean.id !== c.id ? `→${clean.id}` : ''}`);
    setUi({ contractId: clean.id });
    toast('保存しました');
  } } },
    h('fieldset', null, h('legend', null, '契約の基本情報'), grid(
      field('契約番号', txt(f, 'id', 30)), field('契約名', txt(f, 'name')),
      field('貸手会社', sel(f, 'lessorCo', coOpts)), field('借手会社', sel(f, 'lesseeCo', coOpts)),
      field('資産区分', sel(f, 'assetClass', Object.entries(ASSET_CLASSES))),
      field('リース開始年月', month(f, 'commencement')),
      field('リース期間（月数）', num(f, 'termMonths', { step: 1, min: 1 }), '延長・解約オプションの判断を反映した期間'),
      field('支払間隔', sel(f, 'frequencyMonths', [[1, '毎月'], [3, '四半期'], [6, '半年'], [12, '毎年']])),
      field('支払時期', sel(f, 'timing', [['arrears', '後払（各期間の末日）'], ['advance', '前払（各期間の初日）']])),
      field('1回あたりリース料', num(f, 'payment', { min: 0 }), '消費税・非リース構成部分を除く'),
      field('フリーレント（無償の支払回数）', num(f, 'freePayments', { step: 1, min: 0 })),
      field('段階賃料（支払回:金額）', stepsInput, '例）25回目から55 → 25:55'),
      field('中途解約年月（任意）', month(f, 'terminationYm'), '解約月の末日に借手が取崩し、貸手は未収を取崩し'))),
    h('fieldset', null, h('legend', null, '借手の情報（個別でオンバランス済みの内容）'), grid(
      field('借手の会計モデル', sel(f.lessee, 'model', Object.entries(MODEL))),
      field('割引率（年％）', pct(f.lessee, 'rate')),
      field('初期直接費用', num(f.lessee, 'idc', { min: 0 }), 'グループ外への支出（使用権資産に含めた額）'),
      field('使用部門', sel(f.lessee, 'dept', Object.entries(LESSEE_DEPT)), '貸手の減価償却費の組替先（POL-05）'),
      field('償却月数（空欄＝リース期間）', num(f.lessee, 'depMonths', { step: 1, nullable: true })),
      field('当初リース負債の取込値（空欄＝再計算）', num(f.lessee, 'liabilityOverride', { nullable: true }), '借手の帳簿値。再計算値との差は検算で表示'),
      field('適用初年度の経過措置', sel(f.lessee.transition, 'method', [['none', 'なし（適用後に開始・または完全遡及）'], ['cumulative', '累積的影響方式（使用権資産＝リース負債）']])),
      field('適用開始年月', month(f.lessee.transition, 'ym')),
      field('適用開始時の割引率（年％）', pct(f.lessee.transition, 'rate')))),
    h('fieldset', null, h('legend', null, '貸手の情報（オペレーティング・リース）'), grid(
      field('資産ID', txt(f.lessor, 'assetId', 30), '同じ資産を複数契約で使う場合は同じIDにし、按分比率を設定'),
      field('対象資産の取得原価', num(f.lessor, 'assetCost', { min: 0 })),
      field('耐用年数（月数）', num(f.lessor, 'assetLifeMonths', { step: 1, min: 0 })),
      field('取得年月', month(f.lessor, 'assetStart')),
      field('按分比率（％）', pct(f.lessor, 'ratio')),
      field('受取リース料の計上区分', sel(f.lessor, 'incClass', [['sales', '売上高'], ['nonop', '営業外収益']])),
      field('減価償却費の計上区分', sel(f.lessor, 'depClass', [['cogs', '売上原価（賃貸原価）'], ['nonop', '営業外費用']])))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'submit' }, '保存（入力検証あり）'),
      h('button', { class: 'btn', type: 'button', on: { click: () => { const copy = sanitizeContract({ ...deepClone(c), id: `${c.id}-copy` }); update((d) => d.contracts.push(copy), '契約複製', copy.id); setUi({ contractId: copy.id }); } } }, '複製'),
      h('button', { class: 'btn danger', type: 'button', on: { click: () => { if (confirm(`契約 ${c.id} を削除しますか？`)) { update((d) => { d.contracts = d.contracts.filter((x) => x.id !== c.id); }, '契約削除', c.id); setUi({ contractId: null }); } } } }, '削除')));
  return card('契約の編集', form);
}
