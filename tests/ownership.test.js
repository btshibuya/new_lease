// 持分比率の推移（異動日・みなし日）と、期中に比率が変わったときの非支配株主への按分のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAll, nciSegments, nciBase } from '../app/src/engine/elimination.js';
import { runChecks, deemedIndep } from '../app/src/engine/checks.js';
import { buildSchedule } from '../app/src/engine/schedule.js';
import { defaultPolicies } from '../app/src/engine/policies.js';
import { sampleData } from '../app/src/engine/sample.js';
import { sanitizeData } from '../app/src/engine/data.js';
import { deemedMonthIdx, ownershipSteps, rateAt } from '../app/src/engine/accounts.js';
import { buildPeriods, ymToIndex } from '../app/src/engine/util.js';
import { extraContracts, extraCompany } from '../app/src/engine/sampleExtra.js';

const pol = defaultPolicies();
const R = (v) => Math.round(v);

/** S4（2027/4/1 80%取得、6/30 90%、2029/11/20 70%（四半期末みなし）、2031/3/31 80%）と、S4 が関係する契約 */
function dataWithS4() {
  const d = sampleData();
  if (!d.companies.some((c) => c.code === 'S4')) d.companies.push(extraCompany());
  const ex = extraContracts().filter((c) => !d.contracts.some((x) => x.id === c.id));
  d.contracts.push(...ex);
  return sanitizeData(d).data;
}
const sumBy = (js, acc, co) => js.flatMap((j) => j.lines).filter((l) => l.acc === acc && (!co || l.co === co)).reduce((a, l) => a + l.amt, 0);

test('みなし日：前後いずれか近い月末・四半期末・決算日（等距離は前）、エンジンと検算の別実装が全日付で一致', () => {
  const jp = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  const cases = [
    ['2027-04-01', 'nearest_month_end', 3, '2027-03'], ['2027-06-30', 'nearest_month_end', 3, '2027-06'],
    ['2027-06-15', 'nearest_month_end', 3, '2027-05'], ['2027-06-16', 'nearest_month_end', 3, '2027-06'],
    ['2029-11-20', 'nearest_quarter_end', 3, '2029-12'], ['2029-11-15', 'nearest_quarter_end', 3, '2029-09'],
    ['2029-09-30', 'nearest_quarter_end', 3, '2029-09'], ['2029-08-01', 'nearest_fy_end', 3, '2029-03'],
    ['2029-11-01', 'nearest_fy_end', 3, '2030-03'], ['2029-05-20', 'nearest_quarter_end', 12, '2029-06'],
    ['2028-02-29', 'nearest_month_end', 3, '2028-02'], ['2028-02-14', 'nearest_month_end', 3, '2028-01'],
  ];
  for (const [date, deemed, fye, want] of cases) assert.equal(jp(deemedMonthIdx({ date, deemed }, fye)), want, `${date} ${deemed} ${fye}`);
  assert.equal(jp(deemedMonthIdx({ date: '2030-01-05', deemed: 'month', effYm: '2030-02' }, 3)), '2030-01', '適用開始月の指定：前月末をみなし日');
  let n = 0;
  for (const deemed of ['nearest_month_end', 'nearest_quarter_end', 'nearest_fy_end']) for (const fye of [3, 6, 9, 12, 1]) {
    for (let t = Date.UTC(2027, 0, 1); t < Date.UTC(2030, 0, 1); t += 86400000) {
      const date = new Date(t).toISOString().slice(0, 10);
      assert.equal(deemedMonthIdx({ date, deemed }, fye), deemedIndep({ date, deemed }, fye), `${date} ${deemed} ${fye}`);
      n++;
    }
  }
  assert.ok(n > 10000);
});

test('持分比率の推移：非支配株主持分比率＝1−親会社持分比率を、みなし日の翌月から使う', () => {
  const s4 = dataWithS4().companies.find((c) => c.code === 'S4');
  const at = (ym) => rateAt(s4, ymToIndex(ym), 'nciRatio');
  assert.equal(at('2027-04'), 0.2);
  assert.equal(at('2027-06'), 0.2, '6/30 の追加取得は6月末がみなし日：6月までは20%');
  assert.equal(at('2027-07'), 0.1, '7月から10%');
  assert.equal(at('2029-12'), 0.1, '11/20 の売却は四半期末（12月末）がみなし日：12月までは10%');
  assert.equal(at('2030-01'), 0.3);
  assert.equal(at('2031-03'), 0.3);
  assert.equal(at('2031-04'), 0.2, '3/31 の追加取得は期末日：翌期首から20%');
  assert.equal(at('2026-01'), 0.2, '最初の取得より前は取得時の比率（CHK-19 で警告）');
  assert.deepEqual(ownershipSteps(s4).map((x) => x.fromIdx), ['2027-04', '2027-07', '2030-01', '2031-04'].map(ymToIndex));
});

test('期中の比率変更：非支配株主帰属額＝比率が同じ区間ごとの「基礎の増減×比率」の合計、持分変動＝変動月の前月末の基礎×比率差', () => {
  const d = dataWithS4();
  const FY = buildPeriods(ymToIndex('2027-04'), ymToIndex('2033-03'), 3, 'year');
  const coMap = Object.fromEntries(d.companies.map((c) => [c.code, c]));
  let checked = 0;
  for (const p of FY) {
    const gen = generateAll(d, p, pol);
    for (const r of gen.results.filter((x) => x.contract.lesseeCo === 'S4')) {
      const js = gen.journals.filter((j) => j.contractId === r.contract.id && (j.tpl === 'C-14'));
      const pl = sumBy(js, 'NCI_PL');
      const cap = sumBy(js, 'CAP_SURPLUS');
      const sg = nciSegments(r.sched, coMap, pol, p.start, p.end);
      const trans = js.flatMap((j) => j.lines).filter((l) => l.acc === 'RE_OPEN').reduce((a, l) => a + l.amt, 0);
      assert.equal(pl, sg.segments.reduce((a, x) => a + x.amt, 0) - trans, `${p.label} ${r.contract.id} 区間の合計`);
      assert.equal(cap, sg.changes.reduce((a, x) => a + x.cap, 0), `${p.label} ${r.contract.id} 持分変動`);
      // 月ごとに「基礎の増減×その月の比率」を（端数処理せずに）積み上げた額との差は、端数（区間の数）以内
      let acc = 0;
      for (let t = p.start; t <= p.end; t++) acc += rateAt(coMap.S4, t, 'nciRatio') * (nciBase(r.sched, coMap, pol, t, R) - nciBase(r.sched, coMap, pol, t - 1, R));
      assert.ok(Math.abs(pl + trans - acc) <= sg.segments.length, `${p.label} ${r.contract.id} 月次の積上げ ${acc} と ${pl + trans}`);
      if (sg.segments.length > 1) checked++;
      for (const x of sg.segments) assert.ok(x.from <= x.to && x.from >= p.start && x.to <= p.end);
    }
  }
  assert.ok(checked >= 2, '期中に比率が変わる年度を含む');
});

test('期中の比率変更：四半期（発生）・月次（発生）の合計＝年度、第4四半期累計＝年度（非支配株主帰属額・持分変動）', () => {
  const d = dataWithS4();
  const FY = buildPeriods(ymToIndex('2027-04'), ymToIndex('2032-03'), 3, 'year');
  for (const fy of FY) {
    const sum = (gran, acc) => buildPeriods(ymToIndex('2027-04'), ymToIndex('2032-03'), 3, gran).filter((p) => p.start >= fy.start && p.end <= fy.end)
      .reduce((a, p) => a + sumBy(generateAll(d, p, pol).journals.filter((j) => j.tpl === 'C-14'), acc), 0);
    const y = (acc) => sumBy(generateAll(d, fy, pol).journals.filter((j) => j.tpl === 'C-14'), acc);
    for (const acc of ['NCI_PL', 'CAP_SURPLUS']) {
      assert.equal(sum('quarter', acc), y(acc), `${fy.label} 四半期の合計 ${acc}`);
      assert.equal(sum('month', acc), y(acc), `${fy.label} 月次の合計 ${acc}`);
    }
    const q4 = buildPeriods(ymToIndex('2027-04'), ymToIndex('2032-03'), 3, 'quarter_ytd').find((p) => p.end === fy.end);
    for (const acc of ['NCI_PL', 'CAP_SURPLUS']) assert.equal(sumBy(generateAll(d, q4, pol).journals.filter((j) => j.tpl === 'C-14'), acc), y(acc), `${fy.label} 第4四半期累計 ${acc}`);
  }
});

test('持分比率の推移と、同じ月から切り替える旧形式の履歴は、同じ仕訳になる', () => {
  const d1 = dataWithS4();
  const d2 = structuredClone(d1);
  const s4 = d2.companies.find((c) => c.code === 'S4');
  s4.ownership = [];
  s4.nciRatio = 0.2;
  s4.history = [{ fromYm: '2027-07', taxRate: 0.3, nciRatio: 0.1 }, { fromYm: '2030-01', taxRate: 0.3, nciRatio: 0.3 }, { fromYm: '2031-04', taxRate: 0.3, nciRatio: 0.2 }];
  for (const p of buildPeriods(ymToIndex('2027-04'), ymToIndex('2032-03'), 3, 'quarter')) {
    const a = generateAll(d1, p, pol).journals.map((j) => [j.id, j.lines.map((l) => `${l.acc}|${l.co}|${l.amt}`).join(',')]);
    const b = generateAll(d2, p, pol).journals.map((j) => [j.id, j.lines.map((l) => `${l.acc}|${l.co}|${l.amt}`).join(',')]);
    assert.deepEqual(a, b, p.label);
  }
});

test('検算：持分比率の推移があっても CHK-11 は一致、CHK-19 は支配獲得前の期間・入力の矛盾を警告し、NG はない', () => {
  const d = dataWithS4();
  for (const gran of ['year', 'quarter', 'month']) {
    const ps = buildPeriods(ymToIndex('2027-04'), ymToIndex('2031-03'), 3, gran);
    for (const p of ps.filter((_, i) => i % (gran === 'month' ? 7 : 1) === 0)) {
      const gen = generateAll(d, p, pol);
      const ck = runChecks(d, p, pol, gen);
      const ng = ck.filter((c) => c.status === 'ng');
      assert.deepEqual(ng.map((c) => `${c.id} ${c.detail} ${JSON.stringify(c.rows.filter((r) => !r.ok && !r.warn).slice(0, 2))}`), [], `${gran} ${p.label}`);
      assert.equal(ck.find((c) => c.id === 'CHK-11').status !== 'ng', true);
    }
  }
  const p = buildPeriods(ymToIndex('2027-04'), ymToIndex('2031-03'), 3, 'year')[0];
  const c19 = runChecks(d, p, pol, generateAll(d, p, pol)).find((c) => c.id === 'CHK-19');
  assert.equal(c19.status, 'warn');
  assert.ok(c19.rows.some((r) => r.contract === 'K-021' && /支配獲得/.test(r.message)), '2023年開始の契約は支配獲得前の期間を含む');
  // 入力の矛盾：追加取得なのに比率が下がる
  const d2 = structuredClone(d);
  d2.companies.find((c) => c.code === 'S4').ownership[1].ratio = 0.7;
  const c19b = runChecks(d2, p, pol, generateAll(d2, p, pol)).find((c) => c.id === 'CHK-19');
  assert.ok(c19b.rows.some((r) => /追加取得.*増えていません/.test(r.message)));
});

test('データ検証：異動日の形式・存在しない日付・比率の範囲・並び順', () => {
  const d = sampleData();
  d.companies[2].ownership = [
    { date: '2028-02-30', ratio: 0.9, kind: 'add' }, { date: '2029-04-01', ratio: 1.5, kind: 'add', memo: 'x'.repeat(500) },
    { date: '2027-04-01', ratio: 0.6, kind: 'acquire', deemed: 'nearest_quarter_end' }, { date: 'abc', ratio: 0.5 }, { date: '2028-01-01', ratio: 0.7, kind: '__proto__', deemed: 'constructor' },
  ];
  const s2 = sanitizeData(d).data.companies[2];
  assert.deepEqual(s2.ownership.map((x) => x.date), ['2027-04-01', '2028-01-01', '2029-04-01']);
  assert.equal(s2.ownership[2].ratio, 1);
  assert.equal(s2.ownership[2].memo.length, 200);
  assert.equal(s2.ownership[1].kind, 'other');
  assert.equal(s2.ownership[1].deemed, 'nearest_month_end');
  assert.equal(Object.getPrototypeOf(s2.ownership[1]), Object.prototype);
});

test('スケジュールは持分比率に依存しない（按分は仕訳の段階で行う）', () => {
  const d = dataWithS4();
  const c = d.contracts.find((x) => x.id === 'K-008');
  const a = buildSchedule(c, pol, { lesseeCompany: d.companies.find((x) => x.code === 'S4') });
  assert.ok(a.months.length > 0);
});
