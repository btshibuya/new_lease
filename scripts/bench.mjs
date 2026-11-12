// 計算・集計の処理時間（中央値、ms）。使い方：node scripts/bench.mjs
// 性能が劣化していないかを、契約数を増やしたときなどに確かめるために使う。
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const withExtra = process.argv.includes('extra');
const E = (p) => import(`${root}/app/src/engine/${p}`);
const { generateAll } = await E('elimination.js');
const { runChecks } = await E('checks.js');
const { buildSchedule } = await E('schedule.js');
const { defaultPolicies } = await E('policies.js');
const { sampleData } = await E('sample.js');
const { sanitizeData } = await E('data.js');
const { buildPeriods, ymToIndex } = await E('util.js');
const { worksheet, companyMonthly } = await E('reports.js');
const { groupNoteAmounts } = await E('notes.js');
const pol = defaultPolicies();
let d = sampleData();
if (withExtra && !d.contracts.some((c) => c.id === 'K-027')) {
  const { extraContracts, extraCompany } = await import(`${root}/app/src/engine/sampleExtra.js`);
  const s4 = extraCompany();
  s4.history = [{ fromYm: '2027-07', nciRatio: 0.1 }, { fromYm: '2030-01', nciRatio: 0.3 }, { fromYm: '2031-04', nciRatio: 0.2 }];
  d.companies.push(s4); d.contracts.push(...extraContracts());
}
d = sanitizeData(d).data;
const med = (f, n = 5) => { const t = []; let r; for (let i = 0; i < n; i++) { const a = performance.now(); r = f(); t.push(performance.now() - a); } t.sort((a, b) => a - b); return [t[Math.floor(n / 2)], r]; };
const out = {};
const [tS, cache] = med(() => { const m = new Map(); for (const c of d.contracts) m.set(c.id, buildSchedule(c, pol, { lesseeCompany: d.companies.find((x) => x.code === c.lesseeCo) })); return m; });
out['スケジュール作成（全契約）'] = tS;
for (const gran of ['year', 'quarter', 'month']) {
  const ps = buildPeriods(ymToIndex('2024-04'), ymToIndex('2045-03'), 3, gran);
  const p = ps.find((x) => x.start >= ymToIndex('2029-04'));
  const [tg, gen] = med(() => generateAll(d, p, pol, { schedCache: cache }));
  out[`仕訳作成（${gran}）`] = tg;
  out[`検算（${gran}）`] = med(() => runChecks(d, p, pol, gen, {}, { schedCache: cache, lockCache: new Map() }))[0];
  if (gran === 'year') {
    out['精算表'] = med(() => worksheet(gen, d.companies, pol, {}, p))[0];
    out['注記'] = med(() => groupNoteAmounts(gen, p, pol, d.companies))[0];
    const items = d.contracts.map((c) => ({ contract: c, sched: cache.get(c.id) }));
    out['会社別の集計（全社）'] = med(() => d.companies.map((c) => companyMonthly(items, c.code, pol)), 3)[0];
  }
}
console.log(JSON.stringify({ contracts: d.contracts.length, ms: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v * 10) / 10])) }));
