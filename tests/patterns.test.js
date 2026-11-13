// サンプルの物件が入力パターンを網羅していること、少額の契約でも利息の端数処理で負債が負にならないことのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleData } from '../app/src/engine/sample.js';
import { sanitizeData } from '../app/src/engine/data.js';
import { buildSchedule } from '../app/src/engine/schedule.js';
import { defaultPolicies } from '../app/src/engine/policies.js';

const d = sanitizeData(sampleData()).data;

test('サンプルの物件が入力パターンを網羅している', () => {
  const C = d.contracts, CO = d.companies;
  const has = (label, f) => assert.ok(C.some(f), `契約のパターンがない：${label}`);
  const hasCo = (label, f) => assert.ok(CO.some(f), `会社のパターンがない：${label}`);
  for (const m of ['jgaap', 'asc842ol', 'offbalance']) has(`会計モデル ${m}`, (c) => c.lessee.model === m);
  for (const k of ['short', 'low']) has(`簡便法 ${k}`, (c) => c.lessee.model === 'offbalance' && c.lessee.offKind === k);
  for (const f of [1, 3, 6, 12]) for (const t of ['advance', 'arrears']) has(`${f}か月ごと・${t}`, (c) => c.frequencyMonths === f && c.timing === t);
  has('段階賃料', (c) => c.steps.length > 0);
  for (const t of ['advance', 'arrears']) has(`フリーレント（${t}）`, (c) => c.freePayments > 0 && c.timing === t);
  has('条件変更：延長', (c) => c.modifications.some((m) => m.termMonths && m.termMonths > c.termMonths));
  has('条件変更：範囲縮小（短縮）', (c) => c.modifications.some((m) => m.termMonths && m.termMonths < c.termMonths));
  has('条件変更：複数回', (c) => c.modifications.length >= 2);
  has('条件変更：ASC842', (c) => c.lessee.model === 'asc842ol' && c.modifications.length > 0);
  has('条件変更：簡便法', (c) => c.lessee.model === 'offbalance' && c.modifications.length > 0);
  has('中途解約（違約金あり）', (c) => c.terminationYm && c.terminationPenalty > 0);
  has('中途解約（違約金なし）', (c) => c.terminationYm && !c.terminationPenalty);
  has('中途解約：ASC842', (c) => c.terminationYm && c.lessee.model === 'asc842ol');
  has('中途解約：短期リース', (c) => c.terminationYm && c.lessee.model === 'offbalance');
  has('初期直接費用', (c) => c.lessee.idc > 0);
  has('当初リース負債の取込値', (c) => c.lessee.liabilityOverride !== null);
  has('償却月数の指定', (c) => c.lessee.depMonths !== null);
  has('法人税法上のリース取引', (c) => c.lessee.taxLease);
  for (const r of ['eq_liability', 'retrospective']) has(`適用前の契約：${r}`, (c) => c.commencement < '2027-04' && c.lessee.rouTransition === r);
  has('適用時の割引率が契約時と異なる', (c) => c.lessee.transitionRate !== null && c.lessee.transitionRate !== c.lessee.rate);
  has('適用開始前に終了した契約', (c) => c.commencement < '2026-01' && c.termMonths <= 24);
  has('1か月の契約', (c) => c.termMonths === 1);
  has('製造部門', (c) => c.lessee.dept === 'mfg');
  for (const a of ['building', 'machine', 'vehicle', 'tool', 'land']) has(`資産区分 ${a}`, (c) => c.assetClass === a);
  has('貸手資産の按分比率が1未満', (c) => c.lessor.ratio < 1);
  has('同じ貸手資産を複数契約で按分', (c) => c.lessor.assetId && C.filter((x) => x.lessor.assetId === c.lessor.assetId).length > 1);
  has('貸手資産の取得原価なし', (c) => !c.lessor.assetCost);
  has('貸手資産が償却済み', (c) => c.lessor.assetLifeMonths > 0 && c.lessor.assetStart && c.lessor.assetStart < '2000-01');
  has('貸手のリース期間が短い', (c) => c.lessor.termMonths !== null);
  has('営業外の収益・費用', (c) => c.lessor.incClass === 'nonop' && c.lessor.depClass === 'nonop');
  has('実績との突合（年度末・四半期末）', (c) => Object.keys(c.actuals).length >= 2);
  has('支払額の手修正', (c) => c.paymentOverrides.length > 0);
  has('貸手：所有権移転外ファイナンス・リース（リース投資資産）', (c) => c.lessor.model === 'finance');
  has('子会社→親会社', (c) => CO.find((x) => x.code === c.lesseeCo)?.isParent);
  has('子会社どうし', (c) => !CO.find((x) => x.code === c.lesseeCo)?.isParent && !CO.find((x) => x.code === c.lessorCo)?.isParent);
  hasCo('旧科目名', (x) => x.legacyAccounts);
  hasCo('流動区分なし', (x) => x.splitsCurrent === false);
  hasCo('個別税効果なし', (x) => x.taxEffect === false);
  hasCo('繰延税金資産の計上割合', (x) => x.dtaRatio < 1);
  hasCo('税率の変更（履歴）', (x) => (x.history || []).some((h) => h.taxRate !== x.taxRate));
  for (const m of ['cumulative', 'retrospective', 'applied']) hasCo(`適用初年度 ${m}`, (x) => x.adoption.method === m);
  hasCo('3月決算以外', (x) => x.fyeMonth !== 3);
  for (const dm of ['nearest_month_end', 'nearest_quarter_end', 'nearest_fy_end', 'month']) hasCo(`みなし日 ${dm}`, (x) => (x.ownership || []).some((o) => o.deemed === dm));
  for (const k of ['acquire', 'add', 'sell']) hasCo(`異動 ${k}`, (x) => (x.ownership || []).some((o) => o.kind === k));
  assert.ok(C.length >= 51);
});

test('利息は累計で端数処理する：少額の契約でもリース負債が途中で負にならず、最終月にまとめて利息を計上しない', () => {
  for (const pv of ['nominal', 'effective']) {
    const pol = { ...defaultPolicies(), 'POL-10': pv };
    for (const c of d.contracts) {
      const s = buildSchedule(c, pol, { lesseeCompany: d.companies.find((x) => x.code === c.lesseeCo) });
      for (const x of s.months) assert.ok((x.lessee.L_end || 0) >= 0, `${pv} ${c.id} ${x.m} 負債 ${x.lessee.L_end}`);
    }
  }
  // 月5千円・年2％の駐車場（K-042）：最終月の利息は通常の月と同程度（変更前は15を最終月に計上していた）
  const k42 = buildSchedule(d.contracts.find((c) => c.id === 'K-042'), defaultPolicies(), { lesseeCompany: d.companies.find((x) => x.code === 'S6') });
  assert.ok(Math.abs(k42.months[k42.months.length - 1].lessee.int) <= 1);
});

import { generateAll } from '../app/src/engine/elimination.js';
import { worksheet, eFromSchedule } from '../app/src/engine/reports.js';
import { groupNoteAmounts } from '../app/src/engine/notes.js';
import { buildPeriods, ymToIndex } from '../app/src/engine/util.js';

test('貸手の所有権移転外ファイナンス・リース（K-052）：リース投資資産と受取利息は連結後0、物件は連結上の自己所有資産として償却を続け、リース期間の終了で消去差額は0', () => {
  for (const p5 of ['by_lessee_dept', 'as_is']) for (const p4 of ['reclass', 'none']) {
    const pol = { ...defaultPolicies(), 'POL-05': p5, 'POL-04': p4 };
    const c = d.contracts.find((x) => x.id === 'K-052');
    const s = buildSchedule(c, pol, { lesseeCompany: d.companies.find((x) => x.code === c.lesseeCo) });
    // 当初額＝リース開始時の帳簿価額、利息の合計＝リース料総額＋見積残存価額−当初額
    assert.equal(s.meta.flNI0, 12000 - Math.round((12000 * (ymToIndex('2027-09') - ymToIndex('2005-04') + 1)) / 480));
    const sumInc = s.months.reduce((a, x) => a + x.lessor.inc, 0), sumCash = s.months.reduce((a, x) => a + x.lessor.cash, 0);
    assert.equal(sumInc, sumCash + s.meta.flResidual - s.meta.flNI0);
    assert.ok(s.months.every((x) => (x.lessor.NI_end || 0) >= 0));
    assert.deepEqual(eFromSchedule(s, s.meta.lastIdx, pol), { S1: 0, P: 0 });
    for (const p of buildPeriods(ymToIndex('2027-04'), ymToIndex('2038-03'), 3, 'year')) {
      const g = generateAll(d, p, pol);
      const ws = worksheet(g, d.companies, pol, {}, p);
      for (const acc of ['LEASE_INV', 'LEASE_INT_INC']) assert.equal(ws.filter((r) => r.acc === acc).reduce((a, r) => a + r.consol, 0), 0, `${p5} ${p4} ${p.label} ${acc}`);
      // 連結上の減価償却費（C-21）＝当期の物件の償却額（リース期間中）
      const dep = g.journals.filter((j) => j.contractId === 'K-052' && j.tpl === 'C-21').flatMap((j) => j.lines).filter((l) => ['DEP_RECLASS', 'RENTAL_DEP'].includes(l.acc)).reduce((a, l) => a + l.amt, 0);
      const expDep = s.months.filter((x) => x.m >= p.start && x.m <= p.end && x.m >= ymToIndex(c.commencement)).reduce((a, x) => a + x.lessor.assetDep, 0);
      assert.equal(dep, expDep, `${p5} ${p4} ${p.label} 連結上の減価償却費`);
      // 注記：リース投資資産の内訳の合計＝期末のリース投資資産
      const n = groupNoteAmounts(g, p, pol, d.companies);
      const inv = ['pay', 'res', 'unearned'].reduce((a, k) => a + n.get(`R-INV.${k}`).rows.filter((x) => x.contract === 'K-052').reduce((b, x) => b + x.amt, 0), 0);
      const end = s.byIndex(Math.min(p.end, s.meta.lastIdx));
      assert.equal(inv, p.end >= ymToIndex(c.commencement) && p.end < s.meta.lastIdx ? end.lessor.NI_end : 0, `${p.label} リース投資資産の内訳`);
    }
  }
});

test('貸手のファイナンス・リースの入力制限：条件変更・中途解約・按分比率100％未満・借手がASC842 は入力エラー', async () => {
  const { validateContract } = await import('../app/src/engine/schedule.js');
  const base = d.contracts.find((x) => x.id === 'K-052');
  const errs = (o) => validateContract({ ...structuredClone(base), ...o }, d.companies);
  assert.deepEqual(errs({}), []);
  assert.ok(errs({ modifications: [{ ym: '2029-04', payment: 50, termMonths: null, rate: null }] }).some((e) => /条件変更/.test(e)));
  assert.ok(errs({ terminationYm: '2030-03' }).some((e) => /中途解約/.test(e)));
  assert.ok(errs({ lessor: { ...base.lessor, ratio: 0.5 } }).some((e) => /按分比率/.test(e)));
  assert.ok(errs({ lessee: { ...base.lessee, model: 'asc842ol' } }).some((e) => /借手の会計モデル/.test(e)));
});

test('注記の収集値のテストデータ：全社・全項目が収集済み（文章の項目は備考）で、連結の注記額＝各社の注記額の合計−グループ内分', async () => {
  const { sampleNoteInputs } = await import('../app/src/engine/sampleNotes.js');
  const { consolidatedNotes, notePeriodKey } = await import('../app/src/engine/notes.js');
  const pol = defaultPolicies();
  const inputs = sampleNoteInputs(d, pol);
  assert.deepEqual(Object.keys(inputs), ['2028-03', '2029-03', '2030-03']);
  const p = buildPeriods(ymToIndex('2027-04'), ymToIndex('2030-03'), 3, 'year')[0];
  const g = groupNoteAmounts(generateAll(d, p, pol), p, pol, d.companies);
  const rows = consolidatedNotes(g, inputs[notePeriodKey(p)]);
  for (const r of rows) {
    if (r.item.kind === 'text') { assert.equal(r.memos.length, d.companies.length, r.key); continue; }
    assert.notEqual(r.total, null, `${r.key} が未収集`);
    assert.equal(r.consolidated, r.total - r.group, r.key);
  }
  // 同じデータからは同じテストデータになる（乱数を使わない）
  assert.deepEqual(sampleNoteInputs(d, pol), inputs);
});
