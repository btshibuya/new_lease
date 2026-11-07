import { h, card, table, amt, statusBadge, download, ask, toast, select } from '../dom.js';
import { COLORS } from '../components.js';
import { waterfall, barChart } from '../charts.js';
import { worksheet, MUST_BE_ZERO, cashFlowEliminations } from '../../engine/reports.js';
import { NOTE_SECTIONS, BUCKETS, groupNoteAmounts, consolidatedNotes, noteCollectionCsv, importNoteCollection, notePeriodKey } from '../../engine/notes.js';
import { update } from '../store.js';
import { focusJournals } from './journals.js';
import { contentOrder } from '../components.js';

// 列の粒度：kind＝区分別（個社修正・連結修正）、content＝内容別（開始仕訳も内容別）、content_open＝内容別（開始仕訳・洗替はまとめる）
const view = { gran: 'kind' };
const GRANS = [['kind', '区分別（個社修正・連結修正）'], ['content_open', '内容別（開始仕訳はまとめる）'], ['content', '内容別（開始仕訳も内容別）']];
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
  const links = (r, contentKey) => [
    { label: `元帳（${r.label}）`, go: () => focusJournals({ account: r.label }) },
    ...(contentKey && contentKey !== 'OPEN' ? [{ label: `仕訳帳（${contentKey.replace(':', '・')}）`, go: () => focusJournals({ content: contentKey }) }] : contentKey === 'OPEN' ? [{ label: '仕訳帳（開始仕訳・洗替）', go: () => focusJournals({ content: 'OPEN' }) }] : [{ label: '仕訳帳（すべて）', go: () => focusJournals({}) }]),
  ];
  const contentInfo = (r, cc) => () => {
    const items = r.items.filter((x) => (x.col === 'ind' || x.col === 'con') && colKeyOf(x) === cc.key && x.amt);
    return { context: `連結精算表・${period.label}（借方＋／貸方△）`, title: `${r.label}：${cc.key === 'OPEN' ? '' : `${cc.key.replace(':', '・')} `}${cc.title}`, value: r.byContent[cc.key] || 0,
      breakdown: { title: `内訳（${items.length}件）`, cols: [{ label: '契約', key: 'contract' }, { label: '元の仕訳', key: 'src' }, { label: '金額', key: 'amt', num: true }], rows: [...items, { contract: '合計', src: '', amt: items.reduce((a, x) => a + x.amt, 0), total: true }] },
      sources: [{ label: '仕訳', kind: 'journal' }], links: links(r, cc.key) };
  };
  const withLinks = (fn, r, key) => () => ({ ...fn(), links: links(r, null) });
  const cols = [
    { label: '科目', render: (r) => h('td', null, r.label, MUST_BE_ZERO.includes(r.acc) ? h('span', { class: 'co' }, 'グループ内：連結後0') : null) },
    { label: '借手個別（アプリ計算値）', num: true, key: 'lessee', calc: (r) => cellInfo(r, 'lessee')() },
    { label: '貸手個別（アプリ計算値）', num: true, key: 'lessor', calc: (r) => cellInfo(r, 'lessor')() },
    { label: '単純合算', num: true, key: 'simple', calc: (r) => cellInfo(r, 'simple')() },
    ...(view.gran === 'kind' ? [
      { label: '個社修正', num: true, key: 'ind', calc: (r) => withLinks(cellInfo(r, 'ind'), r)() },
      { label: '連結修正', num: true, key: 'con', calc: (r) => withLinks(cellInfo(r, 'con'), r)() },
    ] : contentCols.map((cc) => ({ label: cc.key === 'OPEN' ? '開始仕訳・洗替' : `${cc.key.replace(':', '・')} ${cc.title.replace(/^開始仕訳：/, '開始：').replace(/^洗替：/, '洗替：').replace(/（.*$/, '').slice(0, 14)}`, title: cc.title, num: true, render: (r) => r.byContent[cc.key] ?? null, calc: (r) => contentInfo(r, cc)() }))),
    { label: '連結', render: (r) => amt(r.consol, { strong: true, calc: withLinks(cellInfo(r, 'consol'), r) }) },
    { label: '判定', render: (r) => h('td', null, MUST_BE_ZERO.includes(r.acc) ? (r.consol === 0 ? statusBadge('ok', '0') : statusBadge('ng', '残高あり')) : '') },
  ];
  const granSel = h('label', null, '列の粒度 ', select(GRANS, view.gran, (v) => { view.gran = v; window.dispatchEvent(new HashChangeEvent('hashchange')); }));
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
  const exportWs = () => download(`連結精算表_${period.label}.csv`, toCsv(view.gran === 'kind'
    ? [['科目', '借手個別（アプリ計算値）', '貸手個別（アプリ計算値）', '単純合算', '個社修正', '連結修正', '連結'], ...ws.map((r) => [r.label, r.lessee, r.lessor, r.simple, r.ind, r.con, r.consol])]
    : [['科目', '借手個別（アプリ計算値）', '貸手個別（アプリ計算値）', '単純合算', ...contentCols.map((cc) => (cc.key === 'OPEN' ? cc.title : `${cc.key} ${cc.title}`)), '連結'], ...ws.map((r) => [r.label, r.lessee, r.lessor, r.simple, ...contentCols.map((cc) => r.byContent[cc.key] ?? 0), r.consol])]), 'text/csv;charset=utf-8');
  const notesCard = renderNotes(ctx);

  return h('div', { class: 'page' },
    card('連結精算表（グループ内リース関連科目、借方＋／貸方△）',
      h('div', { class: 'alert alert-info' }, '個別の金額はアプリの計算値です（個別帳簿との一致は「検算 CHK-10」で確認）。「グループ内：連結後0」の科目が0になっていれば消去は完全です。'),
      h('div', { class: 'actions' }, granSel, h('button', { class: 'btn', type: 'button', on: { click: exportWs } }, '表を書き出す（CSV）'), h('span', { class: 'muted small' }, '金額を押すと内訳を表示し、元帳・仕訳帳へ移動できます。')),
      h('h3', null, '貸借対照表'), table(cols, bs, { className: 'ws-table' }),
      h('h3', null, '損益計算書'), table(cols, pl, { className: 'ws-table' })),
    card(null, waterfall({ wide: true, title: '損益のブリッジ：単純合算 → 連結（税引前）→ 税引後 → 親会社株主帰属（グループ内リース関連）', subtitle: '各棒にカーソルを合わせると内容を表示。連結（税引前）に残るのは主に貸手資産の減価償却費（組替後）', steps, unit })),
    card('連結キャッシュ・フロー計算書の消去データ', table([
      { label: '項目', key: 'label' }, { label: '区分', key: 'section' }, { label: '個別計上額', key: 'amount', num: true, calc: cfInfo }, { label: '消去額', key: 'elim', num: true, calc: cfInfo },
    ], cf.items, { className: 'ws-table' }), h('div', { class: 'alert alert-info' }, `借手の支払と貸手の受取は連結上相殺されます（差額 ${fmt(cf.check)}）。利息の支払額の区分は会計方針 POL-09 に従います。`)),
    notesCard);
}

/** 注記（新リース会計基準）：連結の注記額＝各社の注記額の合計（収集表）−グループ内リース分 */
function renderNotes(ctx) {
  const { gen, companies, pol, period, unit, data } = ctx;
  const pk = notePeriodKey(period);
  const g = groupNoteAmounts(gen, period, pol);
  const inputs = data.noteInputs?.[pk] || {};
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
        breakdown: { title: `会社ごとの収集値（${r.totalRows.length}社）`, cols: [{ label: '会社', key: 'name' }, { label: '注記額', key: 'amt', num: true }], rows: [...r.totalRows.map((x) => ({ name: `${x.co} ${coName(x.co)}`, amt: x.amt })), { name: '合計', amt: r.total ?? 0, total: true }] },
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
  const tbody = [];
  const numTd = (v, calc, strong) => (v === null ? h('td', { class: 'num muted' }, '未収集') : amt(v, { calc, strong }));
  for (const sec of NOTE_SECTIONS) {
    tbody.push(h('tr', { class: 'sec' }, h('th', { colspan: 7 }, `【${sec.side}】${sec.title}（${sec.ref}）`)));
    const items = [...new Set(rows.filter((r) => r.item.sec === sec.id).map((r) => r.item))];
    for (const it of items) {
      const rs = rows.filter((r) => r.item === it);
      const badgeCls = { calc: 'badge ok', input: 'badge caution', na: 'badge', text: 'badge' }[it.kind];
      const descTd = () => h('td', { class: 'small' }, h('span', { class: badgeCls }, KIND[it.kind]), ' ', it.desc);
      if (!(it.byClass || it.byBucket)) {
        const r = rs[0];
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
  }
  const tableEl = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl ws-table ws-notes' },
    h('thead', null, h('tr', null, ['注記項目', '時点', '各社の注記額の合計（収集値）', 'うちグループ内リース', '連結注記での調整', '連結の注記額', 'どのような情報か（根拠）'].map((t) => h('th', null, t)))),
    h('tbody', null, tbody)));

  // 記入済みの収集表の読込：誤りがあれば何も読み込まない
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, on: { change: async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast('ファイルが大きすぎます（上限5MB）', 'error');
    const buf = await f.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('shift_jis').decode(buf); }
    const r = importNoteCollection(text, companies, period);
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
  return card('注記（新リース会計基準）',
    h('div', { class: 'alert alert-info' }, '開示目的は、リースが財政状態・経営成績・キャッシュ・フローに与える影響を財務諸表利用者が評価するための情報を提供することです（会計基準第54項）。会計方針に関する情報（適用指針第97項）は文章で記載するため、この表の対象外です。重要性に乏しい事項は記載を省略できます（会計基準第55項ただし書き）。'),
    h('div', { class: 'alert alert-info' }, '連結の注記額＝各社の個別の注記額の合計−うちグループ内リース分。①「収集表を書き出す」で各社に配る表（項目ごとに、どのような情報か・根拠の項を記載）を作り、②各社が「各社の注記額」（グループ会社とのリースも含めた個別の注記額）と、アプリで計算しない項目の「うちグループ会社とのリース分」を記入し、③「記入済みの収集表を読み込む」で取り込みます。「アプリで計算」の項目のグループ内リース分は契約から自動で計算します。金額を押すと会社・契約ごとの内訳を表示します。'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => download(`注記の収集表_${period.label}.csv`, noteCollectionCsv(companies, period, g, inputs), 'text/csv;charset=utf-8') } }, '① 収集表を書き出す（CSV）'),
      h('button', { class: 'btn', type: 'button', on: { click: () => fileInput.click() } }, '③ 記入済みの収集表を読み込む'), fileInput,
      h('button', { class: 'btn', type: 'button', on: { click: exportTable } }, '注記の表を書き出す（CSV）'),
      collected ? h('button', { class: 'btn btn-danger', type: 'button', on: { click: async () => { if (await ask({ title: `${period.label}の収集値を消去しますか？`, message: `${collected}社分の収集値を消去します。グループ内リース分（アプリの計算値）は消えません。`, okLabel: '消去する', danger: true })) update((d) => { delete d.noteInputs[pk]; }, '注記の収集値の消去', period.label); } } }, 'この期間の収集値を消去') : null,
      h('span', { class: 'muted' }, collected ? `収集済み：${collected}社／${companies.length}社` : '収集値はまだありません（各社の注記額の列は「未収集」）')),
    tableEl,
    barChart({ wide: true, title: '決算日後の期間別：グループ内の借手のリース料と貸手の受取リース料', subtitle: '同じ契約の支払と受取のため、借手の短期・少額リース等や貸手のリース期間の違いを除けばほぼ一致します', labels: BUCKETS.map((b) => b.label), series: [{ name: '借手：リース負債の返済予定額（割引前）', values: mat('X-LL'), color: COLORS.lessee }, { name: '借手：元本', values: mat('X-LLP'), color: 'var(--s5)' }, { name: '貸手：リース料の回収予定額', values: mat('R-MAT'), color: COLORS.lessor }], unit, height: 240 }));
}
