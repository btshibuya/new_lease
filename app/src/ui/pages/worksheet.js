import { h, card, table, amt, statusBadge, download } from '../dom.js';
import { COLORS } from '../components.js';
import { waterfall, barChart } from '../charts.js';
import { worksheet, MUST_BE_ZERO, cashFlowEliminations, disclosures } from '../../engine/reports.js';
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
  const disc = disclosures(gen, period, pol);
  const mat = disc.maturity;

  const exportWs = () => download(`連結精算表_${period.label}.csv`, toCsv([['科目', '借手個別（アプリ計算値）', '貸手個別（アプリ計算値）', '単純合算', '個社修正', '連結修正', '連結'], ...ws.map((r) => [r.label, r.lessee, r.lessor, r.simple, r.ind, r.con, r.consol])]), 'text/csv;charset=utf-8');

  // 注記：各社の注記に含まれるグループ内リース分（連結の注記では除く）
  const coName = (code) => companies.find((c) => c.code === code)?.name || code;
  const noteInfo = (it, rows, title) => () => ({
    context: `注記（新リース会計基準）・${period.label}`,
    title: title || it.title,
    value: rows.reduce((a, x) => a + x.amt, 0),
    breakdown: { title: `契約ごとの内訳（${rows.length}件）`, cols: [{ label: '契約', key: 'contract' }, { label: '会社', key: 'coName' }, { label: '資産区分', key: 'cls' }, { label: '金額', key: 'amt', num: true }], rows: [...rows.map((x) => ({ ...x, coName: coName(x.co) })), { contract: '合計', coName: '', cls: '', amt: rows.reduce((a, x) => a + x.amt, 0), total: true }] },
    notes: [it.basis, ...rows.filter((x) => x.note).map((x) => `${x.contract}：${x.note}`), '連結の注記額は、各社の注記額の合計からこの金額を差し引いた額になります（グループ外のリースはこのアプリの対象外）。'],
    sources: [{ label: '契約・スケジュール' }],
  });
  const noteRows = [];
  for (const it of disc.items) {
    noteRows.push({ ...it, label: it.title, sideLabel: it.side === '借手' ? '借手の会社' : '貸手の会社', adj: -it.amount, calc: noteInfo(it, it.rows) });
    if (it.byClass) {
      const classes = [...new Set(it.rows.map((x) => x.cls))];
      for (const cl of classes) {
        const rows = it.rows.filter((x) => x.cls === cl);
        const v = rows.reduce((a, x) => a + x.amt, 0);
        noteRows.push({ sub: true, label: `うち ${cl}`, sideLabel: '', when: '', amount: v, adj: -v, calc: noteInfo(it, rows, `${it.title}：${cl}`) });
      }
    }
  }
  const statusBadgeOf = (st) => (st === 'confirmed' ? h('span', { class: 'badge ok' }, '確認済') : h('span', { class: 'badge caution' }, '要原文確認'));
  const notesTable = table([
    { label: '注記項目', render: (r) => h('td', { class: r.sub ? 'indent' : '' }, r.sub ? r.label : h('b', null, r.label)) },
    { label: '開示する会社', key: 'sideLabel' },
    { label: '時点', key: 'when' },
    { label: '各社の注記に含まれる額', num: true, key: 'amount', calc: (r) => r.calc() },
    { label: '連結注記での調整', num: true, key: 'adj', calc: (r) => r.calc() },
    { label: '内容・根拠', render: (r) => h('td', { class: 'small' }, r.sub ? '' : [statusBadgeOf(r.status), ' ', r.basis]) },
  ], noteRows, { className: 'ws-table ws-notes', rowClass: (r) => (r.sub ? 'sub' : '') });
  const recvInfo = (m) => () => ({ context: `注記・${period.label}`, title: `貸手：将来の受取リース料（${m.label}）`, value: m.lessorReceipts,
    breakdown: { title: '契約ごとの内訳', cols: [{ label: '契約', key: 'contract' }, { label: '貸手', key: 'coName' }, { label: '金額', key: 'amt', num: true }], rows: [...m.lessorRows.map((x) => ({ ...x, coName: coName(x.co) })), { contract: '合計', coName: '', amt: m.lessorReceipts, total: true }] },
    notes: ['決算日後に受け取る予定のリース料（割引前）を、5年以内は1年ごと、5年超はまとめて表示します。オペレーティング・リースの貸手の注記から除く額です。'], sources: [{ label: '契約のリース料' }] });
  const sumM = (f) => mat.reduce((a, m) => a + m[f], 0);
  const matTable = table([
    { label: '決算日後の期間', key: 'label' },
    { label: '借手：リース負債（割引前のリース料）', num: true, key: 'lesseeAmount' },
    { label: '借手：リース負債（元本の返済予定額）', num: true, key: 'lesseePrincipal' },
    { label: '貸手：将来の受取リース料', num: true, key: 'lessorReceipts', calc: (m) => recvInfo(m)() },
  ], [...mat, { label: '合計', lesseeAmount: sumM('lesseeAmount'), lesseePrincipal: sumM('lesseePrincipal'), lessorReceipts: sumM('lessorReceipts'), lessorRows: mat.flatMap((m) => m.lessorRows), total: true }], { className: 'ws-table', rowClass: (m) => (m.total ? 'total' : '') });
  const exportNotes = () => download(`注記_グループ内リース_${period.label}.csv`, toCsv([
    ['注記項目', '開示する会社', '時点', '各社の注記に含まれる額', '連結注記での調整', '内容・根拠'], ...noteRows.map((r) => [r.label, r.sideLabel, r.when, r.amount, r.adj, r.sub ? '' : r.basis]),
    [], ['決算日後の期間', '借手：リース負債（割引前のリース料）', '借手：リース負債（元本の返済予定額）', '貸手：将来の受取リース料'], ...mat.map((m) => [m.label, m.lesseeAmount, m.lesseePrincipal, m.lessorReceipts]),
  ]), 'text/csv;charset=utf-8');

  return h('div', { class: 'page' },
    card('連結精算表（グループ内リース関連科目、借方＋／貸方△）',
      h('div', { class: 'alert alert-info' }, '個別の金額はアプリの計算値です（個別帳簿との一致は「検算 CHK-10」で確認）。「グループ内：連結後0」の科目が0になっていれば消去は完全です。'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: exportWs } }, '表を書き出す（CSV）')),
      h('h3', null, '貸借対照表'), table(cols, bs, { className: 'ws-table' }),
      h('h3', null, '損益計算書'), table(cols, pl, { className: 'ws-table' })),
    card(null, waterfall({ wide: true, title: '損益のブリッジ：単純合算 → 連結（税引前）→ 税引後 → 親会社株主帰属（グループ内リース関連）', subtitle: '各棒にカーソルを合わせると内容を表示。連結（税引前）に残るのは主に貸手資産の減価償却費（組替後）', steps, unit })),
    card('連結キャッシュ・フロー計算書の消去データ', table([
      { label: '項目', key: 'label' }, { label: '区分', key: 'section' }, { label: '個別計上額', key: 'amount', num: true, calc: cfInfo }, { label: '消去額', key: 'elim', num: true, calc: cfInfo },
    ], cf.items, { className: 'ws-table' }), h('div', { class: 'alert alert-info' }, `借手の支払と貸手の受取は連結上相殺されます（差額 ${fmt(cf.check)}）。利息の支払額の区分は会計方針 POL-09 に従います。`)),
    card('注記（新リース会計基準）：グループ内リースの調整額',
      h('div', { class: 'alert alert-info' }, '各社の個別の注記にはグループ内リースの金額が含まれますが、連結上グループ内リースは存在しないため、連結の注記からは除きます。下の表は「各社の注記に含まれるグループ内リースの額」と、連結の注記を作るときの調整額（△は減算）です。金額を押すと契約ごとの内訳を表示します。連結の注記額＝各社の注記額の合計＋調整額（グループ外のリースはこのアプリの対象外）。「要原文確認」の項目は、注記の要否・項番号を基準・適用指針の原文で確認してください。'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: exportNotes } }, '注記の調整額を書き出す（CSV）')),
      notesTable,
      h('h3', null, '満期分析：グループ内リース分（連結の注記・附属明細表から除く額）'),
      h('div', { class: 'alert alert-info' }, '借手のリース負債は、金融商品の時価等の注記（割引前の支払予定額）と連結附属明細表（借入金等明細表：元本の返済予定額）で使います。貸手のオペレーティング・リースは、将来の受取リース料を決算日後5年以内は1年ごと、5年超はまとめて注記します。'),
      matTable,
      barChart({ wide: true, title: '決算日後の期間別：借手のリース料と貸手の受取リース料（グループ内）', subtitle: '同じ契約の支払と受取のため、借手の短期・少額リース等や貸手のリース期間の違いを除けばほぼ一致します', labels: mat.map((m) => m.label), series: [{ name: '借手：割引前のリース料', values: mat.map((m) => m.lesseeAmount), color: COLORS.lessee }, { name: '借手：元本', values: mat.map((m) => m.lesseePrincipal), color: 'var(--s5)' }, { name: '貸手：受取リース料', values: mat.map((m) => m.lessorReceipts), color: COLORS.lessor }], unit, height: 240 })));
}
