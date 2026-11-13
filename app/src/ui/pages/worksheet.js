import { h, card, table, amt, statusBadge, download, ask, toast, select, saveFile, calcable } from '../dom.js';
import { COLORS } from '../components.js';
import { waterfall, barChart } from '../charts.js';
import { worksheet, MUST_BE_ZERO, cashFlowEliminations } from '../../engine/reports.js';
import { NOTE_SECTIONS, BUCKETS, groupNoteAmounts, consolidatedNotes, noteCollectionCsv, noteCollectionXlsx, importNoteCollection, importNoteCollectionXlsx, notePeriodKey, noteRows } from '../../engine/notes.js';
import { update } from '../store.js';
import { focusJournals } from './journals.js';
import { contentOrder } from '../components.js';

// 列の粒度：kind＝区分別（個社修正・連結修正）、content＝内容別（開始仕訳も内容別）、content_open＝内容別（開始仕訳・洗替はまとめる）
const view = { gran: 'kind', company: 'all' };
// 会社で抽出：その会社の行だけ（'CONSOL' は会社に属さない組替の行）
const coOk = (l) => view.company === 'all' || l.co === view.company;
const GRANS = [['kind', '区分別（個社修正・連結修正）'], ['content_open', '内容別（開始仕訳はまとめる）'], ['content', '内容別（開始仕訳も内容別）']];
import { ACCOUNTS, accountLabel, rateAt } from '../../engine/accounts.js';
import { round } from '../../engine/util.js';
import { TEMPLATES, generateAll, carryModeOf, CARRY_DEFS, nciSegments, nciBase } from '../../engine/elimination.js';
import { goTo } from '../nav.js';
import { toCsv } from '../../engine/data.js';
import { fmt, indexToJp } from '../../engine/util.js';

export function renderWorksheet(ctx) {
  const { gen, companies, pol, names, period, unit } = ctx;
  // 会社マスタで削除・コード変更された会社が選んだままになっていたら、すべての会社に戻す
  if (view.company !== 'all' && view.company !== 'CONSOL' && !companies.some((c) => c.code === view.company)) view.company = 'all';
  const ws = worksheet(gen, companies, pol, names, period, { company: view.company === 'all' ? null : view.company });
  const coLabel = view.company === 'all' ? '全社' : view.company === 'CONSOL' ? '連結（会社に属さない組替）' : `${view.company} ${companies.find((c) => c.code === view.company)?.name || ''}`;
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
      breakdown: { title: `内訳（${items.length}件）`, cols: [{ label: '区分', key: 'col' }, { label: '契約', key: 'contract' }, { label: '会社', key: 'coName' }, { label: '元の仕訳・計算', key: 'src' }, { label: '金額', key: 'amt', num: true }], rows: [...items.map((x) => ({ ...x, col: COLN[x.col], coName: x.co === 'CONSOL' ? '連結' : x.co })), { col: '合計', contract: '', coName: '', src: '', amt: items.reduce((a, x) => a + x.amt, 0), total: true }] },
      notes: colKey === 'lessee' || colKey === 'lessor' ? ['個別の金額は、契約の条件からアプリが計算した値です。個別帳簿との一致は検算 CHK-10（実績との突合）で確かめます。'] : [],
      sources: [{ label: '契約・スケジュール' }, { label: '仕訳', kind: 'journal' }],
    };
  };
  // 内容別の列：仕訳の内容ごとに集計（開始仕訳・洗替をまとめるかは粒度の設定による）
  const colKeyOf = (x) => (view.gran === 'content_open' && x.tpl && (x.tpl.startsWith('C-01') || x.tpl === 'M-01O') ? 'OPEN' : x.content);
  const contentCols = [];
  if (view.gran !== 'kind') {
    const seen = new Map();
    for (const r of ws) for (const x of r.items) if (x.col === 'ind' || x.col === 'con') {
      const k = colKeyOf(x);
      if (!seen.has(k)) seen.set(k, { key: k, kind: x.col, tpl: k === 'OPEN' ? 'C-01' : x.tpl, src: k === 'OPEN' ? '' : x.srcTpl, title: k === 'OPEN' ? '開始仕訳・洗替（前期末からの繰越）' : x.contentTitle });
    }
    contentCols.push(...[...seen.values()].sort((p, q) => (p.kind === q.kind ? contentOrder(p, q) : p.kind === 'ind' ? -1 : 1)));
    for (const r of ws) { r.byContent = {}; for (const x of r.items) if (x.col === 'ind' || x.col === 'con') { const k = colKeyOf(x); r.byContent[k] = (r.byContent[k] || 0) + x.amt; } }
  }
  // 元帳・仕訳帳へ移るときは、精算表で選んでいる会社の絞り込みを引き継ぐ
  const co = view.company === 'all' ? {} : { company: view.company };
  const coTag = view.company === 'all' ? '' : `・${view.company === 'CONSOL' ? '連結' : view.company}`;
  const links = (r, contentKey) => [
    { label: `元帳（${r.label}${coTag}）`, go: () => focusJournals({ account: r.label, ...co }) },
    ...(contentKey && contentKey !== 'OPEN' ? [{ label: `仕訳帳（${contentKey.replace(':', '・')}${coTag}）`, go: () => focusJournals({ content: contentKey, ...co }) }] : contentKey === 'OPEN' ? [{ label: `仕訳帳（開始仕訳・洗替${coTag}）`, go: () => focusJournals({ content: 'OPEN', ...co }) }] : [{ label: `仕訳帳（すべて${coTag}）`, go: () => focusJournals({ ...co }) }]),
  ];
  const contentInfo = (r, cc) => () => {
    const items = r.items.filter((x) => (x.col === 'ind' || x.col === 'con') && colKeyOf(x) === cc.key && x.amt);
    return { context: `連結精算表・${period.label}（借方＋／貸方△）`, title: `${r.label}：${cc.key === 'OPEN' ? '' : `${cc.key.replace(':', '・')} `}${cc.title}`, value: r.byContent[cc.key] || 0,
      breakdown: { title: `内訳（${items.length}件）`, cols: [{ label: '契約', key: 'contract' }, { label: '会社', key: 'coName' }, { label: '元の仕訳', key: 'src' }, { label: '金額', key: 'amt', num: true }], rows: [...items.map((x) => ({ ...x, coName: x.co === 'CONSOL' ? '連結' : x.co })), { contract: '合計', coName: '', src: '', amt: items.reduce((a, x) => a + x.amt, 0), total: true }] },
      sources: [{ label: '仕訳', kind: 'journal' }], links: links(r, cc.key) };
  };
  const split = monthlySplitter(ctx);
  const withLinks = (fn, r, key) => () => ({ ...fn(), links: links(r, null), more: key ? split.more(r, key) : [] });
  const cols = [
    { label: '科目', render: (r) => h('td', null, r.label, MUST_BE_ZERO.includes(r.acc) ? h('span', { class: 'co' }, 'グループ内：連結後0') : null) },
    { label: '借手個別（アプリ計算値）', num: true, key: 'lessee', calc: (r) => cellInfo(r, 'lessee')() },
    { label: '貸手個別（アプリ計算値）', num: true, key: 'lessor', calc: (r) => cellInfo(r, 'lessor')() },
    { label: '単純合算', num: true, key: 'simple', calc: (r) => cellInfo(r, 'simple')() },
    ...(view.gran === 'kind' ? [
      { label: '個社修正', num: true, key: 'ind', calc: (r) => withLinks(cellInfo(r, 'ind'), r, 'IND')() },
      { label: '連結修正', num: true, key: 'con', calc: (r) => withLinks(cellInfo(r, 'con'), r, 'CON')() },
    ] : contentCols.map((cc) => ({ label: cc.key === 'OPEN' ? '開始仕訳・洗替' : `${cc.key.replace(':', '・')} ${cc.title.replace(/^開始仕訳：/, '開始：').replace(/^洗替：/, '洗替：').replace(/（.*$/, '').slice(0, 14)}`, title: cc.title, num: true, render: (r) => r.byContent[cc.key] ?? null, calc: (r) => contentInfo(r, cc)() }))),
    { label: '連結', render: (r) => amt(r.consol, { strong: true, calc: withLinks(cellInfo(r, 'consol'), r) }) },
    { label: '判定', render: (r) => h('td', null, MUST_BE_ZERO.includes(r.acc) ? (r.consol === 0 ? statusBadge('ok', '0') : statusBadge('ng', '残高あり')) : '') },
  ];
  const granSel = h('label', null, '列の粒度 ', select(GRANS, view.gran, (v) => { view.gran = v; window.dispatchEvent(new HashChangeEvent('hashchange')); }));
  const coSel = h('label', null, '会社 ', select([['all', 'すべての会社（全社）'], ...companies.map((c) => [c.code, `${c.code} ${c.name}`]), ['CONSOL', '連結（会社に属さない組替）']], view.company, (v) => { view.company = v; window.dispatchEvent(new HashChangeEvent('hashchange')); }));
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
      if (ACCOUNTS[l.acc]?.type !== 'PL' || !coOk(l)) continue;
      if (l.acc === 'TAX_ADJ') tax -= l.amt;
      else if (l.acc === 'NCI_PL') nciPl -= l.amt;
      else byTpl.set(j.src || j.tpl, (byTpl.get(j.src || j.tpl) || 0) - l.amt); // 洗替・開始仕訳は元の内容に含める
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
  const exportWs = () => download(`連結精算表_${period.label}${view.company === 'all' ? '' : `_${view.company}`}.csv`, toCsv(view.gran === 'kind'
    ? [['科目', '借手個別（アプリ計算値）', '貸手個別（アプリ計算値）', '単純合算', '個社修正', '連結修正', '連結'], ...ws.map((r) => [r.label, r.lessee, r.lessor, r.simple, r.ind, r.con, r.consol])]
    : [['科目', '借手個別（アプリ計算値）', '貸手個別（アプリ計算値）', '単純合算', ...contentCols.map((cc) => (cc.key === 'OPEN' ? cc.title : `${cc.key} ${cc.title}`)), '連結'], ...ws.map((r) => [r.label, r.lessee, r.lessor, r.simple, ...contentCols.map((cc) => r.byContent[cc.key] ?? 0), r.consol])]), 'text/csv;charset=utf-8');
  const notesCard = renderNotes(ctx);
  const proofCards = renderProofs(ctx);
  const rollCard = renderRollforward(ctx);

  return h('div', { class: 'page ws-page' },
    card(`連結精算表（グループ内リース関連科目、借方＋／貸方△）：${coLabel}`,
      h('div', { class: 'alert alert-info' }, '個別の金額はアプリの計算値です（個別帳簿との一致は「検算 CHK-10」で確認）。「グループ内：連結後0」の科目が0になっていれば消去は完全です。会社を選ぶと、その会社の個別・個社修正・連結修正の行だけで集計します（会社ごとの連結パッケージの確認用。消去は会社ごとにも0になります）。'),
      h('div', { class: 'actions' }, coSel, granSel, h('button', { class: 'btn', type: 'button', on: { click: exportWs } }, '表を書き出す（CSV）'), h('span', { class: 'muted small' }, '金額を押すと内訳を表示し、元帳・仕訳帳へ移動できます。')),
      h('h3', null, '貸借対照表'), table(cols, bs, { className: 'ws-table' }),
      h('h3', null, '損益計算書'), table(cols, pl, { className: 'ws-table' })),
    card(null, waterfall({ wide: true, title: '損益のブリッジ：単純合算 → 連結（税引前）→ 税引後 → 親会社株主帰属（グループ内リース関連）', subtitle: '各棒にカーソルを合わせると内容を表示。連結（税引前）に残るのは主に貸手資産の減価償却費（組替後）', steps, unit })),
    // CFの消去は借手の支払と貸手の受取の組で相殺するため、会社を選んでいても全社の額を表示する
    card(view.company === 'all' ? '連結キャッシュ・フロー計算書の消去データ' : '連結キャッシュ・フロー計算書の消去データ（全社：会社の選択によらず全社の額）', table([
      { label: '項目', key: 'label' }, { label: '区分', key: 'section' }, { label: '個別計上額', key: 'amount', num: true, calc: cfInfo }, { label: '消去額', key: 'elim', num: true, calc: cfInfo },
    ], cf.items, { className: 'ws-table' }), h('div', { class: 'alert alert-info' }, `借手の支払と貸手の受取は連結上相殺されます（差額 ${fmt(cf.check)}）。利息の支払額の区分は会計方針 POL-09 に従います。`)),
    rollCard,
    ...proofCards,
    notesCard);
}

const OPEN_TPLS = new Set(['C-01', 'C-01T', 'C-01N', 'M-01O']);
const noteView = { co: 'all' }; // 注記の収集表を書き出す対象の会社
const splitCache = new WeakMap(); // 計算結果（gen）ごとの月別の仕訳
const prevCache = new WeakMap(); // 計算結果（gen）ごとの前期末の仕訳
const contentOf = (j) => (j.src ? `${j.tpl}:${j.src}` : j.tpl);

/**
 * 月別の分解：期間の金額＝期首（開始仕訳）＋各月の増減（開始仕訳以外の仕訳）。
 * 期間に複数の月があるときだけ「さらに分解する」に出す。月ごとの仕訳は必要になったときに作る。
 */
function monthlySplitter(ctx) {
  const { data, pol, names, period, schedCache, gen } = ctx;
  const cache = splitCache.get(gen) || splitCache.set(gen, new Map()).get(gen); // 同じ計算結果の間は月ごとの仕訳を使い回す
  const genOf = (m) => cache.get(m) || cache.set(m, generateAll(data, { start: m, end: m, label: indexToJp(m), fyEnd: period.fyEnd }, pol, { schedCache })).get(m);
  const pick = (key) => (j) => (key === 'IND' ? j.kind === 'IND' : key === 'CON' ? j.kind === 'CON' : key === 'OPEN' ? OPEN_TPLS.has(j.tpl) || j.tpl === 'C-01R' : contentOf(j) === key);
  const sumOf = (js, label) => js.flatMap((j) => j.lines).filter((l) => coOk(l) && accountLabel(l, pol, names) === label).reduce((a, l) => a + l.amt, 0);
  // 月末の残高：その月だけを期間とした仕訳（開始仕訳を含む）の合計＝その月末の連結修正の残高
  const balAt = (m, f, label) => sumOf(genOf(m).journals.filter(f), label);
  const open = (r, key) => () => {
    const f = pick(key);
    const isPL = ACCOUNTS[r.acc]?.type === 'PL';
    // 利益剰余金期首は「期間の期首」の残高のため、月末の残高の差ではなく、当期の開始仕訳＋各月の調整（開始仕訳以外）で分ける
    const isRE = r.acc === 'RE_OPEN';
    const total = sumOf(gen.journals.filter(f), r.label);
    const rows = [];
    let base = 0;
    if (isPL || isRE) {
      // 損益：各月の発生額の合計＝期間の金額。利益剰余金期首：当期の開始仕訳＋各月の調整
      if (isRE) { base = sumOf(gen.journals.filter((j) => f(j) && OPEN_TPLS.has(j.tpl)), r.label); rows.push({ ym: '当期の開始仕訳（期首）', amt: base }); }
      for (let m = period.start; m <= period.end; m++) rows.push({ ym: isRE ? `${indexToJp(m)}の調整（開始仕訳以外）` : indexToJp(m), amt: sumOf(genOf(m).journals.filter((j) => f(j) && !OPEN_TPLS.has(j.tpl)), r.label) });
    } else {
      // 貸借：期首時点の残高（前期末）＋各月の増減（当月末−前月末）＝期末の残高
      base = balAt(period.start - 1, f, r.label);
      rows.push({ ym: `期首時点の残高（${indexToJp(period.start - 1)}末）`, amt: base });
      let prevBal = base;
      for (let m = period.start; m <= period.end; m++) { const bal = balAt(m, f, r.label); rows.push({ ym: `${indexToJp(m)}の増減`, amt: bal - prevBal, bal }); prevBal = bal; }
    }
    const sum = rows.reduce((a, x) => a + x.amt, 0);
    if (sum !== total) rows.push({ ym: '差（月に割り当てられない手入力仕訳・手修正など）', amt: total - sum });
    rows.push({ ym: isPL ? '合計（期間の金額）' : isRE ? '期間の金額' : '期末の残高（期間の金額）', amt: total, total: true });
    return {
      context: `連結精算表・${period.label}`, title: `${r.label}：月別の内訳`, value: total,
      formula: isPL ? [{ label: '各月の発生額の合計', value: sum }] : isRE ? [{ label: '当期の開始仕訳', value: base }, '＋', { label: '各月の調整', value: sum - base }] : [{ label: '期首時点の残高', value: base }, '＋', { label: '各月の増減の合計', value: sum - base }],
      expr: `${isPL ? fmt(sum) : isRE ? `${fmt(base)} ＋ ${fmt(sum - base)}` : `${fmt(base)} ＋ ${fmt(sum - base)}`}${sum !== total ? ` ＋ 差 ${fmt(total - sum)}` : ''} ＝ ${fmt(total)}`,
      breakdown: { title: `月別（${period.end - period.start + 1}か月）：${isPL ? '各月の発生額' : '期首時点の残高＋各月の増減'}`, cols: [{ label: '月', key: 'ym' }, { label: '金額（借方＋）', key: 'amt', num: true }, ...(isPL || isRE ? [] : [{ label: '月末の残高', key: 'bal', num: true }])], rows },
      notes: [isRE ? '利益剰余金期首は期間の期首の残高です。当期の開始仕訳と、各月の開始仕訳以外の調整（適用時の累積的影響額など）の合計です。' : isPL ? '各月の発生額は、その月だけを期間とした仕訳の金額です。累計・年度の金額は各月の合計と一致します。' : '各月の増減は、その月末の残高−前月末の残高です（月末の残高は、その月だけを期間とした仕訳の合計）。「繰越なし」の内容（流動・固定の組替など）も、残高の差で増減を求めます。', '手修正・期間を指定した手入力仕訳は、その期間の仕訳にだけ反映するため、月に割り当てられない場合は「差」に表示します。'],
      sources: [{ label: '仕訳', kind: 'journal' }],
    };
  };
  // 期末残高一括消去（POL-03）では毎期の仕訳に期首の利益剰余金が含まれるため、利益剰余金期首は月に分けない
  return { more: (r, key) => (period.end > period.start && !(r.acc === 'RE_OPEN' && pol['POL-03'] === 'balance') ? [{ label: '月別に分解（期首＋各月の増減）', desc: 'この金額を月ごとの増減に分けます', open: open(r, key) }] : []) };
}

/**
 * 残高の増減表と期間の連続性：貸借対照表の科目ごとに
 * 前期末の残高（繰越ありの内容、前期末までの仕訳から別に計算）＝ 当期首の開始仕訳 かを確かめ、当期の増減・期末を示す。
 */
function renderRollforward(ctx) {
  const { data, pol, names, period, schedCache, gen, companies } = ctx;
  const cfg = data.config.carry || {};
  if (pol['POL-03'] === 'balance') {
    return h('section', { class: 'card', id: 'rollforward' }, h('h2', null, `残高の増減表と期間の連続性（${period.label}${view.company === 'all' ? '' : `・${view.company === 'CONSOL' ? '連結' : view.company}`}）`),
      h('div', { class: 'alert alert-info' }, '会計方針 POL-03 が「期末残高一括消去」のため、開始仕訳を作らず、毎期末に残高を一括で消去します。前期末の残高と当期首の開始仕訳の比較は行いません（期間の連続性は検算 CHK-06 で確認しています）。'));
  }
  let prev = prevCache.get(gen);
  if (!prev) {
    try { prev = generateAll(data, { start: period.start - 1, end: period.start - 1, label: '前期末', fyEnd: period.fyEnd }, pol, { schedCache }); } catch (e) { return card('残高の増減表', h('div', { class: 'alert alert-err' }, e.message)); }
    prevCache.set(gen, prev);
  }
  // 比較の対象は、繰越設定のある内容（CARRY_DEFS）のうち「繰越あり」のもの
  const carried = (j) => !j.manual && j.kind === 'CON' && CARRY_DEFS.some((d) => d.tpl === (j.src || j.tpl)) && (j.src || j.tpl) !== 'C-12' && carryModeOf(cfg, j.src || j.tpl) !== 'none';
  const RE = '利益剰余金（期首）';
  const keyOf = (l) => (ACCOUNTS[l.acc]?.type === 'PL' || l.acc === 'RE_OPEN' ? RE : accountLabel(l, pol, names));
  const rows = new Map();
  const add = (col, j, l) => {
    if (!coOk(l)) return;
    if (ACCOUNTS[l.acc]?.type !== 'BS' && ACCOUNTS[l.acc]?.type !== 'PL') return;
    const k = keyOf(l);
    const r = rows.get(k) || rows.set(k, { label: k, acc: k === RE ? 'RE_OPEN' : l.acc, prev: 0, open: 0, adj: 0, move: 0, items: { prev: [], open: [], adj: [], move: [] } }).get(k);
    r[col] += l.amt;
    r.items[col].push({ contract: j.manual ? `手入力 ${j.id}` : j.contractId, src: `${j.tpl}${j.src ? `・${j.src}` : ''} ${j.title}`, amt: l.amt });
  };
  // 前期末：繰越ありの内容の仕訳（手修正前の計算値）。損益の科目は利益剰余金に含める
  // 手修正の引継（開始仕訳）は当期側で別の列に出すため、前期末からは除く
  for (const j of prev.journals.filter((x) => carried(x) && !x.carriedOverride)) for (const l of j.origLines || j.lines) add('prev', j, l);
  for (const j of gen.journals) {
    const isOpen = OPEN_TPLS.has(j.tpl) && !j.manual && !j.carriedOverride;
    const col = j.carriedOverride ? 'adj' : isOpen ? 'open' : 'move';
    for (const l of j.lines) {
      if (col === 'move' && ACCOUNTS[l.acc]?.type === 'PL') continue; // 当期の損益は利益剰余金（期首）の行に含めない
      add(col, j, l);
    }
  }
  const order = Object.keys(ACCOUNTS);
  const list = [...rows.values()].filter((r) => r.prev || r.open || r.adj || r.move).sort((a, b) => (a.label === RE ? 1 : b.label === RE ? -1 : order.indexOf(a.acc) - order.indexOf(b.acc)));
  for (const r of list) r.end = r.open + r.adj + r.move;
  // 会社別の表示では利益剰余金の行は比べない：開始仕訳の利益剰余金は会社ごとの純資産修正額で配分し、損益は行の会社に属するため（全社では一致する）
  const skip = (r) => view.company !== 'all' && r.label === RE;
  const ng = list.filter((r) => !skip(r) && r.prev !== r.open);
  const NAMES = { prev: '前期末（繰越ありの内容）', open: '期首（開始仕訳）', adj: '手修正の引継', move: '当期の増減（開始仕訳以外）' };
  const info = (r, col) => () => {
    const items = col === 'end' ? [...r.items.open, ...r.items.adj, ...r.items.move] : r.items[col];
    const val = col === 'end' ? r.end : r[col];
    return { context: `残高の増減表・${period.label}`, title: `${r.label}：${col === 'end' ? '期末' : NAMES[col]}`, value: val,
      formula: col === 'end' ? [{ label: '期首', value: r.open }, '＋', { label: '手修正の引継', value: r.adj }, '＋', { label: '当期の増減', value: r.move }] : col === 'open' ? [{ label: '前期末', value: r.prev }, '−', { label: '期首', value: r.open }, '＝', { label: '差', value: r.prev - r.open }] : [],
      breakdown: { title: `内訳（${items.length}件）`, cols: [{ label: '契約', key: 'contract' }, { label: '仕訳', key: 'src' }, { label: '金額', key: 'amt', num: true }], rows: [...items, { contract: '合計', src: '', amt: items.reduce((a, x) => a + x.amt, 0), total: true }] },
      notes: col === 'prev' ? ['前期末の残高は、前期末（期首の前月）までを期間として別に作った仕訳から集計しています（繰越ありの内容のみ、手修正前の計算値）。'] : [], sources: [{ label: '仕訳', kind: 'journal' }] };
  };
  const tbl = table([
    { label: '科目', key: 'label' },
    { label: '前期末（繰越ありの内容）', num: true, key: 'prev', calc: (r) => info(r, 'prev')() },
    { label: '期首（開始仕訳）', num: true, key: 'open', calc: (r) => info(r, 'open')() },
    { label: '前期末＝期首', render: (r) => h('td', null, skip(r) ? h('span', { class: 'muted small', title: '利益剰余金は会社別には比べません（全社で一致を確認）' }, '全社で比較') : r.prev === r.open ? statusBadge('ok', '一致') : statusBadge('ng', `差 ${fmt(r.prev - r.open)}`)) },
    { label: '手修正の引継', num: true, key: 'adj', calc: (r) => info(r, 'adj')() },
    { label: '当期の増減（開始仕訳以外）', num: true, key: 'move', calc: (r) => info(r, 'move')() },
    { label: '期末（連結修正の合計）', render: (r) => amt(r.end, { strong: true, calc: info(r, 'end') }) },
  ], list, { className: 'ws-table' });
  return h('section', { class: 'card', id: 'rollforward' }, h('h2', null, `残高の増減表と期間の連続性（${period.label}${view.company === 'all' ? '' : `・${view.company === 'CONSOL' ? '連結' : view.company}`}）`),
    h('div', { class: ng.length ? 'alert alert-err' : 'alert alert-ok' }, ng.length ? `${ng.length}科目で、前期末の残高と当期首の開始仕訳が一致しません。繰越設定・手修正・契約の変更（確定済み期間の数値の変更）を確認してください。` : '貸借対照表のすべての科目で、前期末の残高（前期末までの仕訳から別に計算）と当期首の開始仕訳が一致しています。'),
    h('div', { class: 'alert alert-info' }, '期末＝期首（開始仕訳）＋手修正の引継＋当期の増減。「繰越なし」の内容（流動・固定の組替など）と個社修正は、毎期末に計上し直すため「当期の増減」に含みます。利益剰余金（期首）の行は、前期末の損益の累計（繰越ありの内容）と開始仕訳の利益剰余金期首を比べます。手入力仕訳は前期末・期首の比較の対象外ですが、当期の増減・期末には含みます（仕訳帳で確認）。会社で抽出しているときは、利益剰余金（期首）の行は比べません（開始仕訳の利益剰余金は会社ごとの純資産修正額で配分し、損益は各行の会社に属するため。全社の表示で一致を確認できます）。金額を押すと契約・仕訳ごとの内訳を表示します。'),
    list.length ? tbl : h('p', { class: 'muted' }, '対象の残高はありません。'));
}

/** 税効果・非支配株主持分のプルーフ：会社別の純資産修正額 × 税率・持分比率（期首・期末）と仕訳の一致 */
function renderProofs(ctx) {
  const { gen, companies, pol, period } = ctx;
  const coName = (code) => companies.find((c) => c.code === code)?.name || code;
  const coMap = Object.fromEntries(companies.map((c) => [c.code, c]));
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  const sumAcc = (cid, co, acc) => gen.journals.filter((j) => j.contractId === cid).flatMap((j) => j.lines).filter((l) => l.co === co && l.acc === acc).reduce((a, l) => a + l.amt, 0);
  const taxRows = [], nciRows = [];
  for (const r of gen.results) {
    const c = r.contract;
    for (const co of [...new Set([c.lesseeCo, c.lessorCo])].filter((x) => view.company === 'all' || x === view.company)) {
      const dt = (r.DT.close[co] || 0) - (r.DT.open[co] || 0);
      if (!r.E.open[co] && !r.E.close[co] && !dt) continue;
      taxRows.push({ contract: c.id, co: coName(co), eo: r.E.open[co] || 0, to: pct(r.rates.tO[co] || 0), dto: r.DT.open[co] || 0, ec: r.E.close[co] || 0, tc: pct(r.rates.tC[co] || 0), dtc: r.DT.close[co] || 0, chg: dt, jr: sumAcc(c.id, co, 'TAX_ADJ') + gen.journals.filter((j) => j.contractId === c.id && (j.src || j.tpl) === 'C-13' && j.tpl !== 'C-01T').flatMap((j) => j.lines).filter((l) => l.co === co && l.acc === 'RE_OPEN').reduce((a, l) => a + l.amt, 0) });
    }
    const L = c.lesseeCo;
    if (view.company !== 'all' && view.company !== L) continue;
    if (r.NCI.open[L] || r.NCI.close[L] || r.cap.close) {
      const c14 = gen.journals.filter((j) => j.contractId === c.id && j.tpl === 'C-14').flatMap((j) => j.lines).filter((l) => l.co === L);
      nciRows.push({ contract: c.id, lessee: L, r, co: coName(L), no: r.NCI.open[L] || 0, ro: pct(r.rates.nO[L] || 0), nc: r.NCI.close[L] || 0, rc: pct(r.rates.nC[L] || 0), cap: (r.cap.close || 0) - (r.cap.open || 0), chg: (r.NCI.close[L] || 0) - (r.NCI.open[L] || 0),
        pl: c14.filter((l) => l.acc === 'NCI_PL').reduce((a, l) => a + l.amt, 0), trans: c14.filter((l) => l.acc === 'RE_OPEN').reduce((a, l) => a + l.amt, 0),
        sg: nciSegments(r.sched, coMap, pol, period.start, period.end),
        jr: -gen.journals.filter((j) => j.contractId === c.id).flatMap((j) => j.lines).filter((l) => l.co === L && l.acc === 'NCI' && true).reduce((a, l) => a + l.amt, 0) - (r.NCI.open[L] || 0) });
    }
  }
  // ── 期中の持分比率の変動：区間ごとの按分（計算の確認・会社別の集計） ──
  const ym = (i) => indexToJp(i);
  const span = (x) => (x.from === x.to ? ym(x.from) : `${ym(x.from)}〜${ym(x.to)}`);
  const ownLinks = (code) => [
    { label: `会社 ${code} の持分比率の推移`, go: () => goTo({ page: 'companies', target: `own-${code}` }) },
    { label: '検算 CHK-19（持分比率の推移）', go: () => goTo({ page: 'checks' }) },
  ];
  const monthlyInfo = (x) => () => {
    const R = (v) => round(v, pol['POL-11'] || 'half_up');
    const rows = [];
    for (let t = period.start; t <= period.end; t++) {
      const n = rateAt(coMap[x.lessee], t, 'nciRatio'), b0 = nciBase(x.r.sched, coMap, pol, t - 1, R), b1 = nciBase(x.r.sched, coMap, pol, t, R);
      rows.push({ ym: ym(t), n: pct(n), b0, b1, d: b1 - b0, a: n * (b1 - b0) });
    }
    const sum = rows.reduce((a, y) => a + y.a, 0);
    const dec = (v) => (v < 0 ? `△${Math.abs(v).toFixed(2)}` : v.toFixed(2)); // 端数処理前の額は小数2桁で示す
    for (const y of rows) y.aTxt = dec(y.a);
    return { context: `非支配株主持分のプルーフ・${period.label}`, title: `${x.contract}：月ごとの按分（基礎の増減 × その月の比率）`, value: dec(sum),
      breakdown: { title: `月ごとの内訳（${rows.length}か月）`, cols: [{ label: '年月', key: 'ym' }, { label: '比率', key: 'n' }, { label: '前月末の基礎', key: 'b0', num: true }, { label: '月末の基礎', key: 'b1', num: true }, { label: '基礎の増減', key: 'd', num: true }, { label: '按分額（端数処理前）', key: 'aTxt' }], rows: [...rows, { ym: '合計', n: '', b0: null, b1: null, d: rows.reduce((a, y) => a + y.d, 0), aTxt: `${dec(sum)}（仕訳 ${fmt(x.pl + x.trans)}）`, total: true }] },
      notes: ['仕訳は比率が同じ区間ごとに「期末の基礎×比率」と「期首の基礎×比率」をそれぞれ端数処理して差を取るため、この月ごとの合計（端数処理前）とは端数の範囲で異なることがあります。', '基礎＝借手・貸手の純資産修正額の合計から税効果を控除した額（月末）。'],
      sources: [{ label: '返済・償却スケジュール（月次）' }], links: ownLinks(x.lessee) };
  };
  const plInfo = (x) => () => ({
    context: `非支配株主持分のプルーフ・${period.label}`, title: `${x.contract}：当期の非支配株主帰属額（${x.co}）`, value: x.pl,
    formula: [...x.sg.segments.flatMap((y, i) => [...(i ? ['＋'] : []), { label: `${span(y)} × ${pct(y.n)}`, value: y.amt }]), ...(x.trans ? ['−', { label: '適用時の累積的影響額分（期首利益剰余金）', value: x.trans }] : [])],
    expr: `${x.sg.segments.map((y) => fmt(y.amt)).join(' ＋ ')}${x.trans ? ` − ${fmt(x.trans)}` : ''} ＝ ${fmt(x.pl)}`,
    breakdown: { title: `比率が同じ区間ごとの按分（${x.sg.segments.length}区間）`, cols: [{ label: '区間', key: 'span' }, { label: '非支配株主持分比率', key: 'n' }, { label: '区間の期首の基礎', key: 'b0', num: true }, { label: '区間の期末の基礎', key: 'b1', num: true }, { label: '按分額', key: 'amt', num: true }], rows: [...x.sg.segments.map((y) => ({ span: span(y), n: pct(y.n), b0: y.b0, b1: y.b1, amt: y.amt })), { span: '合計', n: '', b0: null, b1: null, amt: x.sg.segments.reduce((a, y) => a + y.amt, 0), total: true }] },
    notes: ['区間ごとの按分額＝期末の基礎×比率（端数処理）−期首の基礎×比率（端数処理）。持分比率はみなし日の翌月から変わります。', ...(x.sg.changes.length ? [`期中の比率の変更：${x.sg.changes.map((y) => `${ym(y.at)}から ${pct(y.n0)}→${pct(y.n1)}`).join('、')}（変更による按分替えは資本剰余金。「うち持分変動」の金額を押すと内訳を表示）`] : [])],
    more: [{ label: '月ごとの内訳を見る', desc: '各月の基礎の増減×その月の比率（端数処理前）', open: monthlyInfo(x) }],
    sources: [{ label: '仕訳 C-14' }], links: ownLinks(x.lessee),
  });
  const capInfo = (x) => () => ({
    context: `非支配株主持分のプルーフ・${period.label}`, title: `${x.contract}：持分変動による按分替え（資本剰余金）`, value: x.cap,
    breakdown: { title: `比率が変わった月（${x.sg.changes.length}回）`, cols: [{ label: '新しい比率を使う月', key: 'at' }, { label: '前月末の基礎', key: 'base', num: true }, { label: '変更前の比率', key: 'n0' }, { label: '変更後の比率', key: 'n1' }, { label: '持分変動', key: 'cap', num: true }], rows: [...x.sg.changes.map((y) => ({ at: ym(y.at), base: y.base, n0: pct(y.n0), n1: pct(y.n1), cap: y.cap })), { at: '合計', base: null, n0: '', n1: '', cap: x.sg.changes.reduce((a, y) => a + y.cap, 0), total: true }] },
    notes: ['持分変動＝変更月の前月末の基礎×変更後の比率（端数処理）−同×変更前の比率（端数処理）。親会社の持分が変わる資本取引のため、損益ではなく資本剰余金で処理します（会計方針 POL-14）。'],
    sources: [{ label: '仕訳 C-14' }], links: ownLinks(x.lessee),
  });
  const pathTxt = (x) => (x.sg.segments.length > 1 ? x.sg.segments.map((y) => `${pct(y.n)}（${span(y)}）`).join('→') : x.sg.changes.length ? `${pct(x.sg.changes[0].n0)}→${pct(x.sg.segments[0]?.n ?? 0)}（期首）` : '期中の変更なし');
  const tot = (rows, f) => rows.reduce((a, x) => a + (x[f] || 0), 0);
  const judge = (x) => h('td', null, x.chg === x.jr ? statusBadge('ok', '一致') : statusBadge('warn', `差 ${fmt(x.jr - x.chg)}`));
  const taxTbl = table([
    { label: '契約', key: 'contract', nowrap: true }, { label: '会社', key: 'co' },
    { label: '期首の純資産修正額', key: 'eo', num: true }, { label: '期首税率', key: 'to' }, { label: '期首の取消額', key: 'dto', num: true },
    { label: '期末の純資産修正額', key: 'ec', num: true }, { label: '期末税率', key: 'tc' }, { label: '期末の取消額', key: 'dtc', num: true },
    { label: '当期の増減（期末−期首）', key: 'chg', num: true }, { label: '仕訳（法人税等調整額等）', key: 'jr', num: true }, { label: '判定', render: judge },
  ], [...taxRows, { contract: '合計', co: '', eo: tot(taxRows, 'eo'), to: '', dto: tot(taxRows, 'dto'), ec: tot(taxRows, 'ec'), tc: '', dtc: tot(taxRows, 'dtc'), chg: tot(taxRows, 'chg'), jr: tot(taxRows, 'jr'), total: true }], { rowClass: (x) => (x.total ? 'total' : '') });
  const nciTbl = table([
    { label: '契約', key: 'contract', nowrap: true }, { label: '借手の会社', key: 'co' },
    { label: '期首の非支配株主持分', key: 'no', num: true }, { label: '期首の比率', key: 'ro' },
    { label: '期末の非支配株主持分', key: 'nc', num: true }, { label: '期末の比率', key: 'rc' },
    { label: '期中の比率（区間）', render: (x) => h('td', { class: 'small' }, x.total ? '' : pathTxt(x)) },
    { label: '当期の非支配株主帰属額（損益）', render: (x) => amt(x.pl, { calc: x.total ? null : plInfo(x) }) },
    { label: 'うち持分変動（資本剰余金）', render: (x) => amt(x.cap, { calc: x.total || !x.sg.changes.length ? null : capInfo(x) }) }, { label: '当期の増減（期末−期首）', key: 'chg', num: true }, { label: '仕訳（非支配株主持分の増減）', key: 'jr', num: true }, { label: '判定', render: judge },
  ], [...nciRows, { contract: '合計', co: '', no: tot(nciRows, 'no'), ro: '', nc: tot(nciRows, 'nc'), rc: '', pl: tot(nciRows, 'pl'), cap: tot(nciRows, 'cap'), chg: tot(nciRows, 'chg'), jr: tot(nciRows, 'jr'), total: true }], { rowClass: (x) => (x.total ? 'total' : '') });
  // 会社別：比率が同じ区間ごとの基礎の増減・按分額（全契約の合計）と、仕訳の非支配株主帰属額との一致
  const byCo = new Map();
  for (const x of nciRows) {
    const g = byCo.get(x.lessee) || byCo.set(x.lessee, { seg: new Map(), ch: new Map(), pl: 0, trans: 0 }).get(x.lessee);
    g.pl += x.pl; g.trans += x.trans;
    for (const y of x.sg.segments) { const k = `${y.from}-${y.to}`; const o = g.seg.get(k) || g.seg.set(k, { span: span(y), n: y.n, db: 0, amt: 0 }).get(k); o.db += y.b1 - y.b0; o.amt += y.amt; }
    for (const y of x.sg.changes) { const o = g.ch.get(y.at) || g.ch.set(y.at, { at: y.at, n0: y.n0, n1: y.n1, base: 0, cap: 0 }).get(y.at); o.base += y.base; o.cap += y.cap; }
  }
  const coSegTbl = byCo.size ? h('div', null, h('h3', null, '会社別：持分比率が同じ区間ごとの按分（全契約の合計）'),
    ...[...byCo].map(([code, g]) => {
      const segSum = [...g.seg.values()].reduce((a, y) => a + y.amt, 0);
      const ok = segSum - g.trans === g.pl;
      return h('div', { class: 'own-seg' }, h('div', { class: 'row' }, h('b', null, `${code} ${coName(code)}`), ' ', h('button', { class: 'btn-link', type: 'button', on: { click: () => goTo({ page: 'companies', target: `own-${code}` }) } }, '持分比率の推移を見る'), ' ', ok ? statusBadge('ok', '区間の合計＝仕訳の非支配株主帰属額') : statusBadge('ng', `差 ${fmt(g.pl - (segSum - g.trans))}`)),
        table([{ label: '区間', key: 'span' }, { label: '非支配株主持分比率', render: (y) => h('td', null, y.total || y.n === null ? '' : pct(y.n)) }, { label: '基礎の増減', key: 'db', num: true }, { label: '按分額（＝基礎の増減×比率。契約ごとに端数処理）', key: 'amt', num: true }],
          [...g.seg.values(), ...(g.trans ? [{ span: '適用時の累積的影響額分（期首利益剰余金へ）', n: null, db: null, amt: -g.trans, total: false }] : []), { span: '当期の非支配株主帰属額（仕訳 C-14）', n: 0, db: [...g.seg.values()].reduce((a, y) => a + y.db, 0), amt: g.pl, total: true }], { className: 'compact', rowClass: (y) => (y.total ? 'total' : '') }),
        g.ch.size ? table([{ label: '持分比率の変更', render: (y) => h('td', null, `${ym(y.at)}から ${pct(y.n0)}→${pct(y.n1)}`) }, { label: '前月末の基礎', key: 'base', num: true }, { label: '持分変動（資本剰余金）', key: 'cap', num: true }], [...g.ch.values()], { className: 'compact' }) : null);
    })) : null;
  return [
    h('section', { class: 'card', id: 'tax-proof' }, h('h2', null, `税効果のプルーフ（${period.label}）`),
      h('div', { class: 'alert alert-info' }, `個別で計上した税効果の取消額＝会社別の純資産修正額（消去による連結上の純資産の増減）× 法定実効税率（繰延税金資産の側は計上割合を反映）。当期の法人税等調整額＝期末の取消額−期首の取消額（税率変更の影響を含む）。会計方針 POL-02：${pol['POL-02'] === 'reverse' ? '個別税効果を取り消す' : '税効果を認識しない'}。`),
      taxRows.length ? taxTbl : h('p', { class: 'muted' }, '税効果の取消はありません。')),
    h('section', { class: 'card', id: 'nci-proof' }, h('h2', null, `非支配株主持分のプルーフ（${period.label}）`),
      h('div', { class: 'alert alert-info' }, `非支配株主持分＝（借手・貸手の税効果後の修正額の合計）× 借手の非支配株主持分比率。比率の変動による按分替えは資本剰余金（資本取引）。会計方針 POL-01：${pol['POL-01'] === 'allocate' ? '借手の比率で按分する' : '按分しない'}。`),
      nciRows.length ? h('div', null, coSegTbl, h('h3', null, '契約別'), nciTbl) : h('p', { class: 'muted' }, '非支配株主持分への按分はありません。')),
  ];
}

/** 注記（新リース会計基準）：連結の注記額＝各社の注記額の合計（収集表）−グループ内リース分 */
function renderNotes(ctx) {
  const { gen, companies, pol, period, unit, data } = ctx;
  const pk = notePeriodKey(period);
  const g = groupNoteAmounts(gen, period, pol, companies);
  const inputs = data.noteInputs?.[pk] || {};
  if (noteView.co !== 'all' && !companies.some((c) => c.code === noteView.co)) noteView.co = 'all';
  const rows = consolidatedNotes(g, inputs);
  const coName = (code) => companies.find((c) => c.code === code)?.name || code;
  const collected = Object.keys(inputs).length;
  const KIND = { calc: 'アプリで計算', input: '各社が記入', na: 'グループ内なし', text: '文章で記載' };

  // 数値を押したときの「計算の確認」
  const info = (r, col) => () => {
    const it = r.item;
    const title = `${it.title}${r.sub ? `：${r.sub}` : ''}`;
    if (col === 'total') {
      return { context: `注記・${period.label}`, title: `${title}（各社の注記額の合計）`, value: r.total,
        // 会社ごとに、収集値・うちグループ内分（アプリの計算値または記入値）・グループ外分（差）を並べて確かめられるようにする
        breakdown: (() => {
          const grpOf = (co) => (it.kind === 'input' ? inputs[co]?.[r.key]?.group ?? 0 : r.groupRows.filter((x) => x.co === co).reduce((a, x) => a + x.amt, 0));
          const rs = r.totalRows.map((x) => ({ name: `${x.co} ${coName(x.co)}`, amt: x.amt, grp: grpOf(x.co), ext: x.amt - grpOf(x.co) }));
          return { title: `会社ごとの収集値と、うちグループ内分（${r.totalRows.length}社）`, cols: [{ label: '会社', key: 'name' }, { label: '各社の注記額（収集値）', key: 'amt', num: true }, { label: 'うちグループ内分', key: 'grp', num: true }, { label: 'グループ外分（差）', key: 'ext', num: true }],
            rows: [...rs, { name: '合計', amt: r.total ?? 0, grp: rs.reduce((a, x) => a + x.grp, 0), ext: rs.reduce((a, x) => a + x.ext, 0), total: true }] };
        })(),
        notes: [it.desc, ...r.memos.map((m) => `${m.co} 備考：${m.memo}`)], sources: [{ label: '各社の収集表' }] };
    }
    const isCalc = it.kind === 'calc';
    const cons = col === 'cons' && r.total !== null;
    return { context: `注記・${period.label}`, title: `${title}（${cons ? '連結の注記額' : 'うちグループ内リース分'}）`, value: cons ? r.consolidated : r.group,
      formula: cons ? [{ label: '各社の注記額の合計', value: r.total }, '−', { label: 'うちグループ内リース', value: r.group }] : [],
      expr: cons ? `${fmt(r.total)} − ${fmt(r.group)} ＝ ${fmt(r.consolidated)}` : '',
      breakdown: { title: isCalc ? `グループ内リース分：契約ごとの内訳（${r.groupRows.length}件）` : `グループ内リース分：会社ごとの記入値（${r.groupRows.length}社）`, cols: [{ label: '契約', key: 'contract' }, { label: '会社', key: 'name' }, { label: '金額', key: 'amt', num: true }], rows: [...r.groupRows.map((x) => ({ ...x, name: `${x.co} ${coName(x.co)}` })), { contract: '合計', name: '', amt: r.group, total: true }] },
      notes: [it.desc, ...r.groupRows.filter((x) => x.note).map((x) => `${x.contract}：${x.note}`), it.kind === 'input' ? 'アプリでは計算しない項目のため、各社が収集表に記入した「うちグループ会社とのリース分」を使います。' : it.kind === 'na' || it.kind === 'text' ? 'グループ内リースはオペレーティング・リースとして扱うため、グループ内の分はありません。' : '契約の条件からアプリが計算した額です。'],
      sources: isCalc ? [{ label: '契約・スケジュール' }] : [{ label: '各社の収集表' }] };
  };

  // 表：区分の見出し → 注記項目（説明つき）→ 内訳（科目別・期間別）
  const numTd = (v, calc, strong) => (v === null ? h('td', { class: 'num muted' }, '未収集') : amt(v, { calc, strong }));
  // 注記は区分（情報の種類）ごとに表を分ける。各表に見出しを付け、画面内の移動（左のメニュー）から飛べるようにする
  const secTables = [];
  for (const sec of NOTE_SECTIONS) {
    const tbody = [];
    const items = [...new Set(rows.filter((r) => r.item.sec === sec.id).map((r) => r.item))];
    for (const it of items) {
      const rs = rows.filter((r) => r.item === it);
      const badgeCls = { calc: 'badge ok', input: 'badge caution', na: 'badge', text: 'badge' }[it.kind];
      const descTd = () => h('td', { class: 'small' }, h('span', { class: badgeCls }, KIND[it.kind]), ' ', it.desc);
      if (!(it.byClass || it.byBucket || it.byList)) {
        const r = rs[0];
        if (it.kind === 'text') {
          // 文章で記載する注記：金額ではなく、各社の備考（文章）を集める。記入した会社数を示し、押すと文章を表示する
          const memoInfo = () => ({ context: `注記・${period.label}`, title: `${it.title}（各社の備考）`, value: `${r.memos.length}社`,
            breakdown: { title: `各社の備考（${r.memos.length}社）`, cols: [{ label: '会社', key: 'name' }, { label: '備考（文章の注記）', key: 'memo' }], rows: r.memos.map((x) => ({ name: `${x.co} ${coName(x.co)}`, memo: x.memo })) },
            notes: [it.desc], sources: [{ label: '各社の収集表' }] });
          const memoTd = () => { const td = h('td', { class: r.memos.length ? 'small' : 'num muted' }, r.memos.length ? `文章（${r.memos.length}社が記入）` : '未収集'); if (r.memos.length) calcable(td, memoInfo); return td; };
          tbody.push(h('tr', null, h('td', null, h('b', null, it.title)), h('td', null, it.when), memoTd(), amt(r.group, { calc: info(r, 'group') }), amt(r.adj, { calc: info(r, 'group') }), h('td', { class: 'small muted' }, '文章で記載'), descTd()));
          continue;
        }
        tbody.push(h('tr', null, h('td', null, h('b', null, it.title)), h('td', null, it.when), numTd(r.total, info(r, 'total')), amt(r.group, { calc: info(r, 'group') }), amt(r.adj, { calc: info(r, 'group') }), numTd(r.consolidated, info(r, 'cons'), true), descTd()));
        continue;
      }
      // 科目別は値のある科目だけ、期間別はすべての期間を表示
      const shown = it.byClass ? rs.filter((r) => r.group || r.total !== null) : rs;
      // 合計は、表示しているすべての内訳が収集済みのときだけ表示する（一部だけの合計は誤解を招くため）
      const anyTotal = shown.some((r) => r.total !== null);
      const allTotal = shown.length > 0 && shown.every((r) => r.total !== null);
      const sum = (f) => shown.reduce((a, r) => a + (r[f] || 0), 0);
      const partial = h('td', { class: 'num muted small' }, anyTotal ? '一部未収集' : '');
      tbody.push(h('tr', null, h('td', null, h('b', null, it.title)), h('td', null, it.when),
        allTotal ? h('td', { class: 'num' }, fmt(sum('total'))) : partial, h('td', { class: 'num' }, fmt(sum('group'))), h('td', { class: 'num' }, fmt(sum('adj'))),
        allTotal ? h('td', { class: 'num strong' }, fmt(sum('total') - sum('group'))) : h('td', { class: 'num muted small' }, anyTotal ? '一部未収集' : ''), descTd()));
      if (!shown.length) tbody.push(h('tr', { class: 'sub' }, h('td', { class: 'indent muted' }, '該当なし'), ...Array.from({ length: 6 }, () => h('td', null, ''))));
      for (const r of shown) tbody.push(h('tr', { class: 'sub' }, h('td', { class: 'indent' }, r.sub), h('td', null, ''), numTd(r.total, info(r, 'total')), amt(r.group, { calc: info(r, 'group') }), amt(r.adj, { calc: info(r, 'group') }), numTd(r.consolidated, info(r, 'cons'), true), h('td', null, '')));
    }
    if (!tbody.length) continue;
    secTables.push(h('section', { class: 'note-sec', id: `note-${sec.id}`, 'data-nav': `注記：【${sec.side}】${sec.title}` },
      h('h3', { class: 'note-sec-title' }, `【${sec.side}】${sec.title}`, h('span', { class: 'muted small' }, `（${sec.ref}）`)),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl ws-table ws-notes' },
        h('thead', null, h('tr', null, ['注記項目', '時点', '各社の注記額の合計（収集値）', 'うちグループ内リース', '連結注記での調整', '連結の注記額', 'どのような情報か（根拠）'].map((t) => h('th', null, t)))),
        h('tbody', null, tbody)))));
  }
  const tableEl = h('div', { class: 'note-secs' }, secTables);

  // 記入済みの収集表の読込：誤りがあれば何も読み込まない
  const fileInput = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv', hidden: true, on: { change: async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast('ファイルが大きすぎます（上限10MB）', 'error');
    const buf = await f.arrayBuffer();
    let r;
    if (/\.xlsx$/i.test(f.name) || new Uint8Array(buf.slice(0, 2)).join() === '80,75') r = await importNoteCollectionXlsx(new Uint8Array(buf), companies, period); // Excel（ZIP 形式）
    else {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('shift_jis').decode(buf); }
      r = importNoteCollection(text, companies, period);
    }
    if (r.errors.length) {
      await ask({ title: `読み込めませんでした（誤り ${r.errors.length}件）`, message: 'ファイルを直してから、もう一度読み込んでください。何も読み込んでいません。', body: h('ul', { class: 'err-list' }, r.errors.slice(0, 30).map((x) => h('li', null, x))), okLabel: '閉じる' });
      return;
    }
    const cos = Object.keys(r.inputs);
    if (!cos.length) return toast('記入された金額がありません', 'error');
    if (!(await ask({ title: `${cos.length}社・${r.count}件の注記額を読み込みますか？`, message: `${period.label}の収集値として保存します。同じ会社の既存の収集値は置き換えます（${cos.join('、')}）。`, okLabel: '読み込む' }))) return;
    update((d) => { d.noteInputs = d.noteInputs || {}; d.noteInputs[pk] = { ...(d.noteInputs[pk] || {}), ...r.inputs }; }, '注記の収集値の読込', `${period.label}：${cos.join('、')}（${r.count}件）`);
    toast('読み込みました');
  } } });
  const exportTable = () => download(`注記_${period.label}.csv`, toCsv([
    ['区分', '情報の種類（根拠）', '注記項目', '内訳', '時点', '各社の注記額の合計（収集値）', 'うちグループ内リース', '連結注記での調整', '連結の注記額', 'グループ内分の求め方', 'どのような情報か'],
    ...rows.map((r) => { const sec = NOTE_SECTIONS.find((x) => x.id === r.item.sec); return [sec.side, `${sec.title}（${sec.ref}）`, r.item.title, r.sub, r.item.when, r.total ?? '', r.group, r.adj, r.consolidated ?? '', KIND[r.item.kind], r.item.desc]; }),
  ]), 'text/csv;charset=utf-8');

  const mat = (id) => BUCKETS.map((b) => g.get(`${id}.${b.key}`).amount);
  // 各社の提出状況：記入済みの項目数（注記額・グループ分・備考のいずれか）。グループ内リースのある会社で未提出のものを目立たせる
  const statusTable = () => {
    const nRows = noteRows().length;
    const involved = new Set(data.contracts.flatMap((c) => [c.lessorCo, c.lesseeCo]));
    const st = companies.map((c) => {
      const m = inputs[c.code] || {};
      const filled = Object.values(m).filter((x) => x && (x.total !== null || x.group !== null || x.memo)).length;
      // 記入が必要な項目：この会社にグループ内リース分がある行（個別の注記額にグループ内の分が含まれるため、各社の注記額の記入が必要）
      const req = [...g].filter(([, v]) => v.rows.some((x) => x.co === c.code)).map(([k]) => k);
      const reqFilled = req.filter((k) => m[k] && m[k].total !== null && m[k].total !== undefined);
      const state = filled === 0 ? '未提出' : reqFilled.length < req.length ? '一部記入' : '提出済み';
      return { code: c.code, name: c.name, filled, req: req.length, reqFilled: reqFilled.length, missing: req.filter((k) => !reqFilled.includes(k)), involved: involved.has(c.code), state };
    });
    const label = (k) => { const r = noteRows().find((x) => x.key === k); return r ? `${r.item.title}${r.sub ? `（${r.sub}）` : ''}` : k; };
    return h('details', { class: 'basis', open: st.some((x) => x.involved && x.state !== '提出済み') && collected > 0 },
      h('summary', null, `各社の提出状況（提出済み ${st.filter((x) => x.state === '提出済み').length}社・一部記入 ${st.filter((x) => x.state === '一部記入').length}社／${companies.length}社）`),
      table([
        { label: '会社', render: (x) => h('td', null, `${x.code} ${x.name}`) },
        { label: 'グループ内リース', render: (x) => h('td', null, x.involved ? 'あり' : 'なし') },
        { label: '状態', render: (x) => h('td', null, x.state === '提出済み' ? statusBadge('ok', '提出済み') : x.state === '一部記入' ? statusBadge('warn', '一部記入') : x.involved ? statusBadge('ng', '未提出') : h('span', { class: 'muted' }, '未提出')) },
        { label: '記入が必要な項目（グループ内リース分のある行）', render: (x) => h('td', { class: 'num', title: x.missing.length ? `未記入：${x.missing.map(label).join('、')}` : '' }, x.req ? `${x.reqFilled}／${x.req}` : '－') },
        { label: '未記入の必要な項目', render: (x) => h('td', { class: 'small', title: x.filled && x.missing.length > 5 ? x.missing.map(label).join('、') : '' }, x.filled && x.missing.length ? `${x.missing.slice(0, 5).map(label).join('、')}${x.missing.length > 5 ? ` ほか${x.missing.length - 5}項目` : ''}` : '') },
        { label: '記入済みの項目（全体）', render: (x) => h('td', { class: 'num' }, `${x.filled}／${nRows}`) },
        { label: '収集用Excel', render: (x) => h('td', null, h('button', { class: 'btn btn-sm', type: 'button', title: `${x.code} に配る収集用 Excel（記入済みの値を含む）を書き出します`, on: { click: () => saveFile(`注記の収集表_${period.label}_${x.code}.xlsx`, noteCollectionXlsx(companies.filter((c) => c.code === x.code), period, g, inputs), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') } }, '書き出す')) },
      ], st, { className: 'compact' }));
  };
  return card('注記（新リース会計基準）',
    h('div', { class: 'alert alert-info' }, '開示目的は、リースが財政状態・経営成績・キャッシュ・フローに与える影響を財務諸表利用者が評価するための情報を提供することです（会計基準第54項）。会計方針に関する情報（適用指針第97項）は文章で記載するため、この表の対象外です。重要性に乏しい事項は記載を省略できます（会計基準第55項ただし書き）。'),
    h('div', { class: 'alert alert-info' }, '連結の注記額＝各社の個別の注記額の合計−うちグループ内リース分。①「収集用Excelを書き出す」で各社に配る Excel（シート2枚：「注記の収集表」と「記入方法・チェック」）を作り、②各社が黄色のセルに「各社の注記額」（グループ会社とのリースも含めた個別の注記額）と、アプリで計算しない項目の「うちグループ会社とのリース分」を記入し、③「記入済みのExcelを読み込む」で取り込みます（CSV 版も読み込めます）。「アプリで計算」の項目のグループ内リース分は契約から自動で計算します。金額を押すと会社・契約ごとの内訳を表示します。'),
    h('div', { class: 'actions' },
      // 収集表は全社まとめて、または会社ごとに（各社に配るため）書き出せる
      h('label', null, '対象 ', select([['all', 'すべての会社（1ファイル）'], ...companies.map((c) => [c.code, `${c.code} ${c.name}`])], noteView.co, (v) => { noteView.co = v; })),
      h('button', { class: 'btn btn-primary', type: 'button', title: '各社に配る収集用の Excel（シート2枚：注記の収集表／記入方法・チェック）。黄色のセルだけ入力できます', on: { click: () => { const cs = noteView.co === 'all' ? companies : companies.filter((c) => c.code === noteView.co); saveFile(`注記の収集表_${period.label}${noteView.co === 'all' ? '' : `_${noteView.co}`}.xlsx`, noteCollectionXlsx(cs, period, g, inputs), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); } } }, '① 収集用Excelを書き出す'),
      h('button', { class: 'btn', type: 'button', on: { click: () => fileInput.click() } }, '③ 記入済みのExcelを読み込む'), fileInput,
      h('button', { class: 'btn btn-sm', type: 'button', title: 'Excel を使わない場合の収集表（CSV）。読込は Excel・CSV のどちらも可', on: { click: () => { const cs = noteView.co === 'all' ? companies : companies.filter((c) => c.code === noteView.co); download(`注記の収集表_${period.label}${noteView.co === 'all' ? '' : `_${noteView.co}`}.csv`, noteCollectionCsv(cs, period, g, inputs), 'text/csv;charset=utf-8'); } } }, '収集表（CSV版）'),
      h('button', { class: 'btn', type: 'button', on: { click: exportTable } }, '注記の表を書き出す（CSV）'),
      collected ? h('button', { class: 'btn btn-danger', type: 'button', on: { click: async () => { if (await ask({ title: `${period.label}の収集値を消去しますか？`, message: `${collected}社分の収集値を消去します。グループ内リース分（アプリの計算値）は消えません。`, okLabel: '消去する', danger: true })) update((d) => { delete d.noteInputs[pk]; }, '注記の収集値の消去', period.label); } } }, 'この期間の収集値を消去') : null,
      h('span', { class: 'muted' }, collected ? `収集済み：${collected}社／${companies.length}社` : '収集値はまだありません（各社の注記額の列は「未収集」）')),
    statusTable(),
    tableEl,
    barChart({ wide: true, title: '決算日後の期間別：グループ内の借手のリース料と貸手の受取リース料', subtitle: '同じ契約の支払と受取のため、借手の短期・少額リース等や貸手のリース期間の違いを除けばほぼ一致します', labels: BUCKETS.map((b) => b.label), series: [{ name: '借手：リース負債の返済予定額（割引前）', values: mat('X-LL'), color: COLORS.lessee }, { name: '借手：元本', values: mat('X-LLP'), color: 'var(--s5)' }, { name: '貸手：リース料の回収予定額（オペレーティング＋ファイナンス）', values: mat('R-MAT').map((v, i) => v + mat('R-FMAT')[i]), color: COLORS.lessor }], unit, height: 240 }));
}
