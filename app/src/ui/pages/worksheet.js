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
  const COLN = { lessee: '借手個別', lessor: '貸手個別', ind: '個社修正', con: '連結修正' };
  // セルを押すと「計算の確認」：どの契約・仕訳から来た金額かの内訳
  const cellInfo = (r, colKey) => () => {
    const want = colKey === 'simple' ? ['lessee', 'lessor'] : colKey === 'consol' ? ['lessee', 'lessor', 'ind', 'con'] : [colKey];
    const items = r.items.filter((x) => want.includes(x.col) && x.amt);
    const val = colKey === 'simple' ? r.simple : colKey === 'consol' ? r.consol : r[colKey];
    const formula = colKey === 'simple' ? [{ label: '借手個別', value: r.lessee }, '＋', { label: '貸手個別', value: r.lessor }]
      : colKey === 'consol' ? [{ label: '借手個別', value: r.lessee }, '＋', { label: '貸手個別', value: r.lessor }, '＋', { label: '個社修正', value: r.ind }, '＋', { label: '連結修正', value: r.con }] : [];
    return {
      context: `連結精算表・${period.label}（借方＋／貸方△）`,
      title: `${r.label}：${colKey === 'simple' ? '単純合算' : colKey === 'consol' ? '連結' : COLN[colKey]}`,
      value: val,
      formula,
      expr: formula.length ? `${formula.filter((f) => typeof f !== 'string').map((f) => fmt(f.value)).join(' ＋ ')} ＝ ${fmt(val)}` : '',
      breakdown: { title: `内訳（${items.length}件）`, cols: [{ label: '区分', key: 'col' }, { label: '契約', key: 'contract' }, { label: '元の仕訳・計算', key: 'src' }, { label: '金額', key: 'amt', num: true }], rows: [...items.map((x) => ({ ...x, col: COLN[x.col] })), { col: '合計', contract: '', src: '', amt: items.reduce((a, x) => a + x.amt, 0), total: true }] },
      notes: colKey === 'lessee' || colKey === 'lessor' ? ['個別の金額は、契約の条件からアプリが計算した値です。個別帳簿との一致は検算 CHK-10（実績との突合）で確かめます。'] : [],
      sources: [{ label: '契約・スケジュール' }, { label: '仕訳', kind: 'journal' }],
    };
  };
  const cols = [
    { label: '科目', render: (r) => h('td', null, r.label, MUST_BE_ZERO.includes(r.acc) ? h('span', { class: 'co' }, 'グループ内：連結後0') : null) },
    { label: '借手個別（アプリ計算値）', num: true, key: 'lessee', calc: (r) => cellInfo(r, 'lessee')() },
    { label: '貸手個別（アプリ計算値）', num: true, key: 'lessor', calc: (r) => cellInfo(r, 'lessor')() },
    { label: '単純合算', num: true, key: 'simple', calc: (r) => cellInfo(r, 'simple')() },
    { label: '個社修正', num: true, key: 'ind', calc: (r) => cellInfo(r, 'ind')() },
    { label: '連結修正', num: true, key: 'con', calc: (r) => cellInfo(r, 'con')() },
    { label: '連結', render: (r) => amt(r.consol, { strong: true, calc: cellInfo(r, 'consol') }) },
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
  // CFの各行：契約ごとの内訳
  const cfPer = gen.results.map((r) => ({ id: r.contract.id, items: cashFlowEliminations({ results: [r] }, pol, period).items }));
  const cfInfo = (row) => {
    const idx = cf.items.indexOf(row);
    const rows = cfPer.map((x) => ({ contract: x.id, amt: x.items[idx].elim })).filter((x) => x.amt);
    return { context: `連結キャッシュ・フロー計算書の消去額・${period.label}`, title: `${row.section}：${row.label}`, value: row.elim,
      breakdown: { title: '契約ごとの内訳', cols: [{ label: '契約', key: 'contract' }, { label: '消去額', key: 'amt', num: true }], rows: [...rows, { contract: '合計', amt: rows.reduce((a, x) => a + x.amt, 0), total: true }] },
      notes: ['利息の支払額は、支払ったリース料をまず未払の利息に充て、残りを元本の返済とみなして計算します（フリーレント期間の利息は次の支払で支払われます）。'],
      sources: [{ label: '契約のリース料' }, { label: '返済スケジュール' }] };
  };
  const mat = maturity(gen, period);

  const exportWs = () => download(`連結精算表_${period.label}.csv`, toCsv([['科目', '借手個別（アプリ計算値）', '貸手個別（アプリ計算値）', '単純合算', '個社修正', '連結修正', '連結'], ...ws.map((r) => [r.label, r.lessee, r.lessor, r.simple, r.ind, r.con, r.consol])]), 'text/csv;charset=utf-8');

  return h('div', { class: 'page' },
    card('連結精算表（グループ内リース関連科目、借方＋／貸方△）',
      h('div', { class: 'alert alert-info' }, '個別の金額はアプリの計算値です（個別帳簿との一致は「検算 CHK-10」で確認）。「グループ内：連結後0」の科目が0になっていれば消去は完全です。'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: exportWs } }, '表を書き出す（CSV）')),
      h('h3', null, '貸借対照表'), table(cols, bs, { className: 'ws-table' }),
      h('h3', null, '損益計算書'), table(cols, pl, { className: 'ws-table' })),
    card(null, waterfall({ wide: true, title: '損益のブリッジ：単純合算 → 連結（税引前）→ 税引後 → 親会社株主帰属（グループ内リース関連）', subtitle: '各棒にカーソルを合わせると内容を表示。連結（税引前）に残るのは主に貸手資産の減価償却費（組替後）', steps, unit })),
    h('div', { class: 'grid2' },
      card('連結キャッシュ・フロー計算書の消去データ', table([
        { label: '区分', key: 'section' }, { label: '項目', key: 'label' }, { label: '個別計上額', key: 'amount', num: true, calc: cfInfo }, { label: '消去額', key: 'elim', num: true, calc: cfInfo },
      ], cf.items), h('div', { class: 'alert alert-info' }, `借手の支払と貸手の受取は連結上相殺されます（差額 ${fmt(cf.check)}）。利息の支払額の区分は会計方針 POL-09 に従います。`)),
      card(null, barChart({ title: 'リース負債の返済予定：グループ内消去額', subtitle: '割引前のリース料（満期分析）と元本ベース（附属明細表の返済予定額）。開示様式に合わせて使い分けてください', labels: mat.map((m) => m.label), series: [{ name: '割引前のリース料', values: mat.map((m) => m.amount), color: COLORS.lessee }, { name: '元本（リース負債の減少額）', values: mat.map((m) => m.principal), color: 'var(--s7)' }], unit, height: 260 }))));
}
