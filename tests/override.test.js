// 手修正（仕訳金額・返済スケジュール）と四半期（累計）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAll, overrideKey, overrideDiff, overrideSuggestions } from '../app/src/engine/elimination.js';
import { runChecks } from '../app/src/engine/checks.js';
import { buildSchedule } from '../app/src/engine/schedule.js';
import { defaultPolicies } from '../app/src/engine/policies.js';
import { sampleData } from '../app/src/engine/sample.js';
import { sanitizeData } from '../app/src/engine/data.js';
import { buildPeriods, ymToIndex, indexToYm } from '../app/src/engine/util.js';
import { ACCOUNTS } from '../app/src/engine/accounts.js';

const pol = defaultPolicies();
const base = sampleData();
const FY = buildPeriods(ymToIndex('2027-04'), ymToIndex('2033-03'), 3, 'year');
const net = (js, cid) => { const m = {}; for (const j of js.filter((x) => !cid || x.contractId === cid)) for (const l of j.lines) { const k = `${l.acc}|${l.co}`; m[k] = (m[k] || 0) + l.amt; } for (const k of Object.keys(m)) if (!m[k]) delete m[k]; return m; };

function withOverride(p, tplOf, edit) {
  const d = structuredClone(base);
  const g = generateAll(d, p, pol);
  const j = g.journals.find((x) => x.contractId === 'K-001' && tplOf(x));
  const lines = edit(j.lines.map((l) => ({ acc: l.acc, co: l.co, amt: l.amt })));
  d.overrides = { journals: [{ key: overrideKey(p, j), periodStart: indexToYm(p.start), periodEnd: indexToYm(p.end), contractId: 'K-001', tpl: j.tpl, src: j.src || '', lines, orig: j.lines.map((l) => ({ acc: l.acc, co: l.co, amt: l.amt })), reason: 'テスト', at: '2026-11-07' }] };
  return sanitizeData(d).data;
}

test('手修正：仕訳の金額を置き換え、元の行を残す。検算は NG にならず、手修正の確認事項（CHK-18）を出す', () => {
  const p = FY[0];
  // C-03 の減価償却費を 10 増やす（貸借を保つ）
  const d = withOverride(p, (x) => x.tpl === 'C-03', (ls) => ls.map((l) => ({ ...l, amt: l.amt + (l.amt > 0 ? 10 : -10) })));
  const g = generateAll(d, p, pol);
  const j = g.journals.find((x) => x.contractId === 'K-001' && x.tpl === 'C-03');
  assert.ok(j.override && j.origLines);
  assert.equal(j.lines.find((l) => l.acc === 'ROU_ACC').amt, j.origLines.find((l) => l.acc === 'ROU_ACC').amt + 10);
  const cs = runChecks(d, p, pol, g);
  assert.deepEqual(cs.filter((c) => c.status === 'ng').map((c) => c.id), []);
  const c18 = cs.find((c) => c.id === 'CHK-18');
  assert.equal(c18.status, 'warn');
  assert.match(c18.rows[0].message, /償却月数/);
});

test('手修正：翌期以降の開始仕訳に差額を引き継ぐ（繰越ありの内容）。連結の残高は修正後の金額に従う', () => {
  const p = FY[0];
  const d = withOverride(p, (x) => x.tpl === 'C-03', (ls) => ls.map((l) => ({ ...l, amt: l.amt + (l.amt > 0 ? 10 : -10) })));
  for (const q of [FY[1], FY[2], ...buildPeriods(ymToIndex('2028-04'), ymToIndex('2029-03'), 3, 'quarter')]) {
    const g0 = generateAll(base, q, pol), g1 = generateAll(d, q, pol);
    const adj = g1.journals.filter((j) => j.carriedOverride && j.contractId === 'K-001');
    assert.equal(adj.length, 1, q.label);
    assert.deepEqual(net(adj), { 'ROU_ACC|S1': 10, 'RE_OPEN|S1': -10 }, q.label);
    const n0 = net(g0.journals, 'K-001'), n1 = net(g1.journals, 'K-001');
    assert.equal((n1['ROU_ACC|S1'] || 0) - (n0['ROU_ACC|S1'] || 0), 10, `${q.label} 減価償却累計額の差が残る`);
    assert.deepEqual(runChecks(d, q, pol, g1).filter((c) => c.status === 'ng').map((c) => c.id), [], q.label);
  }
  // 繰越なしにすると引き継がない
  const d2 = { ...d, config: { ...d.config, carry: { 'C-03': 'none' } } };
  assert.equal(generateAll(d2, FY[1], pol).journals.filter((j) => j.carriedOverride).length, 0);
});

test('手修正：修正候補（契約情報・会社マスタの項目）を返す', () => {
  const s = overrideSuggestions([{ acc: 'INT', co: 'S1', amt: 5 }, { acc: 'DTA', co: 'S1', amt: -1 }]);
  assert.ok(s.some((x) => x.label === '割引率（年％）' && x.page === 'contracts'));
  assert.ok(s.some((x) => x.label === '法定実効税率（％）' && x.page === 'companies'));
  assert.deepEqual(overrideDiff({ lines: [{ acc: 'A', co: 'X', amt: 5 }], orig: [{ acc: 'A', co: 'X', amt: 3 }] }), [{ acc: 'A', co: 'X', amt: 2 }]);
});

test('返済スケジュールの手修正：支払額を変えるとリース負債・利息・貸手の収益に反映し、検算は一致する', () => {
  const d = structuredClone(base);
  const c = d.contracts.find((x) => x.id === 'K-001');
  const s0 = buildSchedule(c, pol);
  const pm = s0.months.find((x) => x.lessee.pay > 0 && x.m > ymToIndex('2029-01'));
  c.paymentOverrides = [{ ym: indexToYm(pm.m), amount: pm.lessee.pay + 200, reason: 'テスト' }];
  c.actuals = {}; // 帳簿の実績（修正前の金額）との突合 CHK-10 は差異になるため除く
  const data = sanitizeData(d).data;
  const s1 = buildSchedule(data.contracts.find((x) => x.id === 'K-001'), pol);
  assert.equal(s1.byIndex(pm.m).lessee.pay, pm.lessee.pay + 200);
  assert.ok(s1.meta.L0 > s0.meta.L0, 'リース負債の当初測定額が増える');
  for (const p of FY.slice(0, 5)) {
    const g = generateAll(data, p, pol);
    const bad = runChecks(data, p, pol, g).filter((x) => x.status === 'ng').map((x) => x.id);
    assert.deepEqual(bad, [], p.label);
  }
});

test('四半期（累計）：第4四半期累計の仕訳は年度と同じ。第n四半期累計の損益＝第1〜n四半期（発生）の合計', () => {
  const ytd = buildPeriods(ymToIndex('2027-04'), ymToIndex('2030-03'), 3, 'quarter_ytd');
  const qs = buildPeriods(ymToIndex('2027-04'), ymToIndex('2030-03'), 3, 'quarter');
  const yr = buildPeriods(ymToIndex('2027-04'), ymToIndex('2030-03'), 3, 'year');
  const plNet = (js) => { const m = {}; for (const j of js) for (const l of j.lines) if (['DEP_ROU', 'INT', 'LEASE_INC', 'TAX_ADJ', 'NCI_PL', 'RENTAL_DEP', 'DEP_RECLASS'].includes(l.acc)) { const k = `${l.acc}|${l.co}|${j.contractId}`; m[k] = (m[k] || 0) + l.amt; } for (const k of Object.keys(m)) if (!m[k]) delete m[k]; return m; };
  for (let y = 0; y < 3; y++) {
    assert.deepEqual(net(generateAll(base, ytd[y * 4 + 3], pol).journals), net(generateAll(base, yr[y], pol).journals), `${yr[y].label}`);
    assert.equal(ytd[y * 4].start, yr[y].start);
    for (let n = 1; n <= 4; n++) {
      const sum = {};
      for (let k = 0; k < n; k++) for (const [key, v] of Object.entries(plNet(generateAll(base, qs[y * 4 + k], pol).journals))) sum[key] = (sum[key] || 0) + v;
      for (const k of Object.keys(sum)) if (!sum[k]) delete sum[k];
      // 税効果・非支配株主は期末残高の差で計算するため累計と発生の合計は一致する
      assert.deepEqual(plNet(generateAll(base, ytd[y * 4 + n - 1], pol).journals), sum, `${ytd[y * 4 + n - 1].label}`);
    }
    for (const p of ytd.slice(y * 4, y * 4 + 4)) assert.deepEqual(runChecks(base, p, pol, generateAll(base, p, pol)).filter((c) => c.status === 'ng').map((c) => c.id), [], p.label);
  }
});

import { contractMonthly, rollupMonthly, contractYearly, eFromSchedule } from '../app/src/engine/reports.js';
import { currentPortion } from '../app/src/engine/schedule.js';

test('契約の月次レポート：年度に集計すると年度別サマリー（支払・利息・元本・期末負債・簿価・償却費・借手費用・貸手収益・連結損益への影響）と一致', () => {
  const YRS = buildPeriods(ymToIndex('2022-04'), ymToIndex('2050-03'), 3, 'year'); // 最も長い契約（K-012：2047年3月まで）を含む
  // サンプルに加え、初期直接費用のある契約（日本基準）・ASC842 の契約・初期直接費用を資産計上する方針でも確かめる
  const extra = [
    { ...structuredClone(base.contracts.find((c) => c.id === 'K-001')), id: 'T-IDC', lessee: { ...base.contracts.find((c) => c.id === 'K-001').lessee, idc: 1200 } },
    { ...structuredClone(base.contracts.find((c) => c.id === 'K-004')), id: 'T-ASC' },
  ];
  for (const pl of [pol, { ...pol, 'POL-07': 'capitalize' }]) {
    for (const c of [...base.contracts, ...extra]) {
      const s = buildSchedule(c, pl, { lesseeCompany: base.companies.find((x) => x.code === c.lesseeCo) });
      const mo = contractMonthly(s, pl);
      const yr = rollupMonthly(mo, YRS);
      const ref = contractYearly(s, YRS, currentPortion);
      const eAt = (idx) => Object.values(eFromSchedule(s, idx, pl)).reduce((a, v) => a + v, 0);
      let n = 0;
      for (const y of yr) {
        const rf = ref.find((x) => x.label === y.label);
        if (!rf) continue;
        n++;
        const tag = `${c.id} ${y.label} ${pl['POL-07']}`;
        for (const [k, rk] of [['pay', 'pay'], ['int', 'int'], ['principal', 'principal'], ['L', 'closeL'], ['rou', 'rouNet'], ['dep', 'dep'], ['lesseeExp', 'lesseeExp'], ['inc', 'inc'], ['R', 'R'], ['X', 'X']]) assert.equal(y[k], rf[rk], `${tag} ${k}`);
        assert.equal(y.plEffect, eAt(rf.end) - eAt(rf.start - 1), `${tag} 連結損益への影響`);
        assert.equal(y.cumE, eAt(rf.end), `${tag} 消去差額の累計`);
        assert.equal(y.lesseeExp, y.dep + y.int + y.other, `${tag} 借手の費用の内訳`);
      }
      assert.ok(n > 0, c.id);
      if (!c.terminationYm) assert.equal(mo[mo.length - 1].cumE, 0, `${c.id} 終了時の消去差額`);
    }
  }
});

test('セキュリティ：保存データの注記の収集値・手修正で、__proto__ 等によるプロトタイプ汚染や未知の科目を受け付けない', () => {
  const raw = JSON.parse('{"noteInputs":{"2028-03":{"__proto__":{"L-VAR":{"total":1}},"constructor":{"L-VAR":{"total":2}},"P":{"L-VAR":{"total":3}}}},"overrides":{"journals":[{"periodStart":"2027-04","periodEnd":"2028-03","contractId":"K-001","tpl":"C-03","lines":[{"acc":"__proto__","co":"S1","amt":1},{"acc":"ROU_ACC","co":"__proto__","amt":1},{"acc":"ROU_ACC","co":"S1","amt":5}],"orig":[]}]}}');
  const d = sanitizeData({ ...structuredClone(base), ...raw }).data;
  assert.equal(({})['L-VAR'], undefined, 'Object.prototype が汚染されていない');
  assert.deepEqual(Object.keys(d.noteInputs['2028-03']), ['P']);
  assert.deepEqual(d.overrides.journals[0].lines, [{ acc: 'ROU_ACC', co: 'S1', amt: 5, label: '' }]);
});

test('月次（発生・累計）：期末月の累計＝年度、各月の累計の損益＝発生の合計、残高は期末で一致、検算は NG なし', () => {
  const mo = buildPeriods(ymToIndex('2027-04'), ymToIndex('2029-03'), 3, 'month');
  const ytd = buildPeriods(ymToIndex('2027-04'), ymToIndex('2029-03'), 3, 'month_ytd');
  const yr = buildPeriods(ymToIndex('2027-04'), ymToIndex('2029-03'), 3, 'year');
  assert.equal(mo.length, 24); assert.equal(ytd.length, 24);
  const plOf = (js) => { const m = {}; for (const j of js) for (const l of j.lines) if (ACCOUNTS[l.acc]?.type === 'PL') { const k = `${l.acc}|${l.co}|${j.contractId}`; m[k] = (m[k] || 0) + l.amt; } for (const k of Object.keys(m)) if (!m[k]) delete m[k]; return m; };
  const bsOf = (js) => { const m = {}; for (const j of js) for (const l of j.lines) if (ACCOUNTS[l.acc]?.type !== 'PL' && l.acc !== 'RE_OPEN') { const k = `${l.acc}|${l.co}|${j.contractId}`; m[k] = (m[k] || 0) + l.amt; } for (const k of Object.keys(m)) if (!m[k]) delete m[k]; return m; };
  for (let y = 0; y < 2; y++) {
    assert.deepEqual(net(generateAll(base, ytd[y * 12 + 11], pol).journals), net(generateAll(base, yr[y], pol).journals), yr[y].label);
    const sum = {};
    for (let k = 0; k < 12; k++) {
      const p = mo[y * 12 + k];
      const g = generateAll(base, p, pol);
      for (const [key, v] of Object.entries(plOf(g.journals))) sum[key] = (sum[key] || 0) + v;
      for (const kk of Object.keys(sum)) if (!sum[kk]) delete sum[kk];
      const gy = generateAll(base, ytd[y * 12 + k], pol);
      assert.deepEqual(plOf(gy.journals), sum, `${ytd[y * 12 + k].label} 損益＝発生の合計`);
      assert.deepEqual(bsOf(g.journals), bsOf(gy.journals), `${p.label} 期末残高は発生・累計で同じ`);
      if (k % 3 === 2) {
        for (const [pp, gg] of [[p, g], [ytd[y * 12 + k], gy]]) assert.deepEqual(runChecks(base, pp, pol, gg).filter((c) => c.status === 'ng').map((c) => c.id), [], pp.label);
      }
    }
  }
});

test('貸手の減価償却費の組替（C-12）：按分比率が1でなくても、区切りによらず合計が一致し、C-11 の償却累計額（按分後）の増加と一致する', () => {
  const d = structuredClone(base);
  for (const [id, r] of [['K-002', 1 / 3], ['K-003', 0.5], ['K-007', 0.5]]) { const c = d.contracts.find((x) => x.id === id); c.lessor.ratio = r; if (!c.lessor.assetCost) { c.lessor.assetCost = 900; c.lessor.assetLifeMonths = 120; c.lessor.assetStart = '2020-04'; } }
  const data = sanitizeData(d).data;
  const c12 = (p) => { const m = {}; for (const j of generateAll(data, p, pol).journals.filter((x) => x.tpl === 'C-12')) for (const l of j.lines.filter((x) => x.acc === 'DEP_RECLASS')) m[j.contractId] = (m[j.contractId] || 0) + l.amt; return m; };
  const acc11 = (p) => { const m = {}; for (const j of generateAll(data, p, pol).journals.filter((x) => (x.src || x.tpl) === 'C-11')) for (const l of j.lines.filter((x) => x.acc === 'RECLASS_ACC')) m[j.contractId] = (m[j.contractId] || 0) - l.amt; return m; };
  const yrs = buildPeriods(ymToIndex('2027-04'), ymToIndex('2031-03'), 3, 'year');
  const mos = buildPeriods(ymToIndex('2027-04'), ymToIndex('2031-03'), 3, 'month');
  for (const y of yrs) {
    const sum = {};
    for (const m of mos.filter((x) => x.start >= y.start && x.end <= y.end)) for (const [k, v] of Object.entries(c12(m))) sum[k] = (sum[k] || 0) + v;
    assert.deepEqual(c12(y), Object.fromEntries(Object.entries(sum).filter(([, v]) => v)), `${y.label} 月次の合計＝年度`);
    // 期中に終了しない契約は、C-12（当期の償却費）＝ C-11 の償却累計額の当期の増加
    const prev = { start: y.start - 1, end: y.start - 1, label: 'p', fyEnd: y.fyEnd - 12 };
    const a1 = acc11(y), a0 = acc11(prev), dep = c12(y);
    for (const id of ['K-002', 'K-007']) if (a1[id] && a0[id]) assert.equal(dep[id] || 0, a1[id] - a0[id], `${y.label} ${id}`);
  }
});

test('手修正：累計の期間どうしなど期間が重なる手修正は、期末が最も遅いものだけを引き継ぎ、CHK-18 で警告する', () => {
  const ytd = buildPeriods(ymToIndex('2027-04'), ymToIndex('2028-03'), 3, 'month_ytd');
  const d = structuredClone(base);
  d.overrides = { journals: [] };
  for (const p of [ytd[2], ytd[5], ytd[8], ytd[11]]) {
    const j = generateAll(base, p, pol).journals.find((x) => x.contractId === 'K-001' && x.tpl === 'C-03');
    const orig = j.lines.map((l) => ({ acc: l.acc, co: l.co, amt: l.amt }));
    d.overrides.journals.push({ key: overrideKey(p, j), periodStart: indexToYm(p.start), periodEnd: indexToYm(p.end), contractId: 'K-001', tpl: 'C-03', src: '', lines: orig.map((l) => ({ ...l, amt: l.amt + (l.amt > 0 ? 10 : -10) })), orig, reason: '累計の修正', at: '' });
  }
  const data = sanitizeData(d).data;
  const next = buildPeriods(ymToIndex('2028-04'), ymToIndex('2029-03'), 3, 'year')[0];
  const g = generateAll(data, next, pol);
  assert.deepEqual(net(g.journals.filter((j) => j.carriedOverride)), { 'ROU_ACC|S1': 10, 'RE_OPEN|S1': -10 });
  const c18 = runChecks(data, next, pol, g).find((c) => c.id === 'CHK-18');
  assert.ok(c18.rows.some((r) => /期間が重なる手修正/.test(r.message)));
});

import { companyMonthly, worksheet } from '../app/src/engine/reports.js';

test('会社別の集計：全社の借手の項目の合計＝全契約の合計、会社の純資産修正額の合計＝全契約の消去差額、年度に集計しても一致', () => {
  const items = base.contracts.map((c) => ({ contract: c, sched: buildSchedule(c, pol, { lesseeCompany: base.companies.find((x) => x.code === c.lesseeCo) }) }));
  const byM = new Map();
  for (const { sched } of items) for (const r of contractMonthly(sched, pol)) { const o = byM.get(r.m) || { int: 0, dep: 0, L: 0, inc: 0, cumE: 0, pay: 0 }; for (const k of Object.keys(o)) o[k] += r[k]; byM.set(r.m, o); }
  const tot = new Map();
  for (const co of base.companies.map((c) => c.code)) for (const r of companyMonthly(items, co, pol)) {
    const o = tot.get(r.m) || { int: 0, dep: 0, L: 0, inc: 0, cumE: 0, pay: 0 };
    for (const k of Object.keys(o)) o[k] += r[k];
    tot.set(r.m, o);
    // 契約ごとの内訳の合計＝会社の行
    // 画面に表示するすべての列で、契約ごとの内訳の合計＝会社の行
    for (const k of ['pay', 'principal', 'int', 'L', 'dep', 'assets', 'liabs', 'lesseeExp', 'inc', 'R', 'cumE', 'plImpact']) assert.equal(r.parts.reduce((a, p) => a + (p[k] || 0), 0), r[k], `${co} ${r.m} ${k}`);
  }
  for (const [m, o] of byM) assert.deepEqual(tot.get(m), o, `月 ${m}`);
  const YRS = buildPeriods(ymToIndex('2022-04'), ymToIndex('2050-03'), 3, 'year'); // 最も長い契約（K-012：2047年3月まで）を含む
  const s1 = companyMonthly(items, 'S1', pol);
  const y = rollupMonthly(s1, YRS);
  for (const r of y) assert.ok(Number.isFinite(r.pay) && Number.isFinite(r.eChange) && Number.isFinite(r.plImpact), r.label);
  assert.equal(y.reduce((a, r) => a + r.eChange, 0), s1[s1.length - 1].cumE - (s1[0].cumE - s1[0].eChange));
  // イベントは重複なく並ぶ
  for (const r of y) { const ev = r.event ? r.event.split('・') : []; assert.equal(new Set(ev).size, ev.length, r.label); }
});

test('会社別の集計：この会社の連結損益への影響（税引前）＝会社で抽出した精算表の損益の修正（税効果・非支配株主損益を除く）。C-12 の組替の有無どちらでも一致', () => {
  for (const p5 of ['by_lessee_dept', 'as_is']) {
    const pl5 = { ...pol, 'POL-05': p5 };
    const items = base.contracts.map((c) => ({ contract: c, sched: buildSchedule(c, pl5, { lesseeCompany: base.companies.find((x) => x.code === c.lesseeCo) }) }));
    const YRS = buildPeriods(ymToIndex('2024-04'), ymToIndex('2034-03'), 3, 'year');
    const mo = new Map(base.companies.map((c) => [c.code, companyMonthly(items, c.code, pl5)]));
    let nonzero = 0;
    for (const p of YRS) {
      const gen = generateAll(structuredClone(base), p, pl5);
      for (const co of base.companies.map((c) => c.code)) {
        const y = rollupMonthly(mo.get(co), [p])[0];
        const ws = worksheet(gen, base.companies, pl5, {}, p, { company: co });
        const pl = -ws.filter((r) => r.type === 'PL' && !['TAX_ADJ', 'NCI_PL'].includes(r.acc)).reduce((a, r) => a + r.ind + r.con, 0);
        assert.equal(y?.plImpact || 0, pl || 0, `${p5} ${p.label} ${co}`);
        if (pl) nonzero++;
      }
    }
    assert.ok(nonzero > 5, '比較した値が0ばかりではない');
  }
});
