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
    { label: '借手個別（アプリ計算値）', num: true, key: 'lessee' },
    { label: '貸手個別（アプリ計算値）', num: true, key: 'lessor' },
    { label: '単純合算', num: true, key: 'simple' },
    { label: '個社修正', num: true, key: 'ind' },
    { label: '連結修正', num: true, key: 'con' },
    { label: '連結', render: (r) => amt(r.consol, { strong: true }) },
    { label: '判定', render: (r) => h('td', null, MUST_BE_ZERO.includes(r.acc) ? (r.consol === 0 ? statusBadge('ok', '0') : statusBadge('ng', '残高あり')) : '') },
  ];
  const bs = ws.filter((r) => r.type === 'BS');
  const pl = ws.filter((r) => r.type === 'PL');

  // ブリッジ：単純合算（税引前）→ 連結修正（テンプレート別・税引前）→ 連結（税引前）→ 税効果 → 税引後 → 非支配株主 → 親会社株主帰属
  const simplePL = -pl.filter((r) => !['TAX_ADJ', 'NCI_PL'].includes(r.acc)).reduce((a, r) => a + r.simple + r.ind, 0);
  const steps = [{ label: '単純合算（税引前）', value: simplePL, total: true, basis: '借手・貸手の個別のリース関連損益（個別の税効果は含まない）' }];
  const byTpl = new Map();
  let tax = 0, nciPl = 0;
  for (const j of gen.journals) {
    if (j.kind !== 'CON') continue;
    for (const l of j.lines) {
      if (ACCOUNTS[l.acc]?.type !== 'PL') continue;
      if (l.acc === 'TAX_ADJ') tax -= l.amt;
      else if (l.acc === 'NCI_PL') nciPl -= l.amt;
      else byTpl.set(j.tpl, (byTpl.get(j.tpl) || 0) - l.amt);
    }
  }
  for (const [t, v] of byTpl) if (v) steps.push({ label: `${t} ${TEMPLATES[t]?.title.replace(/（.*）/, '') || ''}`, value: v, basis: TEMPLATES[t]?.title });
  const pre = simplePL + [...byTpl.values()].reduce((a, v) => a + v, 0);
  steps.push({ label: '連結（税引前）', value: pre, total: true });
  if (tax) steps.push({ label: '税効果（法人税等調整額）', value: tax, basis: '個別税効果の取消（C-13）' });
  steps.push({ label: '税引後', value: pre + tax, total: true, basis: '個別の税効果を含まないため、連結の当期純利益そのものではありません' });
  if (nciPl) steps.push({ label: '非支配株主に帰属', value: nciPl, basis: 'C-14' });
  steps.push({ label: '親会社株主に帰属', value: pre + tax + nciPl, total: true });

  const cf = cashFlowEliminations(gen, pol, period);
  const mat = maturity(gen, period);

  const exportWs = () => download(`連結精算表_${period.label}.csv`, toCsv([['科目', '借手個別（アプリ計算値）', '貸手個別（アプリ計算値）', '単純合算', '個社修正', '連結修正', '連結'], ...ws.map((r) => [r.label, r.lessee, r.lessor, r.simple, r.ind, r.con, r.consol])]), 'text/csv;charset=utf-8');

  return h('div', { class: 'page' },
    h('h1', null, `連結精算表・連結CF・注記（${period.label}）`),
    card('連結精算表（グループ内リース関連科目、借方＋／貸方△）',
      h('p', { class: 'help' }, '個別の金額はアプリの計算値です（個別帳簿との一致は「検算 CHK-10」で確認）。「グループ内：連結後0」の科目が0になっていれば消去は完全です。'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: exportWs } }, 'CSV出力')),
      h('h3', null, '貸借対照表'), table(cols, bs),
      h('h3', null, '損益計算書'), table(cols, pl)),
    card(null, waterfall({ wide: true, title: '損益のブリッジ：単純合算 → 連結（税引前）→ 税引後 → 親会社株主帰属（グループ内リース関連）', subtitle: '各棒にカーソルを合わせると内容を表示。連結（税引前）に残るのは主に貸手資産の減価償却費（組替後）', steps, unit })),
    h('div', { class: 'grid2' },
      card('連結キャッシュ・フロー計算書の消去データ', table([
        { label: '区分', key: 'section' }, { label: '項目', key: 'label' }, { label: '個別計上額', key: 'amount', num: true }, { label: '消去額', key: 'elim', num: true },
      ], cf.items), h('p', { class: 'help' }, `借手の支払と貸手の受取は連結上相殺されます（差額 ${fmt(cf.check)}）。利息の支払額の区分は会計方針 POL-09 に従います。`)),
      card(null, barChart({ title: 'リース負債の返済予定：グループ内消去額', subtitle: '割引前のリース料（満期分析）と元本ベース（附属明細表の返済予定額）。開示様式に合わせて使い分けてください', labels: mat.map((m) => m.label), series: [{ name: '割引前のリース料', values: mat.map((m) => m.amount), color: COLORS.lessee }, { name: '元本（リース負債の減少額）', values: mat.map((m) => m.principal), color: 'var(--s7)' }], unit, height: 260 }))));
}
