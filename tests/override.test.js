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
