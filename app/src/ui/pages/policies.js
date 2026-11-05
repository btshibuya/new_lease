import { h, card, table, statusBadge, toast } from '../dom.js';
import { journalCard, COLORS } from '../components.js';
import { barChart } from '../charts.js';
import { state, update } from '../store.js';
import { POLICIES, defaultPolicies } from '../../engine/policies.js';
import { generateAll } from '../../engine/elimination.js';
import { buildSchedule } from '../../engine/schedule.js';
import { cashFlowEliminations, worksheet } from '../../engine/reports.js';
import { plSection, accountLabel } from '../../engine/accounts.js';
import { buildPeriods, ymToIndex } from '../../engine/util.js';

/** 設例用のデータ（親会社P→60%子会社S、5年・年1回後払1,000、割引率3%） */
function demoData(kind) {
  const monthly = kind === 'rate' || kind === 'rounding';
  return {
    config: { unit: '千円', fyeMonth: 3, accountNames: {} },
    companies: [
      { code: 'P', name: '親会社P', isParent: true, fyeMonth: 3, taxRate: 0.3, nciRatio: 0, taxEffect: true },
      { code: 'S', name: kind === 'asc842' ? '在外子会社S（60%・US GAAP）' : '子会社S（60%）', fyeMonth: 3, taxRate: 0.3, nciRatio: 0.4, taxEffect: true, splitsCurrent: true },
    ],
    contracts: [{
      id: '設例', name: '設例', lessorCo: 'P', lesseeCo: 'S', assetClass: 'building', commencement: '2027-04', termMonths: 60,
      frequencyMonths: monthly ? 1 : kind === 'asc842' ? 3 : 12, timing: 'arrears', payment: monthly ? 100 : kind === 'asc842' ? 250 : 1000, freePayments: 0, steps: [], terminationYm: null,
      lessee: { model: kind === 'asc842' ? 'asc842ol' : 'jgaap', rate: 0.03, idc: kind === 'idc' ? 100 : 0, dept: kind === 'depReclass' ? 'mfg' : 'sga', liabilityOverride: null, depMonths: null, transition: { method: 'none' } },
      lessor: { assetId: 'A', assetCost: 6000, assetLifeMonths: 120, assetStart: '2027-04', ratio: 1, incClass: kind === 'depReclass' ? 'nonop' : 'sales', depClass: kind === 'depReclass' ? 'nonop' : 'cogs' },
      actuals: {},
    }],
    manualJournals: [],
  };
}
const FY = buildPeriods(ymToIndex('2027-04'), ymToIndex('2032-03'), 3, 'year');
const DEMO_NOTE = { idc: '、初期直接費用100', rate: '（月払100）', rounding: '（月払100）', asc842: '（四半期払250、借手はASC842）' };

const TPLS = {
  nci: ['C-01N', 'C-14', 'C-BN'], tax: ['C-01T', 'C-13', 'C-BT'], format: null, reclass: ['C-11'], depReclass: ['C-12'],
  presentation: ['C-01', 'C-03'], idc: ['C-02', 'C-03'], cf: [], asc842: ['C-02', 'C-04'],
};

const sum = (o) => Object.values(o).reduce((a, v) => a + v, 0);

function yearlyEffects(d, pol) {
  return FY.map((p) => {
    const r = generateAll(d, p, pol).results[0];
    const pre = sum(r.E.close) - sum(r.E.open);
    const tax = sum(r.DT.close) - sum(r.DT.open);
    const nci = sum(r.NCI.close) - sum(r.NCI.open);
    return { label: p.label.replace('年', '/').replace('月期', ''), pre, tax, after: pre - tax, nci, parent: pre - tax - nci };
  });
}

/** 自社データ（選択中の期間）で、選択肢ごとの影響額を比較 */
function impactTable(def, ctx) {
  const { data, period } = ctx;
  if (!data.contracts.length) return null;
  const needFresh = ['POL-10', 'POL-11'].includes(def.id);
  const rows = def.options.map((o) => {
    const pol = { ...state.policies, [def.id]: o.value };
    const g = generateAll(data, period, pol, needFresh ? {} : { schedCache: ctx.schedCache });
    const pre = g.results.reduce((a, r) => a + sum(r.E.close) - sum(r.E.open), 0);
    const tax = g.results.reduce((a, r) => a + sum(r.DT.close) - sum(r.DT.open), 0);
    // 非支配株主に帰属する当期純利益は仕訳（NCI_PL）から集計（持分変動の資本剰余金分を含めない）
    const nci = g.journals.flatMap((j) => j.lines).filter((l) => l.acc === 'NCI_PL').reduce((a, l) => a + l.amt, 0);
    const eq = g.results.reduce((a, r) => a + sum(r.E.close) - sum(r.DT.close), 0);
    // 連結損益計算書の区分別・連結貸借対照表の表示科目別の連結後金額（グループ内リース関連）
    const ws = worksheet(g, data.companies, pol, ctx.names, period);
    const sec = {};
    const bs = {};
    for (const w of ws) {
      if (w.type === 'PL') { const k = plSection({ acc: w.acc, meta: w.meta || {} }) || 'その他'; sec[k] = (sec[k] || 0) - w.consol; }
      else if (w.consol) bs[w.label] = (bs[w.label] || 0) + w.consol;
    }
    return { label: o.label, cur: o.value === state.policies[def.id], pre, tax, parent: pre - tax - nci, nci, eq, n: g.journals.length, sec, bs };
  });
  const base = rows.find((r) => r.cur);
  return h('div', { class: 'impact' },
    table([
      { label: '選択肢', render: (r) => h('td', null, r.label, r.cur ? h('span', { class: 'co' }, '選択中') : null) },
      { label: '連結損益への影響（税引前）', key: 'pre', num: true },
      { label: '法人税等調整額', key: 'tax', num: true },
      { label: '非支配株主に帰属', key: 'nci', num: true },
      { label: '親会社株主に帰属', key: 'parent', num: true },
      { label: '期末の純資産への影響（税引後）', key: 'eq', num: true },
      { label: '選択中との差（親会社株主帰属）', num: true, render: (r) => r.parent - base.parent },
      { label: '仕訳本数', key: 'n', num: true },
    ], rows, { className: 'compact' }),
    h('div', { class: 'sub-title' }, '連結財務諸表の表示への影響（グループ内リース関連の連結後金額）'),
    (() => {
      const secs = [...new Set(rows.flatMap((r) => Object.keys(r.sec)))];
      const bsKeys = [...new Set(rows.flatMap((r) => Object.keys(r.bs)))];
      const data2 = [...secs.map((k) => ({ item: `損益：${k}（＋は利益の増加）`, v: rows.map((r) => r.sec[k] || 0) })), ...bsKeys.map((k) => ({ item: `貸借：${k}`, v: rows.map((r) => r.bs[k] || 0) }))].filter((x) => x.v.some((v) => v !== x.v[0]) || ['POL-04', 'POL-05', 'POL-06'].includes(def.id));
      if (!data2.length) return h('p', { class: 'muted small' }, '表示区分の違いはありません（損益の金額のみが異なる論点です）');
      return table([{ label: '項目', key: 'item' }, ...rows.map((r, i) => ({ label: r.label.slice(0, 18), num: true, render: (x) => x.v[i] }))], data2, { className: 'compact' });
    })());
}

/** 開いたときに初めて計算する折りたたみ（画面の初期表示を速くする） */
function lazyDetails(cls, title, build) {
  const d = h('details', { class: cls }, h('summary', null, title));
  let done = false;
  d.addEventListener('toggle', () => {
    if (!d.open || done) return;
    done = true;
    try { d.append(build()); } catch (e) { d.append(h('div', { class: 'error' }, `計算できませんでした：${e.message}`)); }
  });
  return d;
}

function textExample(title, ...body) {
  return h('details', { class: 'example' }, h('summary', null, title), h('div', { class: 'ex-text' }, ...body));
}

function exampleFor(def) {
  if (def.example === 'none') return null;
  if (def.example === 'fye') {
    return textExample('設例で選択肢を比較する',
      h('p', null, '設例：連結決算日3月末、借手の子会社は12月決算。2028年2月に新規のグループ内リース（負債1,000）を開始。'),
      table([{ label: '選択肢', key: 'a' }, { label: '子会社の数値の基準日', key: 'b' }, { label: '2月開始の契約の扱い', key: 'c' }], [
        { a: '重要な不一致のみ調整（既定）', b: '12月末（正規決算）', c: '借手の12月末の帳簿には未計上、貸手（3月決算）は2〜3月の受取リース料を計上 → 重要な不一致として調整（貸手側の計上を取り消す等）' },
        { a: '仮決算', b: '3月末', c: '両社とも3月末の数値で消去するため不一致は生じない' },
        { a: '調整しない', b: '12月末', c: '不一致は連結上残る（重要性が乏しい場合のみ）' },
      ], { className: 'compact' }));
  }
  if (def.example === 'inventory') {
    return textExample('設例で選択肢を比較する',
      h('p', null, '設例：借手（製造子会社）の使用権資産の償却費 年1,000、貸手の減価償却費（連結上の原価）年600。期末在庫に含まれる製造原価の割合 10%。'),
      table([{ label: '項目', key: 'a' }, { label: '金額', key: 'b', num: true }], [
        { a: '借手が原価に算入した償却費のうち期末在庫に含まれる額（1,000×10%）', b: 100 },
        { a: '連結上の原価（貸手の減価償却費）のうち期末在庫に含まれるべき額（600×10%）', b: 60 },
        { a: '棚卸資産の修正額（連結上の在庫を減額）', b: -40 },
      ], { className: 'compact' }),
      h('p', { class: 'help' }, '「手入力で調整」の場合は、仕訳画面の手入力仕訳で（借）売上原価 40 ／（貸）棚卸資産 40 のように計上します（翌期は戻し）。'));
  }
  return lazyDetails('example', '設例で選択肢を比較する（仕訳例・グラフ）', () => exampleGrid(def));
}

function exampleGrid(def) {
  const d = demoData(def.example);
  const cols = def.options.map((o) => {
    const pol = { ...state.policies, [def.id]: o.value };
    const per = def.example === 'idc' || def.example === 'asc842' ? FY[0] : FY[1];
    const g = generateAll(d, per, pol);
    const want = TPLS[def.example];
    const js = want === null ? g.journals.filter((j) => j.kind === 'CON') : want ? g.journals.filter((j) => want.includes(j.tpl)) : [];
    const parts = [h('div', { class: 'ex-head' }, h('span', { class: 'ex-opt' }, o.label), o.value === def.default ? statusBadge('ok', '既定値') : null)];
    parts.push(h('div', { class: 'muted small' }, `${per.label}（設例：親会社P→60%子会社S、5年、割引率3%${DEMO_NOTE[def.example] || '、年額1,000'}）`));
    const jctx = { pol, names: {}, companies: d.companies };
    if (js.length) js.forEach((j) => parts.push(journalCard(j, jctx, { hideContract: true, noBasis: true })));
    else if (want && want.length) parts.push(h('div', { class: 'empty small' }, 'この選択肢では該当する仕訳は作成されません'));
    if (['nci', 'tax', 'idc'].includes(def.example)) {
      const ye = yearlyEffects(d, pol);
      if (def.example === 'nci') parts.push(barChart({ title: '年度別：消去による損益影響（税引後）の帰属', labels: ye.map((r) => r.label), series: [{ name: '親会社株主', values: ye.map((r) => r.parent), color: COLORS.lessee }, { name: '非支配株主', values: ye.map((r) => r.nci), color: COLORS.lessor }], stacked: true, height: 220 }));
      else if (def.example === 'tax') parts.push(table([{ label: '年度', key: 'label' }, { label: '税引前影響', key: 'pre', num: true }, { label: '法人税等調整額', key: 'tax', num: true }, { label: '税引後影響', key: 'after', num: true }], ye, { className: 'compact' }));
      else parts.push(barChart({ title: '年度別：連結損益への影響（税引前）', labels: ye.map((r) => r.label), series: [{ name: '損益影響', values: ye.map((r) => r.pre), color: COLORS.diff }], height: 200 }));
    }
    if (def.example === 'depReclass') {
      const ws = worksheet(g, d.companies, pol, {}, per).filter((r) => r.type === 'PL' && r.consol !== 0);
      parts.push(table([{ label: '連結損益計算書の表示（グループ内リース関連）', key: 'label' }, { label: '連結後', num: true, render: (r) => r.consol }], ws, { className: 'compact' }));
    }
    if (def.example === 'cf') {
      const cf = cashFlowEliminations(g, pol, per);
      parts.push(table([{ label: '区分', key: 'section' }, { label: '項目', key: 'label' }, { label: '消去額', key: 'elim', num: true }], cf.items.filter((x) => x.elim), { className: 'compact' }));
    }
    if (def.example === 'rate' || def.example === 'rounding') {
      const sc = buildSchedule(d.contracts[0], pol);
      const m12 = sc.months.slice(0, 12);
      parts.push(table([{ label: '項目', key: 'a' }, { label: '金額', key: 'b', num: true }], [
        { a: '当初リース負債', b: sc.meta.L0 },
        { a: '1年目の支払利息', b: m12.reduce((a, x) => a + x.lessee.int, 0) },
        { a: '1年目末のリース負債', b: m12[11].lessee.L_end },
        { a: '利息総額', b: sc.meta.totalInterest },
        { a: '最終回の端数調整額', b: sc.meta.finalResidual || 0 },
      ], { className: 'compact' }));
    }
    return h('div', { class: `ex-col${o.value === state.policies[def.id] ? ' current' : ''}` }, ...parts);
  });
  return h('div', { class: 'ex-grid' }, cols);
}

function policyCard(def, ctx) {
  const cur = state.policies[def.id];
  const isDefault = cur === def.default;
  const name = `pol-${def.id}`;
  const recLabel = def.matchExisting ? '既定値（自社方針に合わせて選択）' : '推奨（既定値）';
  const opts = h('fieldset', { class: 'options' }, h('legend', null, def.question),
    def.options.map((o) => h('label', { class: `opt${o.value === cur ? ' checked' : ''}` },
      h('input', { type: 'radio', name, value: o.value, checked: o.value === cur, on: { change: () => {
        const before = def.options.find((x) => x.value === cur)?.label;
        update((_, pol) => { pol[def.id] = o.value; }, '会計方針変更', `${def.id} ${def.title}：「${before}」→「${o.label}」`);
        toast(`${def.id} を「${o.label}」に変更しました。すべての仕訳・検算に反映されています`);
      } } }),
      h('div', { class: 'opt-body' },
        h('div', { class: 'opt-label' }, o.label, o.value === def.default ? h('span', { class: 'rec' }, recLabel) : null),
        o.summary ? h('div', { class: 'opt-sum' }, o.summary) : null,
        h('div', { class: 'proscons' },
          o.pros?.length ? h('ul', { class: 'pros' }, o.pros.map((p) => h('li', null, p))) : null,
          o.cons?.length ? h('ul', { class: 'cons' }, o.cons.map((p) => h('li', null, p))) : null)))));
  const note = h('textarea', { rows: 3, maxlength: 4000, placeholder: '例）2027年10月 監査法人と協議済。○○の理由で既定値を採用。', value: state.data.notes[def.id] || '' });
  return h('section', { class: 'card policy', id: def.id },
    h('header', { class: 'policy-head' },
      h('span', { class: 'tpl' }, def.id), h('span', { class: 'chip' }, def.category), h('h2', null, def.title),
      isDefault ? statusBadge('ok', '既定値を選択中') : statusBadge('warn', '既定値から変更')),
    h('p', { class: 'bg' }, def.background),
    opts,
    def.options.length > 1 ? lazyDetails('example impact-box', `現在のデータでの影響を比較する（${ctx.period.label}・全契約）`, () => impactTable(def, ctx)) : null,
    h('div', { class: 'rationale' }, h('div', { class: 'sub-title' }, '既定値の根拠'), h('p', null, def.rationale),
      h('ul', { class: 'refs' }, def.references.map((r) => h('li', null, r.verified ? statusBadge('ok', '確認済') : statusBadge('warn', '要原文確認'), ' ', r.text)))),
    exampleFor(def),
    h('div', { class: 'note' }, h('div', { class: 'sub-title' }, '会計監査人との協議メモ（監査ログに記録）'), note,
      h('button', { class: 'btn', type: 'button', on: { click: () => update((d) => { d.notes[def.id] = note.value.slice(0, 4000); }, '協議メモ更新', def.id) } }, 'メモを保存')));
}

export function renderPolicies(ctx) {
  const pol = state.policies;
  const summary = table([
    { label: 'No.', render: (d) => h('td', null, h('a', { href: '#/policies', on: { click: (e) => { e.preventDefault(); document.getElementById(d.id)?.scrollIntoView({ behavior: 'smooth' }); } } }, d.id)) },
    { label: '区分', key: 'category' },
    { label: '論点', key: 'title' },
    { label: '現在の選択', render: (d) => d.options.find((o) => o.value === pol[d.id])?.label },
    { label: '状態', render: (d) => h('td', null, pol[d.id] === d.default ? statusBadge('ok', '既定値') : statusBadge('warn', '変更あり')) },
    { label: '協議メモ', render: (d) => (state.data.notes[d.id] ? '記入済' : '—') },
  ], POLICIES);
  return h('div', { class: 'page' },
    h('h1', null, '会計方針設定'),
    card(null,
      h('p', null, '要件定義書 第11章の「監査法人等と協議すべき論点」について、基準・適用指針・実務対応報告や公表解説をもとに最も適切と考えられる処理を既定値にしています。選択を変えると、すべての仕訳・精算表・検算に直ちに反映されます。各論点では、現在のデータでの影響額の比較と、設例（仕訳例・グラフ）を確認できます。'),
      h('p', { class: 'help' }, '「推奨（既定値）」は会計上の判断にもとづく推奨、「既定値（自社方針に合わせて選択）」は自社の既存方針・借手の計算方法に合わせて選ぶ論点の初期値です。「要原文確認」の参照は、条番号等を基準の原文で確認する必要があるものです。最終的な方針は会計監査人と協議のうえ決定し、協議メモに記録してください（変更履歴は監査ログに残ります）。'),
      summary,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => {
        if (!confirm('すべての会計方針を既定値に戻しますか？')) return;
        update((_, p) => Object.assign(p, defaultPolicies()), '会計方針変更', 'すべて既定値に戻しました');
      } } }, 'すべて既定値に戻す'))),
    ...POLICIES.map((d) => policyCard(d, ctx)));
}
