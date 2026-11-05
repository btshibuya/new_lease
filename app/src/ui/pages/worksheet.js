import { h, card, table, amt, statusBadge, download } from '../dom.js';
import { COLORS } from '../components.js';
import { waterfall, barChart } from '../charts.js';
import { worksheet, MUST_BE_ZERO, cashFlowEliminations, maturity } from '../../engine/reports.js';
import { ACCOUNTS } from '../../engine/accounts.js';
import { TEMPLATES } from '../../engine/elimination.js';
import { toCsv } from '../../engine/data.js';
import { fmt } from '../../engine/util.js';

export function renderWorksheet(ctx) {
  const { gen, companies, pol, names, period, unit } = ctx;
  const ws = worksheet(gen, companies, pol, names, period);
  const cols = [
    { label: '科目', render: (r) => h('td', null, r.label, MUST_BE_ZERO.includes(r.acc) ? h('span', { class: 'co' }, 'グループ内：連結後0') : null) },
    { label: '借手（個別）', num: true, key: 'lessee' },
    { label: '貸手（個別）', num: true, key: 'lessor' },
    { label: '単純合算', num: true, key: 'simple' },
    { label: '個社修正', num: true, key: 'ind' },
    { label: '連結修正', num: true, key: 'con' },
    { label: '連結', render: (r) => amt(r.consol, { strong: true }) },
    { label: '判定', render: (r) => h('td', null, MUST_BE_ZERO.includes(r.acc) ? (r.consol === 0 ? statusBadge('ok', '0') : statusBadge('ng', '残高あり')) : '') },
  ];
  const bs = ws.filter((r) => r.type === 'BS');
  const pl = ws.filter((r) => r.type === 'PL');

  // ブリッジ：単純合算の損益（リース関連）→ 連結修正（テンプレート別）→ 連結
  const simplePL = -pl.reduce((a, r) => a + r.simple + r.ind, 0);
  const steps = [{ label: '単純合算（リース関連損益）', value: simplePL, total: true }];
  const byTpl = new Map();
  for (const j of gen.journals) {
    if (j.kind !== 'CON') continue;
    const v = -j.lines.filter((l) => ACCOUNTS[l.acc]?.type === 'PL').reduce((a, l) => a + l.amt, 0);
    if (v) byTpl.set(j.tpl, (byTpl.get(j.tpl) || 0) + v);
  }
  for (const [t, v] of byTpl) steps.push({ label: `${t} ${TEMPLATES[t]?.title.replace(/（.*）/, '') || ''}`, value: v, basis: TEMPLATES[t]?.title });
  steps.push({ label: '連結（リース関連損益）', value: simplePL + [...byTpl.values()].reduce((a, v) => a + v, 0), total: true });

  const cf = cashFlowEliminations(gen, pol, period);
  const mat = maturity(gen, period);

  const exportWs = () => download(`連結精算表_${period.label}.csv`, toCsv([['科目', '借手（個別）', '貸手（個別）', '単純合算', '個社修正', '連結修正', '連結'], ...ws.map((r) => [r.label, r.lessee, r.lessor, r.simple, r.ind, r.con, r.consol])]), 'text/csv;charset=utf-8');

  return h('div', { class: 'page' },
    h('h1', null, `連結精算表・連結CF・注記（${period.label}）`),
    card('連結精算表（グループ内リース関連科目、借方＋／貸方△）',
      h('p', { class: 'help' }, '個別の金額はアプリの計算値です（個別帳簿との一致は「検算 CHK-10」で確認）。「グループ内：連結後0」の科目が0になっていれば消去は完全です。'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: exportWs } }, 'CSV出力')),
      h('h3', null, '貸借対照表'), table(cols, bs),
      h('h3', null, '損益計算書'), table(cols, pl)),
    card(null, waterfall({ title: '損益のブリッジ：単純合算から連結へ（税引前・税効果・非支配株主を含む）', subtitle: '各棒にカーソルを合わせると内容を表示。連結後に残るのは主に貸手資産の減価償却費（組替後）', steps, unit })),
    h('div', { class: 'grid2' },
      card('連結キャッシュ・フロー計算書の消去データ', table([
        { label: '区分', key: 'section' }, { label: '項目', key: 'label' }, { label: '個別計上額', key: 'amount', num: true }, { label: '消去額', key: 'elim', num: true },
      ], cf.items), h('p', { class: 'help' }, `借手の支払と貸手の受取は連結上相殺されます（差額 ${fmt(cf.check)}）。利息の支払額の区分は会計方針 POL-09 に従います。`)),
      card(null, barChart({ title: 'リース負債の満期分析：グループ内消去額（割引前）', subtitle: '連結の注記（満期分析）から差し引く金額', labels: mat.map((m) => m.label), series: [{ name: '将来のリース料（割引前）', values: mat.map((m) => m.amount), color: COLORS.lessee }], unit, height: 240 }))));
}
