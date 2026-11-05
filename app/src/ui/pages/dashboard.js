import { h, card, statusBadge, table } from '../dom.js';
import { kpi, COLORS, SERIES } from '../components.js';
import { network, barChart, lineChart } from '../charts.js';
import { generateAll } from '../../engine/elimination.js';
import { fmt } from '../../engine/util.js';

export function renderDashboard(ctx) {
  const { gen, period, companies, checks, data, pol, yearPeriods } = ctx;
  const res = gen.results;
  const sumClose = (f) => res.reduce((a, r) => a + f(r), 0);
  const L = sumClose((r) => r.ps.close.L);
  const rou = sumClose((r) => r.ps.close.cost - r.ps.close.acc);
  const plPre = sumClose((r) => Object.values(r.E.close).reduce((a, v) => a + v, 0) - Object.values(r.E.open).reduce((a, v) => a + v, 0));
  const tax = sumClose((r) => Object.values(r.DT.close).reduce((a, v) => a + v, 0) - Object.values(r.DT.open).reduce((a, v) => a + v, 0));
  const nci = sumClose((r) => Object.values(r.NCI.close).reduce((a, v) => a + v, 0) - Object.values(r.NCI.open).reduce((a, v) => a + v, 0));
  const active = res.filter((r) => r.ps.months > 0 && r.sched.meta.start <= period.end).length;
  const ngs = checks.filter((c) => c.status === 'ng').length;
  const warns = checks.filter((c) => c.status === 'warn').length;

  const kpis = h('div', { class: 'kpis' },
    kpi('当期に有効な契約', `${active} 件`, `登録 ${data.contracts.length} 件`),
    kpi('期末に消去するリース負債', fmt(L), '借手個別の残高（流動＋固定）', { accent: 'lessee' }),
    kpi('期末に消去する使用権資産（簿価）', fmt(rou), '取得原価−減価償却累計額', { accent: 'lessee' }),
    kpi('当期の連結損益への影響（税引前）', fmt(plPre), '＋は消去により連結利益が増加', { accent: 'diff' }),
    kpi('税効果・非支配株主帰属', `${fmt(-tax)} ／ ${fmt(-nci)}`, '法人税等調整額 ／ 非支配株主に帰属する利益（△は減少）'),
    kpi('検算', h('span', null, ngs ? statusBadge('ng', `NG ${ngs}件`) : warns ? statusBadge('warn', `警告 ${warns}件`) : statusBadge('ok', 'すべてOK')), h('a', { href: '#/checks' }, '検算の詳細へ')));

  // 相関図
  const involved = new Set(data.contracts.flatMap((c) => [c.lessorCo, c.lesseeCo]));
  const nodes = companies.filter((c) => involved.has(c.code)).map((c) => ({ id: c.code, label: `${c.code} ${c.name.replace(/[（(].*$/, '')}`.slice(0, 12), sub: `${c.isParent ? '親会社' : `非支配 ${(c.nciRatio * 100).toFixed(0)}%`}・${c.fyeMonth}月決算`, parent: c.isParent }));
  const pairs = new Map();
  for (const r of res) {
    const k = `${r.contract.lessorCo}>${r.contract.lesseeCo}`;
    const p = pairs.get(k) || { from: r.contract.lessorCo, to: r.contract.lesseeCo, n: 0, L: 0, inc: 0, detail: [] };
    p.n++; p.L += r.ps.close.L; p.inc += r.ps.inc;
    p.detail.push(`${r.contract.id} ${r.contract.name}：期末負債 ${fmt(r.ps.close.L)}、当期受取 ${fmt(r.ps.inc)}`);
    pairs.set(k, p);
  }
  const edges = [...pairs.values()].map((p) => ({ from: p.from, to: p.to, label: `${p.n}件／負債 ${fmt(p.L)}`, detail: p.detail, weight: p.inc || 1 }));
  const net = network({ title: 'グループ内リース相関図（矢印：貸手→借手、太さ：当期の受取リース料）', subtitle: `${period.label}末時点。線にカーソルを合わせると契約明細を表示`, nodes, edges });

  // 年度別推移（全契約合算）
  const labels = [], lseries = [], rseries = [], perContract = data.contracts.map(() => []);
  const firstOn = Math.min(...[...ctx.schedCache.values()].map((sc) => sc.meta.measStart));
  const fyList = yearPeriods.filter((p) => p.end >= firstOn).slice(0, 12);
  for (const p of fyList) {
    const g = generateAll(data, p, pol, { schedCache: ctx.schedCache });
    labels.push(p.label.replace('年', '/').replace('月期', ''));
    lseries.push(g.results.reduce((a, r) => a + r.ps.close.L, 0));
    rseries.push(g.results.reduce((a, r) => a + r.ps.close.cost - r.ps.close.acc, 0));
    g.results.forEach((r, i) => {
      const e = Object.values(r.E.close).reduce((a, v) => a + v, 0) - Object.values(r.E.open).reduce((a, v) => a + v, 0);
      perContract[i].push(e);
    });
  }
  const top = data.contracts.slice(0, 7);
  const series = top.map((c, i) => ({ name: c.id, values: perContract[i], color: SERIES[i % 8] }));
  if (data.contracts.length > 7) series.push({ name: 'その他', values: labels.map((_, k) => perContract.slice(7).reduce((a, v) => a + v[k], 0)), color: 'var(--s8)' });
  const plChart = barChart({ wide: true, title: '年度別：消去による連結損益への影響（税引前・契約別積上げ）', subtitle: '借手の費用（償却費＋利息）が逓減するため、前半は利益増加（＋）、後半は減少（△）となり、期間全体では0になります', labels, series, stacked: true, unit: ctx.unit });
  const balChart = lineChart({ title: '年度末：消去するリース負債と使用権資産簿価（全契約）', subtitle: '2本の線の差（塗りつぶし）が「消去差額」＝連結上の利益剰余金への累積影響', labels, series: [{ name: 'リース負債', values: lseries, color: COLORS.lessee }, { name: '使用権資産簿価', values: rseries, color: COLORS.lessor, dashed: true }], band: { upper: 0, lower: 1, name: '消去差額', color: COLORS.diff }, unit: ctx.unit });

  const chk = card('検算サマリー', table([
    { label: '状態', render: (c) => h('td', null, statusBadge(c.status)) },
    { label: '検算項目', render: (c) => h('td', null, h('a', { href: `#/checks` }, `${c.id} ${c.title}`)) },
    { label: '結果', key: 'detail' },
  ], checks));

  return h('div', { class: 'page' },
    h('h1', null, `ダッシュボード（${period.label}）`),
    kpis,
    h('div', { class: 'grid2' }, card(null, net), card(null, balChart)),
    card(null, plChart),
    chk);
}
