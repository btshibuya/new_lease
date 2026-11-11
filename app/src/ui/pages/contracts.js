import { h, card, table, field, select, statusBadge, toast, amt, ask, download } from '../dom.js';
import { toCsv } from '../../engine/data.js';
import { COLORS, emptyState, kpi } from '../components.js';
import { gantt, barChart, lineChart } from '../charts.js';
import { state, update, setUi } from '../store.js';
import { guard } from '../app.js';
import { validateContract, currentPortion, periodSummary, paymentPlan } from '../../engine/schedule.js';
import { sanitizeContract } from '../../engine/data.js';
import { contractTemplateCsv, contractsToCsv, importContractsCsv } from '../../engine/contractCsv.js';
import { contractYearly, eFromSchedule, contractMonthly, rollupMonthly } from '../../engine/reports.js';
import { ASSET_CLASSES, LESSEE_DEPT } from '../../engine/accounts.js';
import { fmt, ymToIndex, indexToJp, indexToYm, deepClone } from '../../engine/util.js';

const MODEL_SHORT = { jgaap: '日本基準', asc842ol: 'ASC842オペ', offbalance: '短期・少額' };
const MODEL = { jgaap: '日本基準（IFRS第16号も同じ）', asc842ol: 'ASC第842号 オペレーティング・リース（単一費用）', offbalance: '短期・少額リース等（借手オフバランス）' };

function blankContract(data) {
  const lessor = data.companies.find((c) => c.isParent)?.code || data.companies[0]?.code || '';
  const lessee = data.companies.find((c) => c.code !== lessor)?.code || '';
  let n = data.contracts.length + 1;
  while (data.contracts.some((c) => c.id === `K-${String(n).padStart(3, '0')}`)) n++;
  return sanitizeContract({ id: `K-${String(n).padStart(3, '0')}`, name: '新規契約', lessorCo: lessor, lesseeCo: lessee, assetClass: 'building', commencement: '2027-04', termMonths: 60, frequencyMonths: 12, timing: 'arrears', payment: 1000, lessee: { model: 'jgaap', offKind: 'short', rate: 0.03, dept: 'sga' }, lessor: { assetId: '', assetCost: 0, ratio: 1 } });
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
    return { label: `${c.id} ${c.name}`, start, end: term ?? end, termination: term, startLabel: indexToJp(start), endLabel: indexToJp(term ?? end), note: `${co(c.lessorCo)} → ${co(c.lesseeCo)}${term !== null ? '（中途解約）' : ''}`, onClick: () => guard(() => setUi({ contractId: c.id })), color: sc ? 'var(--s1)' : 'var(--crit)' };
  });
  const minI = Math.min(...rows.map((r) => r.start), period.start);
  const maxI = Math.max(...rows.map((r) => r.end), period.end);
  const tl = rows.length ? gantt({ title: '契約タイムライン', subtitle: '帯：リース期間、✕：中途解約、網掛け：選択中の期間。行をクリックすると詳細を表示', rows, wide: true, min: minI, max: maxI, highlight: { start: period.start, end: period.end } }) : emptyState('契約がありません');

  const cols = [
    { label: '契約番号', nowrap: true, render: (c) => h('td', { class: 'nw' }, h('a', { href: '#contracts', on: { click: (e) => { e.preventDefault(); guard(() => setUi({ contractId: c.id })); } } }, c.id)) },
    { label: '契約名', key: 'name' },
    { label: '貸手', render: (c) => co(c.lessorCo) },
    { label: '借手', render: (c) => co(c.lesseeCo) },
    { label: '借手の会計モデル', render: (c) => MODEL_SHORT[c.lessee.model] },
    { label: '開始', key: 'commencement', nowrap: true },
    { label: '期間', nowrap: true, render: (c) => `${c.termMonths}か月` },
    { label: '1回リース料', num: true, render: (c) => c.payment },
    { label: '当初リース負債', num: true, render: (c) => schedCache.get(c.id)?.meta.L0 ?? null },
    { label: '入力検証', render: (c) => { const e = validateContract(c, data.companies); return h('td', null, e.length ? statusBadge('ng', `${e.length}件`) : statusBadge('ok')); } },
  ];
  // 契約が多くても画面からあふれないよう、一覧は枠の中でスクロールし、絞り込みもできる
  const listBox = h('div', { class: 'scroll-y list-box' });
  const count = h('span', { class: 'muted' });
  const drawList = (q = '') => {
    const t = q.trim().toLowerCase();
    const shown = t ? data.contracts.filter((c) => [c.id, c.name, c.lessorCo, c.lesseeCo, co(c.lessorCo), co(c.lesseeCo)].some((x) => String(x).toLowerCase().includes(t))) : data.contracts;
    listBox.replaceChildren(shown.length ? table(cols, shown, { rowClass: (c) => (sel && c.id === sel.id ? 'selected' : '') }) : emptyState(t ? '該当する契約がありません' : '契約がありません。「＋ 契約を追加」または「CSVで一括取込」で登録してください。'));
    count.textContent = t ? `${shown.length}件／全${data.contracts.length}件` : `全${data.contracts.length}件`;
  };
  drawList();
  const filter = h('input', { type: 'search', placeholder: '契約番号・契約名・会社で絞り込み', 'aria-label': '契約の絞り込み', class: 'list-filter', on: { input: (e) => drawList(e.target.value) } });

  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, on: { change: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) guard(() => importCsv(f, data)); } } });
  const actions = h('div', { class: 'actions' },
    h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => guard(() => { const nc = blankContract(data); update((d) => d.contracts.push(nc), '契約追加', nc.id); setUi({ contractId: nc.id }); }) } }, '＋ 契約を追加'),
    h('button', { class: 'btn', type: 'button', on: { click: () => fileInput.click() } }, 'CSVで一括取込'), fileInput,
    h('button', { class: 'btn', type: 'button', on: { click: () => download('契約取込テンプレート.csv', contractTemplateCsv([{ ...data.contracts.find((c) => c.id === 'K-001') || blankContract(data), id: 'K-101', name: '（記入例）この行は削除して入力してください' }]), 'text/csv;charset=utf-8') } }, '取込用テンプレート'),
    data.contracts.length ? h('button', { class: 'btn', type: 'button', on: { click: () => download('契約一覧.csv', contractsToCsv(data.contracts), 'text/csv;charset=utf-8') } }, '登録済みの契約を書き出す') : null,
    h('span', { class: 'spacer' }), filter, count);

  return h('div', { class: 'page' },
    card('契約一覧', h('div', { class: 'alert alert-info' }, '契約は1件ずつ追加するほか、CSVでまとめて取り込めます。「取込用テンプレート」の列（貸手・借手は別々の列）に入力して取り込んでください。既存と同じ契約番号の行は上書きします（条件変更・実績の入力は引き継ぎます）。'), actions, listBox),
    sel ? editor(sel, data) : card(null, emptyState('一覧から契約を選ぶと、ここに編集画面を表示します。')),
    sel ? renderDetail(sel, ctx) : null,
    card(null, tl));
}

/** CSV の一括取込：誤りがあれば行番号つきで表示して取り込まない。なければ件数を確認して取り込む */
async function importCsv(file, data) {
  if (file.size > 5 * 1024 * 1024) return toast('ファイルが大きすぎます（上限5MB）', 'error');
  let text;
  const buf = await file.arrayBuffer();
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('shift_jis').decode(buf); } // 表計算ソフトで保存した Shift_JIS にも対応
  const r = importContractsCsv(text, data);
  if (r.errors.length) {
    const list = h('ul', { class: 'err-list' }, r.errors.slice(0, 30).map((x) => h('li', null, `${x.row ? `${x.row}行目` : ''}${x.id ? `（${x.id}）` : ''}：${x.messages.join('／')}`)));
    await ask({ title: `取り込めませんでした（誤り ${r.errors.length}件）`, message: 'ファイルを直してから、もう一度取り込んでください。誤りのない行も含め、何も取り込んでいません。', body: h('div', null, list, r.errors.length > 30 ? h('p', { class: 'muted' }, `ほか ${r.errors.length - 30}件`) : null), okLabel: '閉じる' });
    return;
  }
  if (!r.contracts.length) return toast('取り込む契約がありません', 'error');
  const ok = await ask({ title: `${r.contracts.length}件の契約を取り込みますか？`, message: `新規 ${r.added.length}件${r.added.length ? `（${r.added.slice(0, 10).join('、')}${r.added.length > 10 ? '…' : ''}）` : ''}\n上書き ${r.replaced.length}件${r.replaced.length ? `（${r.replaced.slice(0, 10).join('、')}${r.replaced.length > 10 ? '…' : ''}）` : ''}`, okLabel: '取り込む', danger: r.replaced.length > 0 });
  if (!ok) return;
  update((d) => {
    for (const c of r.contracts) {
      const i = d.contracts.findIndex((x) => x.id === c.id);
      if (i >= 0) d.contracts[i] = c; else d.contracts.push(c);
    }
  }, '契約の一括取込', `${file.name.slice(0, 80)}：新規${r.added.length}件・上書き${r.replaced.length}件`);
  setUi({ contractId: r.contracts[0].id });
  toast(`${r.contracts.length}件を取り込みました`);
}

/** 年度別サマリーの各数値の計算過程 */
function yearCalc(key, r, c, sc) {
  const ms = sc.months.filter((x) => x.m >= r.start && x.m <= r.end);
  const pct2 = (v) => `${(v * 100).toFixed(3)}%`;
  const monthly = (fn, lab) => {
    const rows = ms.map((x) => ({ ym: indexToJp(x.m), v: fn(x) || 0 })).filter((x) => x.v);
    return { title: `月ごとの${lab}（${rows.length}か月）`, cols: [{ label: '年月', key: 'ym' }, { label: lab, key: 'v', num: true }], rows: [...rows, { ym: '合計', v: rows.reduce((a, x) => a + x.v, 0), total: true }] };
  };
  const last = ms[ms.length - 1];
  const base = { context: `${c.id} ${c.name}・${r.label}`, sources: [{ label: `契約 ${c.id}` }, { label: '返済・償却スケジュール' }] };
  const F = (label, value) => ({ label, value });
  const ex = (parts, total) => `${parts.map((p) => (typeof p === 'string' ? p : fmt(p))).join(' ')} ＝ ${fmt(total)}`;
  switch (key) {
    case 'openL': return { ...base, title: '期首のリース負債', value: r.openL, notes: ['前期末のリース負債の残高（月次スケジュールの前期末の値）を引き継ぎます。'] };
    case 'newL': return { ...base, title: '新規：リース開始時のリース負債', value: r.newL, formula: [F('残りのリース料の現在価値', r.newL)], notes: [`割引率 年${pct2(sc.meta.rate)}（支払間隔あたり ${(sc.meta.rp * 100).toFixed(4)}%）で、支払日ごとに割り引いた合計です。`, sc.meta.measSource !== 'none' ? '適用初年度の経過措置により、適用開始時点の残りのリース料で測定しています。' : ''].filter(Boolean) };
    case 'remL': return { ...base, title: '再測定（条件変更）', value: r.remL, breakdown: { title: '条件変更の内容', cols: [{ label: '年月', key: 'ym' }, { label: '変更前の負債', key: 'o', num: true }, { label: '変更後の負債', key: 'n', num: true }, { label: '増減', key: 'd', num: true }], rows: ms.filter((x) => x.lessee.remeasure).map((x) => ({ ym: indexToJp(x.m), o: x.lessee.remeasure.Lold, n: x.lessee.remeasure.Lnew, d: x.lessee.remeasure.Lnew - x.lessee.remeasure.Lold })) }, notes: ['変更後のリース料を変更日の割引率で割り引いた現在価値に置き換えます。期間の短縮（範囲の縮小）は、一部を取り崩して損益にします。'] };
    case 'pay': return { ...base, title: '支払（リース料）', value: r.pay, breakdown: monthly((x) => x.lessee.pay || x.lessor.cash, '支払') };
    case 'int': return { ...base, title: '利息', value: r.int, breakdown: monthly((x) => (x.lessee.int || 0) + (x.lessee.accr || 0), '利息'), notes: [`利息＝直前の支払後の残高 × 利率（支払間隔あたり ${(sc.meta.rp * 100).toFixed(4)}%）。支払と支払の間は${sc.meta.nominal ? '定額' : '複利'}で月に按分します（会計方針 POL-10）。`] };
    case 'principal': return { ...base, title: '元本の返済', value: r.principal, formula: [F('支払', r.pay), '−', F('利息', r.int)], expr: ex([r.pay, '−', r.int], r.principal) };
    case 'closeL': return { ...base, title: '期末のリース負債', value: r.closeL, formula: [F('期首負債', r.openL), '＋', F('新規', r.newL), '＋', F('再測定', r.remL), '＋', F('利息', r.int), '−', F('支払', r.pay)], expr: ex([r.openL, '＋', r.newL, '＋', r.remL, '＋', r.int, '−', r.pay], r.closeL), notes: r.openL + r.newL + r.remL + r.int - r.pay !== r.closeL ? ['差は中途解約・満了による取崩しです。'] : [] };
    case 'cur': return { ...base, title: 'リース負債のうち流動（決算日後1年以内）', value: r.cur, formula: [F('期末負債', r.closeL), '−', F('1年以内の最後の支払直後の残高', r.closeL - r.cur)], expr: ex([r.closeL, '−', r.closeL - r.cur], r.cur), notes: ['決算日時点の契約条件で、1年以内に支払うリース料に含まれる元本です。'] };
    case 'rouNet': return { ...base, title: '使用権資産の簿価', value: r.rouNet, formula: last ? [F('取得原価', last.lessee.cost_end || 0), '−', F('減価償却累計額', last.lessee.acc_end || 0)] : [], expr: last ? ex([last.lessee.cost_end || 0, '−', last.lessee.acc_end || 0], r.rouNet) : '' };
    case 'dep': return { ...base, title: '使用権資産の減価償却費', value: r.dep, breakdown: monthly((x) => x.lessee.dep, '償却費'), notes: [`取得原価 ${fmt(sc.meta.C0)} を ${sc.meta.depMonths}か月で定額償却（累計で端数処理）。条件変更後は、変更時の簿価を残りの期間で償却します。`] };
    case 'lesseeExp': return { ...base, title: '借手の費用', value: r.lesseeExp, formula: [F('償却費', r.dep), '＋', F('利息', r.int), '＋', F('その他（単一費用・旧基準の支払）', r.lesseeExp - r.dep - r.int)], expr: ex([r.dep, '＋', r.int, '＋', r.lesseeExp - r.dep - r.int], r.lesseeExp) };
    case 'inc': return { ...base, title: '貸手の受取リース料（定額法）', value: r.inc, breakdown: monthly((x) => x.lessor.inc, '受取リース料'), notes: ['収益を認識する区間（開始・条件変更・貸手のリース期間の終了で区切る）ごとに、区間のリース料総額を月数で均等に配分します。'] };
    case 'diff': return { ...base, title: '当期差（借手費用−貸手収益）', value: r.diff, formula: [F('借手の費用', r.lesseeExp), '−', F('貸手の収益', r.inc)], expr: ex([r.lesseeExp, '−', r.inc], r.diff) };
    case 'cumE': return { ...base, title: '消去差額（累計）＝連結上の利益剰余金への影響（税引前）', value: r.cumE, formula: [F('リース負債', r.closeL), '＋', F('未払リース料', r.X), '−', F('使用権資産簿価', r.rouNet), '−', F('貸手の未収', r.R)], expr: ex([r.closeL, '＋', r.X, '−', r.rouNet, '−', r.R], r.closeL + r.X - r.rouNet - r.R), notes: ['借手の費用と貸手の収益の差の累計と一致します（検算 CHK-03）。初期直接費用を資産計上する方針では、その未償却残高を除きます。'] };
    default: return { ...base, title: key, value: r[key] };
  }
}

function renderDetail(c, ctx) {
  const { data, schedCache, yearPeriods, unit } = ctx;
  const sc = schedCache.get(c.id);
  const errs = validateContract(c, data.companies);
  const parts = [h('h2', { class: 'section-title' }, `スケジュールとグラフ：${c.id} ${c.name}`)];
  if (errs.length) parts.push(h('div', { class: 'alert alert-err' }, h('strong', null, '入力エラー：'), h('ul', null, errs.map((e) => h('li', null, e)))));
  if (sc) {
    const yr = contractYearly(sc, yearPeriods, currentPortion);
    // 消去による純資産修正額（会計方針を反映。仕訳の純資産修正額と同額であることは検算 CHK-03 で確認）
    const eAt = (idx) => Object.values(eFromSchedule(sc, idx, ctx.pol)).reduce((a, v) => a + v, 0);
    yr.forEach((r) => { r.cumE = eAt(r.end); r.plEffect = r.cumE - eAt(r.start - 1); });
    const labels = yr.map((r) => r.label.replace('年', '/').replace('月期', ''));
    parts.push(h('div', { class: 'kpi' },
      kpi('リース負債の当初測定額', fmt(sc.meta.L0), `割引率 ${(sc.meta.rate * 100).toFixed(3)}%（期間換算 ${(sc.meta.rp * 100).toFixed(4)}%）`, { accent: 'lessee' }),
      kpi('使用権資産の取得原価', fmt(sc.meta.C0), `うち初期直接費用 ${fmt(sc.meta.idc)}、償却 ${sc.meta.depMonths}か月`, { accent: 'lessee' }),
      kpi('リース料総額 ／ 利息総額', `${fmt(sc.meta.totalPayments)} ／ ${fmt(sc.meta.totalInterest)}`, `支払 ${sc.meta.K}回、最終回の端数調整 ${fmt(sc.meta.finalResidual || 0)}`)));
    parts.push(reportCard(c, sc, ctx));
    // 年度別サマリーの数値を押すと「計算の確認」：式・値を入れた式・月ごとの内訳・出典
    const yc = (key) => (r) => yearCalc(key, r, c, sc);
    parts.push(withId('contract-yearly', card('年度別サマリー（要件定義書 第10章の表と同じ構成。数値を押すと計算の確認）', table([
      { label: '年度', key: 'label' },
      { label: '期首負債', key: 'openL', num: true, calc: yc('openL') },
      { label: '新規', key: 'newL', num: true, calc: yc('newL') },
      { label: '再測定', key: 'remL', num: true, title: '条件変更による再測定（範囲縮小の取崩を含む）', calc: yc('remL') },
      { label: '支払', key: 'pay', num: true, calc: yc('pay') },
      { label: '利息', key: 'int', num: true, calc: yc('int') },
      { label: '元本', key: 'principal', num: true, calc: yc('principal') },
      { label: '期末負債', key: 'closeL', num: true, calc: yc('closeL') },
      { label: 'うち流動', key: 'cur', num: true, calc: yc('cur') },
      { label: '使用権資産簿価', key: 'rouNet', num: true, calc: yc('rouNet') },
      { label: '償却費', key: 'dep', num: true, calc: yc('dep') },
      { label: '借手費用', key: 'lesseeExp', num: true, calc: yc('lesseeExp') },
      { label: '貸手収益', key: 'inc', num: true, calc: yc('inc') },
      { label: '当期差', key: 'diff', num: true, calc: yc('diff') },
      { label: '消去差額（累計）', key: 'cumE', num: true, title: 'リース負債＋未払−使用権資産簿価−貸手の未収', calc: yc('cumE') },
    ], yr))));
    parts.push(paymentCard(c));
    parts.push(actualsCard(c, sc, ctx.periods));
  }
  return h('div', { class: 'detail', id: 'contract-detail' }, ...parts);
}

function actualsCard(c, sc, periods) {
  const draft = deepClone(c.actuals || {});
  const rowsData = periods.filter((p) => sc.months.some((x) => x.m >= p.start && x.m <= p.end && x.lessee.active)).map((p) => {
    const ps = periodSummary(sc, p.start, p.end);
    const fyEndRow = p.end === p.fyEnd;
    return { p, key: indexToYm(p.end), L: ps.close.L, rouNet: ps.close.cost - ps.close.acc, cur: currentPortion(sc, p.end), R: ps.close.R, inc: fyEndRow ? periodSummary(sc, p.end - 11, p.end).inc : null };
  });
  const fields = [['L', 'リース負債'], ['cur', 'うち流動'], ['rouNet', '使用権資産簿価'], ['R', '貸手の未収'], ['inc', '受取リース料（年度）']];
  const rows = rowsData.map((r) => {
    const a = draft[r.key] || {};
    const inp = (f) => h('input', { type: 'number', step: 'any', value: a[f] ?? '', 'aria-label': `${r.p.label} ${f}`, on: { input: (e) => { draft[r.key] = draft[r.key] || {}; if (e.target.value === '') delete draft[r.key][f]; else draft[r.key][f] = Number(e.target.value); } } });
    const judge = (f) => (a[f] === undefined || a[f] === null ? h('span', { class: 'muted' }, '—') : Number(a[f]) === r[f] ? statusBadge('ok', '一致') : statusBadge('ng', `差異 ${fmt(Number(a[f]) - r[f])}`));
    return h('tr', null, h('td', null, r.p.label), ...fields.map(([f]) => (r[f] === null ? h('td', { class: 'muted' }, '（年度末のみ）') : h('td', null, inp(f), h('div', { class: 'small muted' }, `計算値 ${fmt(r[f])}`), judge(f)))));
  });
  return card('個別の帳簿残高（実績）との突合',
    h('div', { class: 'alert alert-info' }, '借手・貸手の個別帳簿の金額を入力すると、アプリの計算値と比較します（検算 CHK-10）。表示中の期間区分（年度／四半期）の期末ごとに入力できます。受取リース料は年度の金額で、年度末の行にだけ入力します。差異があれば原因（割引率・支払条件・端数処理・計上漏れ等）を調査し、必要に応じて個社修正を行います。'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl compact' },
      h('thead', null, h('tr', null, h('th', null, '期間'), ...fields.map(([, l]) => h('th', null, `${l}（帳簿）`)))),
      h('tbody', null, rows))),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => update((d) => { const t = d.contracts.find((x) => x.id === c.id); t.actuals = sanitizeContract({ ...t, actuals: draft }).actuals; }, '実績入力', c.id) } }, '実績を保存')));
}

/** 条件変更（再測定）の入力欄 */
function modsFieldset(f) {
  f.modifications = f.modifications || [];
  const body = h('tbody');
  const draw = () => body.replaceChildren(...f.modifications.map((m, i) => h('tr', null,
    h('td', null, h('input', { type: 'month', value: m.ym || '', 'aria-label': '変更年月', on: { input: (e) => { m.ym = e.target.value; } } })),
    h('td', null, h('input', { type: 'number', step: 'any', min: 0, value: m.payment ?? '', placeholder: '変更なし', 'aria-label': '変更後のリース料', on: { input: (e) => { m.payment = e.target.value === '' ? null : Number(e.target.value); } } })),
    h('td', null, h('input', { type: 'number', step: 1, min: 1, value: m.termMonths ?? '', placeholder: '変更なし', 'aria-label': '変更後のリース期間', on: { input: (e) => { m.termMonths = e.target.value === '' ? null : Number(e.target.value); } } })),
    h('td', null, h('input', { type: 'number', step: 'any', value: m.rate === null || m.rate === undefined ? '' : +(m.rate * 100).toFixed(6), placeholder: '変更なし', 'aria-label': '変更後の割引率', on: { input: (e) => { m.rate = e.target.value === '' ? null : Number(e.target.value) / 100; } } })),
    h('td', null, h('input', { type: 'text', maxlength: 200, value: m.note || '', 'aria-label': '内容', on: { input: (e) => { m.note = e.target.value; } } })),
    h('td', null, h('button', { class: 'btn-link danger', type: 'button', on: { click: () => { f.modifications.splice(i, 1); draw(); } } }, '削除')))));
  draw();
  return h('fieldset', { id: 'modifications' }, h('legend', null, '条件変更・再測定（変更月の月初から適用）'),
    h('div', { class: 'alert alert-info' }, '借手はリース負債を変更後の残存リース料の現在価値で再測定し、使用権資産を同額調整します（期間短縮で範囲が縮小する場合は一部を取り崩して損益）。指数・レートによる変動は割引率を「変更なし」、期間の見直し等は見直し後の割引率を入力します。貸手は変更日から新たなリースとして、未収（前受）を含めて残存期間で定額認識します。'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl compact' }, h('thead', null, h('tr', null, ['変更年月', '変更後の1回あたりリース料', '変更後のリース期間（開始からの総月数）', '変更後の割引率（年％）', '内容', ''].map((t) => h('th', null, t)))), body)),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => { f.modifications.push({ ym: '', payment: null, termMonths: null, rate: null, note: '' }); draw(); } } }, '＋ 条件変更を追加')));
}

function editor(c, data) {
  const f = deepClone(c);
  const num = (obj, key, opts = {}) => h('input', { type: 'number', step: opts.step || 'any', value: obj[key] ?? '', min: opts.min, on: { input: (e) => { obj[key] = e.target.value === '' ? (opts.nullable ? null : 0) : Number(e.target.value) * (opts.scale || 1); } } });
  const pct = (obj, key) => h('input', { type: 'number', step: 'any', value: obj[key] === null || obj[key] === undefined ? '' : +(obj[key] * 100).toFixed(6), on: { input: (e) => { obj[key] = e.target.value === '' ? 0 : Number(e.target.value) / 100; } } });
  const txt = (obj, key, max = 100) => h('input', { type: 'text', maxlength: max, value: obj[key] ?? '', on: { input: (e) => { obj[key] = e.target.value; } } });
  const month = (obj, key) => h('input', { type: 'month', value: obj[key] ?? '', on: { input: (e) => { obj[key] = e.target.value || null; } } });
  const sel = (obj, key, opts) => select(opts, obj[key], (v) => { obj[key] = isNaN(Number(v)) || v === '' ? v : (typeof obj[key] === 'number' ? Number(v) : v); });
  const coOpts = data.companies.map((x) => [x.code, `${x.code} ${x.name}`]);
  let stepsError = '';
  const stepsInput = h('input', { type: 'text', value: (f.steps || []).map((s) => `${s.fromPayment}:${s.amount}`).join(', '), placeholder: '例）25:55, 37:60', on: { input: (e) => {
    // 全角数字・全角コロン・読点を半角に変換し、「回:金額」の形式だけを受け付ける
    const t = e.target.value.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/[：]/g, ':').replace(/[、，]/g, ',');
    const parts = t.split(',').map((x) => x.trim()).filter(Boolean);
    const bad = parts.filter((x) => !/^\d+\s*:\s*\d+(\.\d+)?$/.test(x));
    stepsError = bad.length ? `段階賃料の形式が不正です：${bad.join('、')}（「回:金額」で入力）` : '';
    f.steps = bad.length ? f.steps : parts.map((x) => { const [a, b] = x.split(':'); return { fromPayment: Number(a), amount: Number(b) }; });
  } } });
  if (!f.lessee.transition) f.lessee.transition = { method: 'none' };

  const grid = (...items) => h('div', { class: 'form-grid' }, ...items);
  // 入力欄の横に出典のバッジ（契約書・借手の帳簿・貸手の帳簿）
  const fC = (l, i, hp) => field(l, i, hp, '契約書');
  const fL = (l, i, hp) => field(l, i, hp, '借手の帳簿');
  const fR = (l, i, hp) => field(l, i, hp, '貸手の帳簿');
  const dirtyMark = h('span', { class: state.dirty ? 'dirty' : 'muted' }, state.dirty ? '保存していない変更があります' : '保存済み');
  const markDirty = () => { state.dirty = `契約 ${c.id} の編集`; dirtyMark.className = 'dirty'; dirtyMark.textContent = '保存していない変更があります'; };
  const form = h('form', { class: 'form', on: { input: markDirty, change: markDirty, submit: (e) => {
    e.preventDefault();
    f.frequencyMonths = Number(f.frequencyMonths);
    const clean = sanitizeContract(f);
    // 補正前（入力どおり）と補正後の両方を検証する（空欄の按分比率が下限値に補正されて見逃される等を防ぐ）
    const errs = [...new Set([...validateContract(f, data.companies), ...validateContract(clean, data.companies)])];
    if (stepsError) errs.unshift(stepsError);
    if (data.contracts.some((x) => x.id === clean.id && x.id !== c.id)) errs.push('契約番号が重複しています');
    if (errs.length) { toast(`保存できません：${errs[0]}${errs.length > 1 ? ` ほか${errs.length - 1}件` : ''}`, 'error'); return; }
    state.dirty = null;
    update((d) => { const i = d.contracts.findIndex((x) => x.id === c.id); d.contracts[i] = clean; }, '契約更新', `${c.id}${clean.id !== c.id ? `→${clean.id}` : ''}`);
    setUi({ contractId: clean.id });
    toast('保存しました');
  } } },
    h('fieldset', null, h('legend', null, '契約の基本情報'), grid(
      fC('契約番号', txt(f, 'id', 30)), fC('契約名', txt(f, 'name')),
      fC('貸手会社', sel(f, 'lessorCo', coOpts)), fC('借手会社', sel(f, 'lesseeCo', coOpts)),
      fC('資産区分', sel(f, 'assetClass', Object.entries(ASSET_CLASSES))),
      fC('リース開始年月', month(f, 'commencement')),
      fC('リース期間（月数）', num(f, 'termMonths', { step: 1, min: 1 }), '延長・解約オプションの判断を反映した期間'),
      fC('支払間隔', sel(f, 'frequencyMonths', [[1, '毎月'], [3, '四半期'], [6, '半年'], [12, '毎年']])),
      fC('支払時期', sel(f, 'timing', [['arrears', '後払（各期間の末日）'], ['advance', '前払（各期間の初日）']])),
      fC('1回あたりリース料', num(f, 'payment', { min: 0 }), '消費税・非リース構成部分を除く'),
      fC('フリーレント（無償の支払回数）', num(f, 'freePayments', { step: 1, min: 0 })),
      fC('段階賃料（支払回:金額）', stepsInput, '例）25回目から55 → 25:55'),
      fC('中途解約年月（任意）', month(f, 'terminationYm'), '解約月の末日に借手が取崩し、貸手は未収を取崩し'),
      fC('解約違約金（借手→貸手）', num(f, 'terminationPenalty', { min: 0 }), '解約時の精算金。連結上は相殺消去'))),
    h('fieldset', null, h('legend', null, '借手の情報（個別でオンバランス済みの内容）'), grid(
      fL('借手の会計モデル', sel(f.lessee, 'model', Object.entries(MODEL))),
      fL('簡便的な取扱いの種類（短期・少額リース等の場合）', sel(f.lessee, 'offKind', [['short', '短期リース（12か月以内）'], ['low', '少額リース']]), '注記「短期リースに係る費用」（適用指針第99項〜第101項）の集計に使います。少額リースの費用は含めません'),
      fL('割引率（年％）', pct(f.lessee, 'rate')),
      fL('初期直接費用', num(f.lessee, 'idc', { min: 0 }), 'グループ外への支出（使用権資産に含めた額）'),
      fL('使用部門', sel(f.lessee, 'dept', Object.entries(LESSEE_DEPT)), '貸手の減価償却費の組替先（POL-05）'),
      fL('償却月数（空欄＝リース期間）', num(f.lessee, 'depMonths', { step: 1, nullable: true })),
      fL('当初リース負債の取込値（空欄＝再計算）', num(f.lessee, 'liabilityOverride', { nullable: true }), '借手の帳簿値。再計算値との差は検算で表示'),
      fL('適用開始前に開始した契約の使用権資産の測定', sel(f.lessee, 'rouTransition', [['eq_liability', 'リース負債と同額'], ['retrospective', 'リース開始時から適用していたとみなして測定']]), '借手会社の適用初年度の方法が「累積的影響方式」の場合に使用'),
      fL('適用開始時の割引率（年％、空欄＝上の割引率）', h('input', { type: 'number', step: 'any', value: f.lessee.transitionRate === null || f.lessee.transitionRate === undefined ? '' : +(f.lessee.transitionRate * 100).toFixed(6), on: { input: (e) => { f.lessee.transitionRate = e.target.value === '' ? null : Number(e.target.value) / 100; } } })),
      c.lessee.transition?.method === 'cumulative' ? fL('（旧形式）契約単位の適用初年度', sel(f.lessee.transition, 'method', [['cumulative', '契約単位の設定を使う（会社マスタより優先）'], ['none', '使わない（会社マスタの設定に従う）']]), '旧版で入力した契約単位の設定。解除すると会社マスタの適用初年度の方法に従います') : null,
      c.lessee.transition?.method === 'cumulative' ? fL('（旧形式）契約単位の適用開始年月', month(f.lessee.transition, 'ym')) : null,
      fL('法人税法上のリース取引（売買扱い）', h('input', { type: 'checkbox', checked: !!f.lessee.taxLease, on: { change: (e) => { f.lessee.taxLease = e.target.checked; } } }), '該当する場合、税効果は個別検討（検算で注意喚起）'))),
    modsFieldset(f),
    h('fieldset', null, h('legend', null, '貸手の情報（オペレーティング・リース）'), grid(
      fR('資産ID', txt(f.lessor, 'assetId', 30), '同じ資産を複数契約で使う場合は同じIDにし、按分比率を設定'),
      fR('対象資産の取得原価', num(f.lessor, 'assetCost', { min: 0 })),
      fR('耐用年数（月数）', num(f.lessor, 'assetLifeMonths', { step: 1, min: 0 })),
      fR('取得年月', month(f.lessor, 'assetStart')),
      fR('按分比率（％）', pct(f.lessor, 'ratio')),
      fR('受取リース料の計上区分', sel(f.lessor, 'incClass', [['sales', '売上高'], ['nonop', '営業外収益']])),
      fR('減価償却費の計上区分', sel(f.lessor, 'depClass', [['cogs', '売上原価（賃貸原価）'], ['nonop', '営業外費用']])),
      fR('貸手のリース期間（月数、空欄＝借手と同じ）', num(f.lessor, 'termMonths', { step: 1, nullable: true }), '貸手が延長オプションを考慮しない場合など。期間後は残りのリース料を残存期間で定額認識'))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', on: { click: () => guard(() => {
        let n = 1;
        while (data.contracts.some((x) => x.id === `${c.id}-${n}`)) n++;
        const copy = sanitizeContract({ ...deepClone(c), id: `${c.id}-${n}`, actuals: {} });
        update((d) => d.contracts.push(copy), '契約複製', `${c.id}→${copy.id}`);
        setUi({ contractId: copy.id });
      }) } }, 'この契約を複製する'),
      h('button', { class: 'btn btn-danger', type: 'button', on: { click: async () => { if (await ask({ title: `契約 ${c.id} を削除しますか？`, message: `${c.name}`, okLabel: '削除する', danger: true })) { state.dirty = null; update((d) => { d.contracts = d.contracts.filter((x) => x.id !== c.id); }, '契約削除', c.id); setUi({ contractId: null }); } } } }, 'この契約を削除する')),
    h('div', { class: 'save-bar' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, '保存して再計算'),
      h('button', { class: 'btn', type: 'button', on: { click: () => { state.dirty = null; setUi({}); toast('変更を破棄しました'); } } }, '変更を破棄'),
      h('a', { class: 'btn', href: '#journals' }, '次へ：仕訳を確かめる →'),
      dirtyMark));
  const lockNote = (data.locks || []).length ? h('div', { class: 'alert alert-warn' }, `確定済みの期間が ${(data.locks || []).length} 件あります。確定済み期間の数値が変わる変更をすると、検算 CHK-13 が NG になります。条件変更は変更日以降の期間に反映されるよう入力してください。`) : null;
  return h('section', { class: 'card', id: 'contract-editor' }, h('h2', null, `契約の編集：${c.id} ${c.name}`), lockNote, form);
}

const withId = (id, el) => { el.id = id; return el; };

/** 返済スケジュール（支払額）の手修正：支払月ごとに支払額を直す（リース負債・利息・貸手の収益に反映） */
function paymentCard(c) {
  const k = (c.modifications || []).length;
  const plan = paymentPlan({ ...c, paymentOverrides: [] }, k);
  const draft = new Map((c.paymentOverrides || []).map((x) => [x.ym, x.amount]));
  const reason = h('input', { type: 'text', maxlength: 200, value: (c.paymentOverrides || [])[0]?.reason || '', placeholder: '例）借手の支払実績に合わせた', 'aria-label': '手修正の理由' });
  const rows = plan.payments.map((p) => {
    const ym = indexToYm(p.month);
    const inp = h('input', { type: 'number', step: 'any', min: 0, value: draft.has(ym) ? draft.get(ym) : '', placeholder: '修正なし', 'aria-label': `${indexToJp(p.month)}の支払額`, on: { input: (e) => { if (e.target.value === '') draft.delete(ym); else draft.set(ym, Number(e.target.value)); } } });
    return h('tr', { class: draft.has(ym) ? 'selected' : '' }, h('td', { class: 'num' }, p.no), h('td', { class: 'nw' }, indexToJp(p.month)), amt(p.amount), h('td', null, inp));
  });
  const outside = (c.paymentOverrides || []).filter((x) => !plan.payments.some((p) => indexToYm(p.month) === x.ym));
  return h('section', { class: 'card', id: 'payment-schedule' }, h('h2', null, `返済スケジュール（支払額）の手修正：${c.id}`),
    h('div', { class: 'alert alert-info' }, '支払月ごとに支払額を直せます。直した支払額でリース負債（現在価値）・利息・償却・貸手の受取リース料（定額法）を計算し直し、仕訳・開始仕訳・注記にも反映します。段階賃料・フリーレントで表せる場合は、契約の編集画面で入力してください。手修正は検算 CHK-18 に記録されます。'),
    outside.length ? h('div', { class: 'alert alert-warn' }, `支払日ではない月の手修正があります（反映されません）：${outside.map((x) => x.ym).join('、')}`) : null,
    h('div', { class: 'tbl-wrap scroll-y' }, h('table', { class: 'tbl compact' }, h('thead', null, h('tr', null, ['回', '支払月', '契約条件の支払額', '手修正後の支払額'].map((t) => h('th', null, t)))), h('tbody', null, rows))),
    h('div', { class: 'form-grid' }, ...field('手修正の理由', reason)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => {
        const list = [...draft].filter(([ym]) => plan.payments.some((p) => indexToYm(p.month) === ym)).map(([ym, amount]) => ({ ym, amount, reason: reason.value.trim() }));
        if (list.length && !reason.value.trim()) return toast('手修正の理由を入力してください', 'error');
        update((d) => { const t = d.contracts.find((x) => x.id === c.id); t.paymentOverrides = sanitizeContract({ ...t, paymentOverrides: list }).paymentOverrides; }, '返済スケジュールの手修正', `${c.id}：${list.map((x) => `${x.ym} ${x.amount}`).join('、') || 'なし'}${reason.value.trim() ? `（${reason.value.trim().slice(0, 60)}）` : ''}`);
        toast('保存しました');
      } } }, '支払額の手修正を保存'),
      (c.paymentOverrides || []).length ? h('button', { class: 'btn btn-danger', type: 'button', on: { click: async () => { if (await ask({ title: '支払額の手修正をすべて取り消しますか？', message: '契約条件の支払額に戻します。', okLabel: '取り消す', danger: true })) update((d) => { d.contracts.find((x) => x.id === c.id).paymentOverrides = []; }, '返済スケジュールの手修正の取消', c.id); } } }, 'すべて取り消す') : null,
      h('span', { class: 'muted small' }, `手修正：${(c.paymentOverrides || []).length}件`)));
}

// 契約のレポートの表示単位（画面を移っても保つ）。仕訳の「根拠の画面へ」から月次を指定して開けるよう公開する
const rep = { unit: 'month' };
export function setReportUnit(u) { rep.unit = u === 'year' ? 'year' : 'month'; }

/**
 * 返済・償却スケジュールと財務諸表への影響：毎月（または年度）の
 * 返済（元本・利息）、減価償却費、借手の資産合計・負債合計・純資産への影響、借手の費用と貸手の収益、連結損益への影響
 * 表の数値を押すと「計算の確認」に式と（年度の行は）月ごとの内訳を表示する
 */
function reportCard(c, sc, ctx) {
  const { pol, yearPeriods, unit } = ctx;
  const mo = contractMonthly(sc, pol);
  const rows = rep.unit === 'month' ? mo.map((r) => ({ ...r, label: indexToJp(r.m) })) : rollupMonthly(mo, yearPeriods);
  const lab = (r) => (rep.unit === 'month' ? `${String(Math.floor(r.m / 12)).slice(2)}/${(r.m % 12) + 1}` : r.label.replace('年', '/').replace('月期', ''));
  const labels = rows.map(lab);
  const v = (f) => rows.map((r) => r[f]);
  const off = sc.meta.model === 'offbalance';
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '表示単位' }, [['month', '月次'], ['year', '年度']].map(([k, l]) => h('button', { type: 'button', class: rep.unit === k ? 'on' : '', on: { click: () => { rep.unit = k; window.dispatchEvent(new HashChangeEvent('hashchange')); setTimeout(() => document.getElementById('contract-monthly')?.scrollIntoView({ block: 'start' }), 120); } } }, l)));
  const tot = (f) => mo.reduce((a, r) => a + r[f], 0);
  const hasOther = mo.some((r) => r.other);
  const charts = h('div', { class: 'grid2' },
    card(null, barChart({ title: '返済スケジュール：元本と利息', subtitle: off ? '短期・少額リース等のため、借手はリース負債を計上していません（支払額は損益グラフの「その他の費用」）' : '支払額＝元本の返済＋利息。利息は期首の残高に割引率を掛けて計算（逓減）', labels, series: off ? [{ name: '支払額', values: v('pay'), color: 'var(--s1)' }] : [{ name: '元本の返済', values: v('principal'), color: 'var(--s1)' }, { name: '利息', values: v('int'), color: 'var(--s4)' }], stacked: true, unit })),
    // 帯は「資産合計−負債合計」＝表の「純資産への影響（借手）」と同じ符号
    card(null, lineChart({ title: '借手の貸借対照表：資産合計・負債合計・純資産への影響', subtitle: '資産合計＝使用権資産の簿価、負債合計＝リース負債＋未払。帯＝資産合計−負債合計（借手の純資産への影響。表の同名の列と同じ）', labels, series: [{ name: '資産合計（使用権資産簿価）', values: v('assets'), color: 'var(--s1)' }, { name: '負債合計（リース負債＋未払）', values: v('liabs'), color: 'var(--s2)', dashed: true }], band: { upper: 0, lower: 1, name: '純資産への影響（資産−負債）', color: 'var(--s3)' }, unit })),
    card(null, barChart({ title: '損益への影響：借手の費用と貸手の収益', subtitle: `借手の費用＝減価償却費＋支払利息${hasOther ? '＋その他の費用（短期・少額リース等の費用、ASC842の単一リース費用、適用開始前の支払リース料）' : ''}、貸手の収益＝受取リース料（定額）`, labels, series: [{ name: '減価償却費', values: v('dep'), color: 'var(--s1)' }, { name: '支払利息', values: v('int'), color: 'var(--s4)' }, ...(hasOther ? [{ name: 'その他の費用', values: v('other'), color: 'var(--s8)' }] : [])], stacked: true, line: { name: '貸手の受取リース料', values: v('inc'), color: 'var(--s2)' }, unit })),
    card(null, barChart({ title: '連結への影響：連結損益（税引前）と消去差額の累計', subtitle: '棒：当月（当期）の連結損益への影響（＋は消去により利益が増える）、線：消去差額の累計（連結上の利益剰余金への影響）。終了時に0', labels, series: [{ name: '連結損益への影響', values: v('plEffect'), color: 'var(--s3)' }], line: { name: '消去差額の累計', values: v('cumE'), color: 'var(--s2)' }, unit })));

  // 数値を押したときの「計算の確認」：式（値を入れた式）と、年度の行は月ごとの内訳
  const F = (label, value) => ({ label, value });
  const FORM = {
    principal: (r) => [[F('支払', r.pay), '−', F('利息', r.int)], '元本の返済＝支払−利息（利息は期首の残高×期間の割引率）'],
    lesseeExp: (r) => [[F('減価償却費', r.dep), '＋', F('利息', r.int), '＋', F('その他の費用', r.other)], '借手の費用＝減価償却費（初期直接費用の償却を含む）＋利息＋その他の費用'],
    equity: (r) => [[F('資産合計', r.assets), '−', F('負債合計', r.liabs)], '借手の純資産への影響＝資産合計（使用権資産簿価）−負債合計（リース負債＋未払）'],
    assets: (r) => [[F('取得原価', r.cost), '−', F('減価償却累計額', r.acc)], '使用権資産の簿価'],
    liabs: (r) => [[F('リース負債', r.L), '＋', F('未払', r.X)], '負債合計'],
    cumE: (r) => [[F('リース負債', r.L), '＋', F('未払', r.X), '−', F('使用権資産簿価', r.rou), '−', F('貸手の未収', r.R)], '消去差額（純資産修正額）。初期直接費用を資産計上する方針では、その未償却残高を調整'],
    plEffect: (r) => [[F('期末の消去差額', r.cumE), '−', F('期首の消去差額', r.cumE - r.plEffect)], '連結損益への影響（税引前）＝消去差額の当期の増減'],
  };
  const NAMES = { pay: '支払', principal: '元本', int: '利息', L: '期末リース負債', X: '未払', cost: '使用権資産（取得原価）', dep: '減価償却費', acc: '減価償却累計額', assets: '資産合計', liabs: '負債合計', equity: '純資産への影響（借手）', other: 'その他の費用', lesseeExp: '借手の費用', inc: '貸手の収益', R: '貸手の未収', plEffect: '連結損益への影響', cumE: '消去差額の累計' };
  const FLOW = new Set(['pay', 'principal', 'int', 'dep', 'other', 'lesseeExp', 'inc', 'plEffect']);
  const calc = (key) => (r) => {
    const fm = FORM[key] ? FORM[key](r) : null;
    const months = r.months || null;
    const ex = fm ? `${fm[0].map((x) => (typeof x === 'string' ? x : fmt(x.value))).join(' ')} ＝ ${fmt(r[key])}` : '';
    return {
      context: `${c.id} ${c.name}・${r.label}`, title: NAMES[key], value: r[key],
      formula: fm ? fm[0] : [], expr: ex,
      breakdown: months ? { title: `月ごとの内訳（${months.length}か月${FLOW.has(key) ? '・合計＝年度の値' : '・年度末の値＝最終月'}）`, cols: [{ label: '年月', key: 'ym' }, { label: NAMES[key], key: 'v', num: true }, { label: 'イベント', key: 'event' }], rows: [...months.map((m) => ({ ym: indexToJp(m.m), v: m[key], event: m.event })), ...(FLOW.has(key) ? [{ ym: '合計', v: months.reduce((a, m) => a + m[key], 0), event: '', total: true }] : [])] } : null,
      notes: [fm ? fm[1] : '', r.event ? `この${rep.unit === 'month' ? '月' : '期間'}のイベント：${r.event}` : ''].filter(Boolean),
      sources: [{ label: `契約 ${c.id}` }, { label: '返済・償却スケジュール' }],
    };
  };
  const num = (label, key) => ({ label, key, num: true, calc: (r) => calc(key)(r) });
  const cols = [
    { label: rep.unit === 'month' ? '年月' : '年度', key: 'label', nowrap: true },
    { label: 'イベント', render: (r) => h('td', { class: 'small' }, r.event || '') },
    num('支払', 'pay'), num('元本', 'principal'), num('利息', 'int'), num('期末リース負債', 'L'), num('未払', 'X'),
    num('使用権資産（取得原価）', 'cost'), num('減価償却費', 'dep'), num('減価償却累計額', 'acc'),
    num('資産合計（使用権資産簿価）', 'assets'), num('負債合計（リース負債＋未払）', 'liabs'), num('純資産への影響（借手）', 'equity'),
    ...(hasOther ? [num('その他の費用', 'other')] : []), num('借手の費用', 'lesseeExp'), num('貸手の収益', 'inc'), num('貸手の未収', 'R'),
    num('連結損益への影響', 'plEffect'), num('消去差額の累計', 'cumE'),
  ];
  const totalRow = { label: '合計', event: '', pay: tot('pay'), principal: tot('principal'), int: tot('int'), L: null, X: null, cost: null, dep: tot('dep'), acc: null, assets: null, liabs: null, equity: null, other: tot('other'), lesseeExp: tot('lesseeExp'), inc: tot('inc'), R: null, plEffect: tot('plEffect'), cumE: null, total: true, months: mo };
  const exportCsv = () => download(`返済・償却スケジュール_${c.id}_${rep.unit === 'month' ? '月次' : '年度'}.csv`, toCsv([cols.map((x) => x.label), ...[...rows, totalRow].map((r) => cols.map((x) => (x.key ? r[x.key] ?? '' : r.event || '')))]), 'text/csv;charset=utf-8');
  const pre = tot('prePay');
  return h('section', { class: 'card', id: 'contract-monthly' },
    h('h2', null, `返済・償却スケジュールと財務諸表への影響：${c.id}`),
    h('div', { class: 'actions' }, h('span', { class: 'fg-label' }, '表示単位'), seg,
      h('button', { class: 'btn', type: 'button', on: { click: exportCsv } }, '表を書き出す（CSV）'),
      h('span', { class: 'muted small' }, `支払総額 ${fmt(tot('pay'))}${pre ? `（ほかに適用開始前の支払 ${fmt(pre)}）` : ''}、利息総額 ${fmt(tot('int'))}、減価償却費の総額 ${fmt(tot('dep'))}、貸手の収益の総額 ${fmt(tot('inc'))}。表の数値を押すと式${rep.unit === 'year' ? 'と月ごとの内訳' : ''}を表示します`)),
    charts,
    h('div', { class: 'tbl-wrap scroll-y report-tbl' }, table(cols, [...rows, totalRow], { rowClass: (r) => (r.total ? 'total' : r.event ? 'event-row' : ''), className: 'compact' })));
}
