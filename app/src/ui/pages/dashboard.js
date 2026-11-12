import { h, card, statusBadge, table } from '../dom.js';
import { kpi, COLORS, SERIES } from '../components.js';
import { network, barChart, lineChart } from '../charts.js';
import { eFromSchedule } from '../../engine/reports.js';
import { fmt } from '../../engine/util.js';
import { rateAt } from '../../engine/accounts.js';

export function renderDashboard(ctx) {
  const { gen, period, companies, checks, data, pol, yearPeriods } = ctx;
  const res = gen.results;
  const sumClose = (f) => res.reduce((a, r) => a + f(r), 0);
  const L = sumClose((r) => r.ps.close.L);
  const rou = sumClose((r) => r.ps.close.cost - r.ps.close.acc);
  const plPre = sumClose((r) => Object.values(r.E.close).reduce((a, v) => a + v, 0) - Object.values(r.E.open).reduce((a, v) => a + v, 0));
  const tax = sumClose((r) => Object.values(r.DT.close).reduce((a, v) => a + v, 0) - Object.values(r.DT.open).reduce((a, v) => a + v, 0));
  // 非支配株主に帰属する当期純利益は仕訳（NCI_PL）から集計（持分変動による資本剰余金分を含めない）
  const nci = gen.journals.flatMap((j) => j.lines).filter((l) => l.acc === 'NCI_PL').reduce((a, l) => a + l.amt, 0);
  const active = res.filter((r) => r.ps.months > 0 && r.sched.meta.start <= period.end).length;
  const ngs = checks.filter((c) => c.status === 'ng').length;
  const warns = checks.filter((c) => c.status === 'warn').length;

  // 数値を押すと「計算の確認」：契約ごとの内訳
  const sumE = (o) => Object.values(o).reduce((a, v) => a + v, 0);
  const byContract = (title, value, fn, note) => () => {
    const rows = res.map((r) => ({ id: r.contract.id, name: r.contract.name, v: fn(r) })).filter((x) => x.v);
    return { context: `全体の状況・${period.label}`, title, value, breakdown: { title: `契約ごとの内訳（${rows.length}件）`, cols: [{ label: '契約', key: 'id' }, { label: '契約名', key: 'name' }, { label: '金額', key: 'v', num: true }], rows: [...rows, { id: '合計', name: '', v: rows.reduce((a, x) => a + x.v, 0), total: true }] }, notes: note ? [note] : [], sources: [{ label: '契約・スケジュール' }, { label: '仕訳', kind: 'journal' }] };
  };
  const kpis = h('div', { class: 'kpi' },
    kpi('当期に有効な契約', `${active} 件`, `登録 ${data.contracts.length} 件`),
    kpi('期末に消去するリース負債', fmt(L), '借手個別の残高（流動＋固定）', { accent: 'lessee', calc: byContract('期末に消去するリース負債', L, (r) => r.ps.close.L) }),
    kpi('期末に消去する使用権資産（簿価）', fmt(rou), '取得原価−減価償却累計額', { accent: 'lessee', calc: byContract('期末に消去する使用権資産（簿価）', rou, (r) => r.ps.close.cost - r.ps.close.acc) }),
    kpi('当期の連結損益への影響（税引前）', fmt(plPre), '＋は消去により連結利益が増加', { accent: 'diff', calc: byContract('当期の連結損益への影響（税引前）', plPre, (r) => sumE(r.E.close) - sumE(r.E.open), '期末の消去差額（純資産修正額）−期首の消去差額。借手の費用（償却費＋利息）と貸手の定額収益の差です。') }),
    kpi('法人税等調整額', fmt(tax), '当期の連結修正による増減（＋は費用の増加）', { calc: byContract('法人税等調整額', tax, (r) => sumE(r.DT.close) - sumE(r.DT.open), '会社ごとの消去差額 × 法定実効税率の期末額 − 期首額（個別税効果の取消）。') }),
    kpi('非支配株主に帰属する利益', fmt(nci), '当期の連結修正による増減', { calc: byContract('非支配株主に帰属する当期純利益', nci, (r) => r.journals.flatMap((j) => j.lines).filter((l) => l.acc === 'NCI_PL').reduce((a, l) => a + l.amt, 0), '（借手・貸手の税効果後の消去差額の合計）× 借手の非支配株主持分比率 の当期の増減。') }),
    kpi('検算', h('span', null, ngs ? statusBadge('ng', `NG ${ngs}件`) : warns ? statusBadge('warn', `確認事項 ${warns}件`) : statusBadge('ok', 'すべてOK')), h('a', { href: '#checks' }, '検算の詳細へ')));

  // 相関図
  const involved = new Set(data.contracts.flatMap((c) => [c.lessorCo, c.lesseeCo]));
  // 出資関係図の配置：親会社は常に表示し、グループ内リースのある子会社を下に並べる
  // 親会社持分は期末時点の比率（持分比率の推移・履歴を反映）。期中に変わったときは期首→期末を表示する
  const ownAt = (c, i) => 1 - rateAt(c, i, 'nciRatio');
  const ownTxt = (c) => { const a = ownAt(c, period.start), z = ownAt(c, period.end); const f = (v) => `${+(v * 100).toFixed(1)}%`; return a === z ? f(z) : `${f(a)}→${f(z)}`; };
  const nodes = companies.filter((c) => c.isParent || involved.has(c.code)).map((c) => ({ id: c.code, label: `${c.code} ${c.name.replace(/[（(].*$/, '')}`.slice(0, 12), sub: `${c.isParent ? '親会社' : `親会社持分 ${ownTxt(c)}`}・${c.fyeMonth}月決算`, parent: c.isParent, own: c.isParent ? undefined : ownAt(c, period.end) }));
  const pairs = new Map();
  for (const r of res) {
    const k = `${r.contract.lessorCo}>${r.contract.lesseeCo}`;
    const p = pairs.get(k) || { from: r.contract.lessorCo, to: r.contract.lesseeCo, n: 0, L: 0, inc: 0, detail: [] };
    p.n++; p.L += r.ps.close.L; p.inc += r.ps.inc;
    p.detail.push(`${r.contract.id} ${r.contract.name}：期末負債 ${fmt(r.ps.close.L)}、当期受取 ${fmt(r.ps.inc)}`);
    pairs.set(k, p);
  }
  const edges = [...pairs.values()].map((p) => ({ from: p.from, to: p.to, label: `${p.n}件／負債 ${fmt(p.L)}`, detail: p.detail, weight: p.inc || 1 }));
  const net = network({ title: 'グループ内リースの関係図（出資関係とリース）', subtitle: `${period.label}末時点。線にカーソルを合わせると契約明細を表示`, nodes, edges });

  // 年度別推移（全契約合算）：スケジュールから直接集計（契約番号で突き合わせ、計算エラーの契約は除外）
  const scheds = [...ctx.schedCache.entries()];
  const firstOn = scheds.length ? Math.min(...scheds.map(([, sc]) => sc.meta.measStart)) : period.start;
  const fyList = yearPeriods.filter((p) => p.end >= firstOn).slice(0, 15);
  const labels = fyList.map((p) => p.label.replace('年', '/').replace('月期', ''));
  const eAt = (sc, idx) => Object.values(eFromSchedule(sc, idx, pol)).reduce((a, v) => a + v, 0);
  const balAt = (sc, idx, f) => { const r = idx >= sc.meta.firstIdx && idx <= sc.meta.lastIdx ? sc.byIndex(idx) : null; return r && !r.lessee.term ? f(r) : 0; };
  const lseries = fyList.map((p) => scheds.reduce((a, [, sc]) => a + balAt(sc, p.end, (r) => r.lessee.L_end || 0), 0));
  const rseries = fyList.map((p) => scheds.reduce((a, [, sc]) => a + balAt(sc, p.end, (r) => (r.lessee.cost_end || 0) - (r.lessee.acc_end || 0)), 0));
  const eseries = fyList.map((p) => scheds.reduce((a, [, sc]) => a + eAt(sc, p.end), 0));
  const perId = new Map(scheds.map(([id, sc]) => [id, fyList.map((p) => eAt(sc, p.end) - eAt(sc, p.start - 1))]));
  // 契約が多くても見やすいよう、契約別には分けず全契約の合計で表示する（契約別の内訳は「表で見る」・契約画面で確認）
  const plTotal = fyList.map((_, k) => [...perId.values()].reduce((a, v) => a + v[k], 0));
  const plChart = barChart({ wide: true, title: '年度別：消去による連結損益への影響（税引前・全契約の合計）', subtitle: '借手の費用（償却費＋利息）が逓減するため、前半は利益増加（＋）、後半は減少（△）となり、契約の終了時に累計0に戻ります。契約ごとの内訳は契約の画面で確認できます', labels, series: [{ name: '連結損益への影響（税引前）', values: plTotal, color: COLORS.diff }], unit: ctx.unit });
  const balChart = lineChart({ title: '年度末：消去するリース負債と使用権資産簿価（全契約）', subtitle: '2本の線の差が「消去差額」。差は小さいため、右の「消去差額の推移」で拡大表示しています', labels, series: [{ name: 'リース負債', values: lseries, color: COLORS.lessee }, { name: '使用権資産簿価', values: rseries, color: COLORS.lessor, dashed: true }], unit: ctx.unit });
  const diffChart = barChart({ title: '年度末：消去差額（純資産修正額）の推移（全契約）', subtitle: '＝リース負債＋未払−使用権資産簿価−貸手の未収。連結上の利益剰余金（税引前）への累積影響', labels, series: [{ name: '消去差額（累計）', values: eseries, color: COLORS.diff }], unit: ctx.unit });

  const chk = card('検算サマリー', table([
    { label: '状態', render: (c) => h('td', null, statusBadge(c.status)) },
    { label: '検算項目', render: (c) => h('td', null, h('a', { href: `#checks` }, `${c.id} ${c.title}`)) },
    { label: '結果', key: 'detail' },
  ], checks));

  return h('div', { class: 'page' },
    kpis,
    h('div', { class: 'grid2' }, card(null, net), card(null, diffChart)),
    card(null, plChart),
    card(null, balChart),
    chk);
}
