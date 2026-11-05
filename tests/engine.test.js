// 計算エンジンの自動テスト（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, periodSummary, currentPortion, validateContract } from '../app/src/engine/schedule.js';
import { generateAll } from '../app/src/engine/elimination.js';
import { runChecks } from '../app/src/engine/checks.js';
import { defaultPolicies, POLICIES, sanitizePolicies } from '../app/src/engine/policies.js';
import { sampleData } from '../app/src/engine/sample.js';
import { buildPeriods, ymToIndex, round } from '../app/src/engine/util.js';
import { sanitizeData, csvCell, appendLog, verifyChain } from '../app/src/engine/data.js';
import { worksheet, MUST_BE_ZERO, contractYearly } from '../app/src/engine/reports.js';

const FY = buildPeriods(ymToIndex('2027-04'), ymToIndex('2032-03'), 3, 'year');
const pol = defaultPolicies();
const data = sampleData();
const k001 = data.contracts.find((c) => c.id === 'K-001');

function net(j) {
  const m = {};
  for (const l of j.lines) m[`${l.acc}`] = (m[l.acc] || 0) + l.amt;
  return m;
}

test('端数処理（四捨五入・切捨・切上、負数）', () => {
  assert.equal(round(2.5), 3);
  assert.equal(round(-2.5), -3);
  assert.equal(round(2.4999), 2);
  assert.equal(round(2.9, 'floor'), 2);
  assert.equal(round(2.1, 'ceil'), 3);
  assert.equal(round(-2.1, 'ceil'), -3);
});

test('設例（要件定義書 第10章）のスケジュールが期待値と一致', () => {
  const s = buildSchedule(k001, pol);
  assert.equal(s.meta.L0, 4580);
  const exp = [
    [0, 137, 1000, 3717, 3664, 916, 888],
    [3717, 112, 1000, 2829, 2748, 916, 915],
    [2829, 85, 1000, 1914, 1832, 916, 943],
    [1914, 57, 1000, 971, 916, 916, 971],
    [971, 29, 1000, 0, 0, 916, 0],
  ];
  FY.forEach((p, i) => {
    const ps = periodSummary(s, p.start, p.end);
    const [open, int, pay, close, rou, dep, cur] = exp[i];
    assert.equal(ps.open.L, open, `年${i + 1} 期首負債`);
    assert.equal(ps.int, int, `年${i + 1} 利息`);
    assert.equal(ps.pay, pay);
    assert.equal(ps.close.L, close, `年${i + 1} 期末負債`);
    assert.equal(ps.close.cost - ps.close.acc, rou, `年${i + 1} 使用権資産簿価`);
    assert.equal(ps.dep, dep);
    assert.equal(currentPortion(s, p.end), cur, `年${i + 1} 流動部分`);
  });
});

test('設例：1年目・2年目の連結修正仕訳が要件定義書と一致', () => {
  const d = { ...data, contracts: [k001] };
  const g1 = generateAll(d, FY[0], pol);
  const t = (g, tpl) => g.journals.find((j) => j.tpl === tpl);
  assert.deepEqual(net(t(g1, 'C-02')), { LL_NC: 4580, ROU_COST: -4580 });
  assert.deepEqual(net(t(g1, 'C-03')), { ROU_ACC: 916, DEP_ROU: -916 });
  assert.deepEqual(net(t(g1, 'C-04')), { LL_NC: -863, INT: -137, LEASE_INC: 1000 });
  assert.deepEqual(net(t(g1, 'C-10')), { LL_C: 888, LL_NC: -888 });
  assert.deepEqual(net(t(g1, 'C-13')), { TAX_ADJ: 16, DTA: -16 });
  assert.deepEqual(net(t(g1, 'C-11')), { RECLASS_ASSET: 6000, RENTAL_ASSET: -6000, RENTAL_ACC: 600, RECLASS_ACC: -600 });
  assert.deepEqual(net(t(g1, 'C-12')), { DEP_RECLASS: 600, RENTAL_DEP: -600 });
  const g2 = generateAll(d, FY[1], pol);
  assert.deepEqual(net(t(g2, 'C-01')), { LL_NC: 3717, ROU_COST: -4580, ROU_ACC: 916, RE_OPEN: -53 });
  assert.deepEqual(net(t(g2, 'C-01T')), { RE_OPEN: 16, DTA: -16 });
  assert.deepEqual(net(t(g2, 'C-04')), { LL_NC: -888, INT: -112, LEASE_INC: 1000 });
  assert.deepEqual(net(t(g2, 'C-13')), { TAX_ADJ: 8, DTA: -8 });
  assert.deepEqual(net(t(g2, 'C-10')), { LL_C: 915, LL_NC: -915 });
  // 4年目は消去差額が減少 → 税効果は貸借逆
  const g4 = generateAll(d, FY[3], pol);
  assert.deepEqual(net(t(g4, 'C-13')), { TAX_ADJ: -8, DTA: 8 });
  // 5年目：満了で全残高0、開始仕訳の取崩し
  const g5 = generateAll(d, FY[4], pol);
  const r5 = g5.results[0];
  assert.equal(r5.E.close.S1, 0);
  assert.ok(t(g5, 'C-17'));
});

test('年度別サマリーの消去差額（累計）＝ 53, 81, 82, 55, 0', () => {
  const s = buildSchedule(k001, pol);
  const yr = contractYearly(s, FY, currentPortion);
  assert.deepEqual(yr.map((r) => r.cumE), [53, 81, 82, 55, 0]);
  assert.deepEqual(yr.map((r) => r.plEffect), [53, 28, 1, -27, -55]);
});

test('非支配株主持分の按分（借手60%子会社）', () => {
  const g = generateAll(data, FY[1], pol);
  const r = g.results.find((x) => x.contract.id === 'K-002');
  const e = r.E.open.S2;
  const dt = r.DT.open.S2;
  assert.equal(r.NCI.open.S2, round((e - dt) * 0.4));
  const g2 = generateAll(data, FY[1], { ...pol, 'POL-01': 'none' });
  assert.ok(!g2.journals.some((j) => j.tpl === 'C-14' || j.tpl === 'C-01N'));
});

test('全サンプル契約・全会計方針の組合せ・年度/四半期で検算NGがない', () => {
  const periods = [...buildPeriods(ymToIndex('2027-04'), ymToIndex('2034-03'), 3), ...buildPeriods(ymToIndex('2027-04'), ymToIndex('2028-03'), 3, 'quarter')];
  const ids = ['POL-01', 'POL-02', 'POL-03', 'POL-04', 'POL-05', 'POL-06', 'POL-07', 'POL-10', 'POL-11'];
  function* combos(i, cur) {
    if (i === ids.length) { yield { ...cur }; return; }
    for (const o of POLICIES.find((p) => p.id === ids[i]).options) { cur[ids[i]] = o.value; yield* combos(i + 1, cur); }
  }
  let n = 0;
  for (const c of combos(0, defaultPolicies())) {
    for (const p of periods) {
      const g = generateAll(data, p, c);
      const ch = runChecks(data, p, c, g);
      const ng = ch.filter((x) => x.status === 'ng' && x.id !== 'CHK-10');
      assert.equal(ng.length, 0, `${JSON.stringify(c)} ${p.label} ${ng.map((x) => x.id + x.detail).join()}`);
      n++;
    }
  }
  assert.ok(n > 1000);
});

test('消去後のグループ内残高は0（精算表）', () => {
  for (const p of FY) {
    const g = generateAll(data, p, pol);
    const ws = worksheet(g, data.companies, pol, {}, p);
    for (const r of ws) if (MUST_BE_ZERO.includes(r.acc)) assert.equal(r.consol, 0, `${p.label} ${r.label}`);
  }
});

test('入力検証：不正な契約を検出', () => {
  const bad = { ...k001, termMonths: 61, frequencyMonths: 12, lessorCo: 'X' };
  const e = validateContract(bad, data.companies);
  assert.ok(e.some((x) => x.includes('整数倍')));
  assert.ok(e.some((x) => x.includes('会社マスタ')));
});

test('取込データの無害化：未知の項目は破棄、不正値は補正', () => {
  const raw = { companies: [{ code: 'P', name: '<script>', taxRate: 5, evil: 'x' }], contracts: [{ id: 'A', termMonths: 'abc', frequencyMonths: 7, lessee: { model: 'hack', rate: -1 }, __proto__: { polluted: true } }] };
  const { data: d } = sanitizeData(raw);
  assert.equal(d.companies[0].taxRate, 0.99);
  assert.equal(d.companies[0].evil, undefined);
  assert.equal(d.contracts[0].frequencyMonths, 1);
  assert.equal(d.contracts[0].lessee.model, 'jgaap');
  assert.equal(d.contracts[0].lessee.rate, 0);
  assert.equal({}.polluted, undefined);
  assert.throws(() => sanitizeData(null));
});

test('CSV数式インジェクション対策', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+cmd'), "'+cmd");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(-123), '-123');
  assert.equal(csvCell('普通の文字'), '普通の文字');
});

test('監査ログのハッシュ連鎖：改ざんを検知', () => {
  const log = [];
  appendLog(log, 'A', '1');
  appendLog(log, 'B', '2');
  assert.equal(verifyChain(log).ok, true);
  log[0].detail = '改ざん';
  assert.equal(verifyChain(log).ok, false);
});

test('会計方針：不正な保存値は既定値に戻る', () => {
  const p = sanitizePolicies({ 'POL-01': 'none', 'POL-02': 'evil' });
  assert.equal(p['POL-01'], 'none');
  assert.equal(p['POL-02'], 'reverse');
});

test('ASC842オペの当初負債＝年金現価（四半期300×16回、1%/四半期）を手計算と照合', () => {
  const c = data.contracts.find((x) => x.id === 'K-004');
  const s = buildSchedule(c, pol);
  const expected = Math.round(300 * (1 - Math.pow(1.01, -16)) / 0.01);
  assert.equal(s.meta.L0, expected);
});

test('中途解約：違約金は連結上相殺され、解約後の消去残高・税効果・非支配株主持分は0', () => {
  const p = buildPeriods(ymToIndex('2029-04'), ymToIndex('2030-03'), 3)[0];
  const g = generateAll(data, p, pol);
  const r = g.results.find((x) => x.contract.id === 'K-006');
  const c17 = g.journals.find((j) => j.contractId === 'K-006' && j.tpl === 'C-17');
  const n = net(c17);
  assert.equal(n.PENALTY_INC, 60);
  assert.equal(n.PENALTY_EXP, -60);
  assert.equal(r.E.close.S2, 0);
  assert.equal(r.DT.close.S2, 0);
  assert.equal(r.NCI.close.S2, 0);
});

test('税率変更の影響は当期の法人税等調整額、期首は前期末の税率', () => {
  const d = JSON.parse(JSON.stringify(data));
  d.companies.find((x) => x.code === 'S1').history = [{ fromYm: '2028-04', taxRate: 0.35, nciRatio: 0 }];
  const g2 = generateAll({ ...d, contracts: [k001] }, FY[1], pol);
  const t = (tpl) => net(g2.journals.find((j) => j.tpl === tpl));
  assert.deepEqual(t('C-01T'), { RE_OPEN: 16, DTA: -16 }); // 53 × 30%
  assert.deepEqual(t('C-13'), { TAX_ADJ: Math.round(81 * 0.35) - 16, DTA: -(Math.round(81 * 0.35) - 16) });
});

test('持分比率の変動は資本剰余金（資本取引）で処理', () => {
  const d = JSON.parse(JSON.stringify(data));
  d.companies.find((x) => x.code === 'S1').nciRatio = 0.4;
  d.companies.find((x) => x.code === 'S1').history = [{ fromYm: '2028-04', taxRate: 0.3, nciRatio: 0.2 }];
  const g2 = generateAll({ ...d, contracts: [k001] }, FY[1], pol);
  const c14 = net(g2.journals.find((j) => j.tpl === 'C-14'));
  // 期首：(53−16)×40%＝15、期末：(81−24)×20%＝11、当期損益分：((81−24)−(53−16))×20%＝4、資本剰余金：11−15−4＝△8
  assert.equal(c14.NCI_PL, 4);
  assert.equal(c14.CAP_SURPLUS, -8);
});

test('旧科目名＋流動区分ありの借手でも、連結後の流動・固定は0', () => {
  const d = JSON.parse(JSON.stringify(data));
  d.companies.find((x) => x.code === 'S1').legacyAccounts = true;
  for (const p of FY) {
    const g = generateAll(d, p, pol);
    const ws = worksheet(g, d.companies, pol, {}, p);
    for (const r of ws) if (MUST_BE_ZERO.includes(r.acc)) assert.equal(r.consol, 0, `${p.label} ${r.label}`);
  }
});

test('JSON取込：__proto__ を含むデータでプロトタイプ汚染が起きず、重複番号・不正コードは拒否', () => {
  const raw = JSON.parse('{"companies":[{"code":"P","name":"P","__proto__":{"polluted":1}}],"contracts":[],"__proto__":{"polluted2":1}}');
  sanitizeData(raw);
  assert.equal({}.polluted, undefined);
  assert.equal({}.polluted2, undefined);
  assert.throws(() => sanitizeData({ companies: [{ code: '__proto__' }], contracts: [] }));
  assert.throws(() => sanitizeData({ companies: [{ code: 'P' }], contracts: [{ id: 'A' }, { id: 'A' }] }));
});

test('土地（非償却）の貸手資産は減価償却費0、組替は取得原価のみ', () => {
  const c = { ...JSON.parse(JSON.stringify(k001)), id: 'L-1', assetClass: 'land', lessor: { assetId: 'LAND', assetCost: 9000, assetLifeMonths: 0, assetStart: null, ratio: 1, incClass: 'sales', depClass: 'cogs' } };
  assert.deepEqual(validateContract(c, data.companies), []);
  const g = generateAll({ ...data, contracts: [c] }, FY[0], pol);
  assert.deepEqual(net(g.journals.find((j) => j.tpl === 'C-11')), { RECLASS_ASSET: 9000, RENTAL_ASSET: -9000 });
  assert.equal(g.journals.find((j) => j.tpl === 'C-12'), undefined);
});
