// 連結修正仕訳の繰越設定（内容別）と開始仕訳の年度別トレースのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAll, CARRY_DEFS, carryWarnings, openingTrace } from '../app/src/engine/elimination.js';
import { runChecks } from '../app/src/engine/checks.js';
import { defaultPolicies } from '../app/src/engine/policies.js';
import { sampleData } from '../app/src/engine/sample.js';
import { buildPeriods, ymToIndex } from '../app/src/engine/util.js';

const pol = defaultPolicies();
const base = sampleData();
const FY = buildPeriods(ymToIndex('2027-04'), ymToIndex('2033-03'), 3, 'year');
const Q = buildPeriods(ymToIndex('2027-04'), ymToIndex('2030-03'), 3, 'quarter');
const YEARS = buildPeriods(ymToIndex('2024-04'), ymToIndex('2040-03'), 3, 'year');
const withCarry = (carry) => ({ ...structuredClone(base), config: { ...base.config, carry } });
const netByAcc = (gen) => {
  const m = new Map();
  for (const j of gen.journals) for (const l of j.lines) { const k = `${l.acc}|${l.co}|${j.contractId}`; m.set(k, (m.get(k) || 0) + l.amt); }
  for (const [k, v] of [...m]) if (!v) m.delete(k);
  return Object.fromEntries([...m].sort());
};
const all = (mode) => Object.fromEntries(CARRY_DEFS.filter((d) => !d.fixed).map((d) => [d.tpl, mode]));

test('繰越設定：繰越あり（洗替あり・なし）のどの組合せでも、科目・会社・契約別の連結修正の純額は初期設定と同じ', () => {
  const variants = [all('carry_reverse'), all('carry'), { ...all('carry'), 'C-10': 'carry_reverse', 'C-11': 'carry' }, { 'C-03': 'carry_reverse', 'C-13': 'carry_reverse', 'C-14': 'carry_reverse' }];
  for (const p of [...FY.slice(0, 6), ...Q.slice(0, 8)]) {
    const ref = netByAcc(generateAll(base, p, pol));
    for (const v of variants) {
      const d = withCarry(v);
      const gen = generateAll(d, p, pol);
      assert.deepEqual(netByAcc(gen), ref, `${p.label} ${JSON.stringify(v)}`);
      const bad = runChecks(d, p, pol, gen).filter((c) => c.status === 'ng').map((c) => c.id);
      assert.deepEqual(bad, [], `${p.label} ${JSON.stringify(v)} 検算NG`);
      for (const j of gen.journals) assert.equal(j.lines.reduce((a, l) => a + l.amt, 0), 0, `${j.id} 貸借一致`);
    }
  }
});

test('繰越設定：洗替ありでは開始仕訳・洗替・期末の全額計上の3本になり、洗替は開始仕訳の貸借対照表科目を戻す', () => {
  const p = FY[1];
  const gen = generateAll(withCarry({ 'C-03': 'carry_reverse' }), p, pol);
  const js = gen.journals.filter((j) => j.contractId === 'K-001' && (j.src === 'C-03' || j.tpl === 'C-03'));
  assert.deepEqual(js.map((j) => j.tpl).sort(), ['C-01', 'C-01R', 'C-03']);
  const open = js.find((j) => j.tpl === 'C-01'), rev = js.find((j) => j.tpl === 'C-01R');
  const bs = (j) => j.lines.filter((l) => l.acc === 'ROU_ACC').reduce((a, l) => a + l.amt, 0);
  assert.equal(bs(rev), -bs(open));
  assert.ok(js.find((j) => j.tpl === 'C-03').full);
});

test('繰越設定：翌期の剰余金に影響する仕訳を「繰越なし」にすると警告し、検算で NG になる', () => {
  assert.deepEqual(carryWarnings({}), []);
  assert.deepEqual(carryWarnings({ 'C-10': 'none', 'C-11': 'carry' }), []);
  const w = carryWarnings({ 'C-03': 'none' });
  assert.equal(w.length, 1);
  assert.match(w[0], /C-03/);
  const d = withCarry({ 'C-03': 'none' });
  const p = FY[1];
  const ng = runChecks(d, p, pol, generateAll(d, p, pol)).filter((c) => c.status === 'ng').map((c) => c.id);
  assert.ok(ng.includes('CHK-05'), ng.join(','));
});

test('開始仕訳の年度別トレース：年度別の金額の合計は、開始仕訳（内容別・会社別・科目別）と一致', () => {
  for (const carry of [{}, all('carry_reverse'), { 'C-10': 'carry', 'C-11': 'carry' }]) {
    const d = withCarry(carry);
    for (const p of FY.slice(1, 6)) {
      const gen = generateAll(d, p, pol);
      for (const j of gen.journals.filter((x) => ['C-01', 'C-01T', 'C-01N'].includes(x.tpl))) {
        const r = gen.results.find((x) => x.contract.id === j.contractId);
        const tr = openingTrace(r, j, YEARS, pol, d.companies);
        const sum = new Map();
        for (const x of tr) sum.set(`${x.acc}|${x.co}`, (sum.get(`${x.acc}|${x.co}`) || 0) + x.amt);
        for (const [k, v] of [...sum]) if (!v) sum.delete(k);
        const exp = new Map();
        for (const l of j.lines) exp.set(`${l.acc}|${l.co}`, (exp.get(`${l.acc}|${l.co}`) || 0) + l.amt);
        assert.deepEqual(Object.fromEntries([...sum].sort()), Object.fromEntries([...exp].sort()), `${p.label} ${j.id}`);
        assert.ok(tr.every((x) => YEARS.some((y) => y.label === x.year) && YEARS.find((y) => y.label === x.year).end < p.start), `${j.id} 前期以前の年度`);
      }
    }
  }
});
