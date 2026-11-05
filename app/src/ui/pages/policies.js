import { h, card, table, statusBadge, toast } from '../dom.js';
import { journalCard, COLORS } from '../components.js';
import { barChart } from '../charts.js';
import { state, update } from '../store.js';
import { POLICIES, defaultPolicies } from '../../engine/policies.js';
import { generateAll } from '../../engine/elimination.js';
import { cashFlowEliminations, worksheet } from '../../engine/reports.js';
import { buildPeriods, ymToIndex, fmt } from '../../engine/util.js';

/** 設例用のデータ（親会社P→60%子会社S、5年・年1回後払1,000、割引率3%） */
function demoData(kind) {
  return {
    config: { unit: '千円', fyeMonth: 3, accountNames: {} },
    companies: [
      { code: 'P', name: '親会社P', isParent: true, fyeMonth: 3, taxRate: 0.3, nciRatio: 0, taxEffect: true },
      { code: 'S', name: '子会社S（60%）', fyeMonth: 3, taxRate: 0.3, nciRatio: 0.4, taxEffect: true, splitsCurrent: true },
    ],
    contracts: [{
      id: '設例', name: '設例', lessorCo: 'P', lesseeCo: 'S', assetClass: 'building', commencement: '2027-04', termMonths: 60, frequencyMonths: 12, timing: 'arrears', payment: 1000, freePayments: 0, steps: [], terminationYm: null,
      lessee: { model: 'jgaap', rate: 0.03, idc: kind === 'idc' ? 100 : 0, dept: kind === 'depReclass' ? 'mfg' : 'sga', liabilityOverride: null, depMonths: null, derecognizeAtExpiry: true, transition: { method: 'none' } },
      lessor: { assetId: 'A', assetCost: 6000, assetLifeMonths: 120, assetStart: '2027-04', ratio: 1, incClass: kind === 'depReclass' ? 'nonop' : 'sales', depClass: kind === 'depReclass' ? 'nonop' : 'cogs' },
      actuals: {},
    }],
  };
}
const FY = buildPeriods(ymToIndex('2027-04'), ymToIndex('2032-03'), 3, 'year');

const TPLS = {
  nci: ['C-01N', 'C-14', 'C-BN'], tax: ['C-01T', 'C-13', 'C-BT'], format: null, reclass: ['C-11'], depReclass: ['C-12'],
  presentation: ['C-01', 'C-03'], idc: ['C-02', 'C-03'], cf: [],
};

function yearlyEffects(d, pol) {
  return FY.map((p) => {
    const g = generateAll(d, p, pol);
    const r = g.results[0];
    const sum = (o) => Object.values(o).reduce((a, v) => a + v, 0);
    const pre = sum(r.E.close) - sum(r.E.open);
    const tax = sum(r.DT.close) - sum(r.DT.open);
    const nci = sum(r.NCI.close) - sum(r.NCI.open);
    return { label: p.label.replace('年', '/').replace('月期', ''), pre, tax, after: pre - tax, nci, parent: pre - tax - nci };
  });
}

function exampleFor(def, ctx) {
  if (def.example === 'none') return null;
  const d = demoData(def.example);
  const jctx = { pol: null, names: {}, companies: d.companies };
  const cols = def.options.map((o) => {
    const pol = { ...state.policies, [def.id]: o.value };
    const per = def.example === 'idc' ? FY[0] : FY[1];
    const g = generateAll(d, per, pol);
    const want = TPLS[def.example];
    const js = want === null ? g.journals.filter((j) => j.kind === 'CON') : g.journals.filter((j) => want.includes(j.tpl));
    const parts = [h('div', { class: 'ex-head' }, h('span', { class: 'ex-opt' }, o.label), o.value === def.default ? statusBadge('ok', '既定値') : null)];
    parts.push(h('div', { class: 'muted small' }, `仕訳例：${per.label}（設例：親会社P→60%子会社S、5年、年額1,000、割引率3%${def.example === 'idc' ? '、初期直接費用100' : ''}）`));
    if (js.length) js.forEach((j) => parts.push(journalCard(j, { ...jctx, pol }, { hideContract: true, noBasis: true })));
    else if (def.example !== 'cf') parts.push(h('div', { class: 'empty small' }, 'この選択肢では該当する仕訳は作成されません'));
    if (['nci', 'tax', 'idc'].includes(def.example)) {
      const ye = yearlyEffects(d, pol);
      if (def.example === 'nci') {
        parts.push(barChart({ title: '年度別：消去による損益影響（税引後）の帰属', labels: ye.map((r) => r.label), series: [{ name: '親会社株主', values: ye.map((r) => r.parent), color: COLORS.lessee }, { name: '非支配株主', values: ye.map((r) => r.nci), color: COLORS.lessor }], stacked: true, height: 220 }));
      } else if (def.example === 'tax') {
        parts.push(table([{ label: '年度', key: 'label' }, { label: '税引前影響', key: 'pre', num: true }, { label: '法人税等調整額', key: 'tax', num: true }, { label: '税引後影響', key: 'after', num: true }], ye, { className: 'compact' }));
      } else {
        parts.push(barChart({ title: '年度別：連結損益への影響（税引前）', labels: ye.map((r) => r.label), series: [{ name: '損益影響', values: ye.map((r) => r.pre), color: COLORS.diff }], height: 200 }));
      }
    }
    if (def.example === 'depReclass') {
      const ws = worksheet(g, d.companies, pol, {}, per).filter((r) => r.type === 'PL' && r.consol !== 0);
      parts.push(table([{ label: '連結損益計算書の表示（グループ内リース関連）', key: 'label' }, { label: '連結後', num: true, render: (r) => r.consol }], ws, { className: 'compact' }));
    }
    if (def.example === 'cf') {
      const cf = cashFlowEliminations(g, pol, per);
      parts.push(table([{ label: '区分', key: 'section' }, { label: '項目', key: 'label' }, { label: '消去額', key: 'elim', num: true }], cf.items.filter((x) => x.elim), { className: 'compact' }));
    }
    return h('div', { class: `ex-col${o.value === state.policies[def.id] ? ' current' : ''}` }, ...parts);
  });
  return h('details', { class: 'example' }, h('summary', null, '設例で選択肢を比較する（仕訳例・グラフ）'), h('div', { class: 'ex-grid' }, cols));
}

function policyCard(def, ctx) {
  const cur = state.policies[def.id];
  const isDefault = cur === def.default;
  const name = `pol-${def.id}`;
  const opts = h('fieldset', { class: 'options' }, h('legend', null, def.question),
    def.options.map((o) => h('label', { class: `opt${o.value === cur ? ' checked' : ''}` },
      h('input', { type: 'radio', name, value: o.value, checked: o.value === cur, on: { change: () => {
        const before = def.options.find((x) => x.value === cur)?.label;
        update((_, pol) => { pol[def.id] = o.value; }, '会計方針変更', `${def.id} ${def.title}：「${before}」→「${o.label}」`);
        toast(`${def.id} を「${o.label}」に変更しました。すべての仕訳・検算に反映されています`);
      } } }),
      h('div', { class: 'opt-body' },
        h('div', { class: 'opt-label' }, o.label, o.value === def.default ? h('span', { class: 'rec' }, '推奨（既定値）') : null),
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
    h('div', { class: 'rationale' }, h('div', { class: 'sub-title' }, '既定値の根拠'), h('p', null, def.rationale),
      h('ul', { class: 'refs' }, def.references.map((r) => h('li', null, r.verified ? statusBadge('ok', '確認済') : statusBadge('warn', '要原文確認'), ' ', r.text)))),
    exampleFor(def, ctx),
    h('div', { class: 'note' }, h('div', { class: 'sub-title' }, '会計監査人との協議メモ（監査ログに記録）'), note,
      h('button', { class: 'btn', type: 'button', on: { click: () => update((d) => { d.notes[def.id] = note.value.slice(0, 4000); }, '協議メモ更新', def.id) } }, 'メモを保存')));
}

export function renderPolicies(ctx) {
  const pol = state.policies;
  const summary = table([
    { label: 'No.', render: (d) => h('td', null, h('a', { href: `#/policies`, on: { click: (e) => { e.preventDefault(); document.getElementById(d.id)?.scrollIntoView({ behavior: 'smooth' }); } } }, d.id)) },
    { label: '区分', key: 'category' },
    { label: '論点', key: 'title' },
    { label: '現在の選択', render: (d) => d.options.find((o) => o.value === pol[d.id])?.label },
    { label: '状態', render: (d) => h('td', null, pol[d.id] === d.default ? statusBadge('ok', '既定値') : statusBadge('warn', '変更あり')) },
    { label: '協議メモ', render: (d) => (state.data.notes[d.id] ? '記入済' : '—') },
  ], POLICIES);
  return h('div', { class: 'page' },
    h('h1', null, '会計方針設定'),
    card(null,
      h('p', null, '要件定義書 第11章の「監査法人等と協議すべき論点」について、基準・適用指針・実務対応報告や公表解説をもとに最も適切と考えられる処理を既定値にしています。選択を変えると、すべての仕訳・精算表・検算に直ちに反映されます。各論点の「設例で比較する」で、選択肢ごとの仕訳例とグラフを確認できます。'),
      h('p', { class: 'help' }, '「要原文確認」の参照は、条番号等を基準の原文で確認する必要があるものです。最終的な方針は会計監査人と協議のうえ決定し、協議メモに記録してください（変更履歴は監査ログに残ります）。'),
      summary,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => {
        if (!confirm('すべての会計方針を既定値に戻しますか？')) return;
        update((_, p) => Object.assign(p, defaultPolicies()), '会計方針変更', 'すべて既定値に戻しました');
      } } }, 'すべて既定値に戻す'))),
    ...POLICIES.map((d) => policyCard(d, ctx)));
}
