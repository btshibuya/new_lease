// 契約の一括取込（CSV）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleData } from '../app/src/engine/sample.js';
import { sanitizeContract } from '../app/src/engine/data.js';
import { CONTRACT_COLUMNS, contractTemplateCsv, contractsToCsv, parseCsv, importContractsCsv } from '../app/src/engine/contractCsv.js';

const data = sampleData();

test('CSV：書き出した契約を取り込み直すと同じ内容になる（条件変更・実績は既存から引き継ぐ）', () => {
  const csv = contractsToCsv(data.contracts);
  const r = importContractsCsv(csv, data);
  assert.deepEqual(r.errors, []);
  assert.equal(r.contracts.length, data.contracts.length);
  assert.deepEqual(r.added, []);
  for (const c of r.contracts) assert.deepEqual(c, sanitizeContract(data.contracts.find((x) => x.id === c.id)), c.id);
});

test('CSV：貸手と借手は別の列で、テンプレートの説明行は取り込まない', () => {
  const head = CONTRACT_COLUMNS.map((c) => c.label);
  assert.ok(head.includes('貸手会社コード') && head.includes('借手会社コード'));
  assert.ok(!head.some((h) => /貸手.*借手|借手.*貸手/.test(h)), '貸手と借手を結合した列がない');
  const tpl = contractTemplateCsv([{ ...data.contracts[0], id: 'K-901' }]);
  const rows = parseCsv(tpl);
  assert.equal(rows.length, 3);
  assert.ok(rows[1][0].startsWith('#'));
  const r = importContractsCsv(tpl, data);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.added, ['K-901']);
});

test('CSV：表記ゆれ（年月の書き方・全角数字・桁区切り・％記号・表示名）を受け付ける', () => {
  const head = CONTRACT_COLUMNS.map((c) => c.label);
  const row = Object.fromEntries(head.map((h) => [h, '']));
  Object.assign(row, { 契約番号: 'K-950', 契約名: 'テスト "倉庫", 1F', 貸手会社コード: 'P', 借手会社コード: 'S1', 資産区分: '建物', リース開始年月: '2027/4/1', 'リース期間（月数）': '６０', '支払間隔（月数）': '12', 支払時期: '後払', '1回あたりリース料': '1,000', '借手：会計モデル': '日本基準', '借手：割引率（年％）': '3%', '段階賃料（支払回:金額）': '3:1100', '貸手：按分比率（％）': '' });
  const csv = [head, head.map((h) => row[h])].map((r) => r.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
  const r = importContractsCsv(csv, data);
  assert.deepEqual(r.errors, []);
  const c = r.contracts[0];
  assert.equal(c.name, 'テスト "倉庫", 1F');
  assert.equal(c.commencement, '2027-04');
  assert.equal(c.termMonths, 60);
  assert.equal(c.payment, 1000);
  assert.equal(c.lessee.rate, 0.03);
  assert.equal(c.lessor.ratio, 1);
  assert.deepEqual(c.steps, [{ fromPayment: 3, amount: 1100 }]);
});

test('CSV：誤りがある行は行番号つきで報告する', () => {
  const head = CONTRACT_COLUMNS.map((c) => c.label);
  const base = head.map((h) => ({ 契約番号: 'K-960', 貸手会社コード: 'P', 借手会社コード: 'ZZ', リース開始年月: '2027-13', 'リース期間（月数）': '60', '支払間隔（月数）': '12', '1回あたりリース料': 'abc' }[h] ?? ''));
  const dup = head.map((h) => ({ 契約番号: 'K-960', 貸手会社コード: 'P', 借手会社コード: 'S1', リース開始年月: '2027-04', 'リース期間（月数）': '60', '支払間隔（月数）': '12', '1回あたりリース料': '100' }[h] ?? ''));
  const r = importContractsCsv([head, base, dup].map((x) => x.join(',')).join('\n'), data);
  assert.equal(r.contracts.length, 0);
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].row, 2);
  const m = r.errors[0].messages.join(' / ');
  assert.match(m, /借手会社コード「ZZ」/);
  assert.match(m, /リース開始年月「2027-13」/);
  assert.match(m, /1回あたりリース料「abc」/);
  assert.match(r.errors[1].messages.join(' '), /ファイル内で重複/);
});

test('CSV：見出しに必須の列がなければ取り込まない', () => {
  const r = importContractsCsv('契約番号,契約名\nK-1,x', data);
  assert.equal(r.contracts.length, 0);
  assert.match(r.errors[0].messages[0], /必須の列がありません/);
});

// ── 注記（新リース会計基準）のグループ内リース分：別の計算経路との一致 ──
import { generateAll } from '../app/src/engine/elimination.js';
import { defaultPolicies } from '../app/src/engine/policies.js';
import { buildPeriods, ymToIndex } from '../app/src/engine/util.js';
import { cashFlowEliminations, worksheet, maturity } from '../app/src/engine/reports.js';
import { groupNoteAmounts, noteRows, noteCollectionCsv, importNoteCollection, consolidatedNotes, BUCKETS, sanitizeNoteInputs } from '../app/src/engine/notes.js';
import { sanitizeData } from '../app/src/engine/data.js';

const pol = defaultPolicies();
const FY = buildPeriods(ymToIndex('2027-04'), ymToIndex('2033-03'), 3, 'year');

test('注記：キャッシュ・アウトフロー＝連結CFの消去額、使用権資産の帳簿価額＝精算表、満期分析＝既存の計算、受取予定＝スケジュール', () => {
  for (const gran of ['year', 'quarter']) {
    for (const p of buildPeriods(ymToIndex('2027-04'), ymToIndex('2033-03'), 3, gran).slice(0, gran === 'year' ? 6 : 8)) {
      const gen = generateAll(data, p, pol);
      const g = groupNoteAmounts(gen, p, pol, data.companies);
      const sum = (prefix) => [...g.entries()].filter(([k]) => k === prefix || k.startsWith(`${prefix}.`)).reduce((a, [, v]) => a + v.amount, 0);
      const cf = cashFlowEliminations(gen, pol, p);
      assert.equal(sum('L-CASH'), cf.totals.receipts + cf.totals.penalty, `${p.label} キャッシュ・アウトフロー`);
      const ws = worksheet(gen, data.companies, pol, {}, p);
      const rou = ws.filter((r) => ['ROU_COST', 'ROU_ACC', 'LEGACY_ASSET', 'LEGACY_ACC'].includes(r.acc)).reduce((a, r) => a + r.lessee, 0);
      assert.equal(sum('L-NBV'), rou, `${p.label} 使用権資産の帳簿価額`);
      const m = maturity(gen, p);
      assert.deepEqual(BUCKETS.map((b) => g.get(`X-LL.${b.key}`).amount), m.map((x) => x.amount));
      assert.deepEqual(BUCKETS.map((b) => g.get(`X-LLP.${b.key}`).amount), m.map((x) => x.principal));
      let fut = 0;
      for (const r of gen.results) { const e = r.sched.byIndex(p.end); if (e && !e.lessee.term) fut += r.sched.months.filter((x) => x.m > p.end).reduce((a, x) => a + (x.lessor.cash || 0), 0); }
      assert.equal(sum('R-MAT') + sum('R-FMAT'), fut, `${p.label} 将来の受取リース料（オペレーティング＋ファイナンス）`);
      for (const [k, v] of g) assert.equal(v.rows.reduce((a, x) => a + x.amt, 0), v.amount, k);
    }
  }
});

test('注記：短期リースに係る費用は「短期リース」の契約だけ（少額リースは含めない）', () => {
  const d2 = structuredClone(data);
  const k3 = d2.contracts.find((c) => c.id === 'K-003');
  assert.equal(k3.lessee.model, 'offbalance');
  const p = FY[0];
  const a = groupNoteAmounts(generateAll(d2, p, pol), p, pol, d2.companies).get('L-SHORT');
  const k3amt = a.rows.filter((x) => x.contract === 'K-003').reduce((s, x) => s + x.amt, 0);
  assert.ok(k3amt > 0);
  // 少額リース（K-014・K-025）は含まない
  assert.ok(!a.rows.some((x) => ['K-014', 'K-025'].includes(x.contract)));
  k3.lessee.offKind = 'low';
  const b = groupNoteAmounts(generateAll(d2, p, pol), p, pol, d2.companies).get('L-SHORT');
  assert.ok(!b.rows.some((x) => x.contract === 'K-003'), '少額リースに変えた契約は含めない');
  assert.equal(b.amount, a.amount - k3amt);
});

test('注記：収集表を書き出し、記入して読み込むと、連結の注記額＝各社の合計−グループ内リース分', () => {
  const p = FY[0];
  const g = groupNoteAmounts(generateAll(data, p, pol), p, pol, data.companies);
  const csv = noteCollectionCsv(data.companies, p, g);
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1 + data.companies.length * noteRows().length);
  const nbvRow = rows.find((r) => r[4] === 'L-NBV.building');
  assert.ok(nbvRow[10].length > 20, 'どのような情報かの説明がある');
  assert.match(nbvRow[6], /適用指針第99項〜第101項/);
  assert.match(rows.find((r) => r[4] === 'L-LIAB.cur')[6], /会計基準第49項〜第51項/);
  const H = rows[0];
  const col = (l) => H.indexOf(l);
  // P の使用権資産（建物）の注記額 100,000、S1 の変動リース料 500（うちグループ 120）を記入
  for (const r of rows.slice(1)) {
    if (r[col('会社コード')] === 'P' && r[col('項目キー')] === 'L-NBV.building') r[col('各社の注記額（記入）')] = '100,000';
    if (r[col('会社コード')] === 'S1' && r[col('項目キー')] === 'L-VAR') { r[col('各社の注記額（記入）')] = '500'; r[col('うちグループ会社とのリース分（記入）')] = '120'; }
  }
  const text = rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
  const imp = importNoteCollection(text, data.companies, p);
  assert.deepEqual(imp.errors, []);
  assert.equal(imp.count, 2);
  const cn = consolidatedNotes(g, imp.inputs);
  const nbv = cn.find((r) => r.key === 'L-NBV.building');
  assert.equal(nbv.total, 100000);
  assert.equal(nbv.consolidated, 100000 - g.get('L-NBV.building').amount);
  const v = cn.find((r) => r.key === 'L-VAR');
  assert.equal(v.group, 120);
  assert.equal(v.consolidated, 380);
  assert.equal(cn.find((r) => r.key === 'L-CASH').total, null, '未収集の行は空欄');
  // 保存・読込（無害化）で失われない
  const saved = sanitizeData({ ...data, noteInputs: { '2028-03': imp.inputs } }).data.noteInputs;
  assert.deepEqual(saved, sanitizeNoteInputs({ '2028-03': imp.inputs }));
  assert.equal(saved['2028-03'].S1['L-VAR'].group, 120);
});

test('注記：収集表の誤り（別の期間・未登録の会社・数値でない値）を行番号つきで報告する', () => {
  const p = FY[0];
  const H = parseCsv(noteCollectionCsv(data.companies.slice(0, 1), p, groupNoteAmounts(generateAll(data, p, pol), p, pol, data.companies)))[0];
  const row = (o) => H.map((h) => o[h] ?? '').join(',');
  const text = [H.join(','), row({ 決算期末: '2029-03', 会社コード: 'P', 項目キー: 'L-VAR', '各社の注記額（記入）': '1' }), row({ 決算期末: '2028-03', 会社コード: 'ZZ', 項目キー: 'L-VAR', '各社の注記額（記入）': '1' }), row({ 決算期末: '2028-03', 会社コード: 'P', 項目キー: 'L-VAR', '各社の注記額（記入）': 'abc' })].join('\n');
  const r = importNoteCollection(text, data.companies, p);
  assert.equal(r.errors.length, 3);
  assert.match(r.errors[0], /^2行目：決算期末/);
  assert.match(r.errors[1], /^3行目：会社コード「ZZ」/);
  assert.match(r.errors[2], /^4行目/);
});

test('注記：リース負債が含まれる科目と金額（流動＋固定）＝精算表の借手の個別のリース負債（流動区分なしの会社は全額を固定）', () => {
  const noSplit = data.companies.filter((c) => c.splitsCurrent === false).map((c) => c.code);
  assert.ok(noSplit.length && data.contracts.some((c) => noSplit.includes(c.lesseeCo)), 'サンプルに流動区分なしの借手がある');
  for (const p of FY.slice(0, 4)) {
    const gen = generateAll(data, p, pol);
    const g = groupNoteAmounts(gen, p, pol, data.companies);
    const ws = worksheet(gen, data.companies, pol, {}, p);
    // 各社の個別の注記額と同じ基準（借手の個別の列）。連結の組替（流動区分なしの会社の流動部分）は含めない
    const L = -ws.filter((r) => ['LL_C', 'LL_NC', 'LEGACY_LIAB', 'LEGACY_LIAB_C'].includes(r.acc)).reduce((a, r) => a + r.lessee, 0);
    assert.equal(g.get('L-LIAB.cur').amount + g.get('L-LIAB.nc').amount, L, `${p.label} リース負債`);
    const cur = -ws.filter((r) => ['LL_C', 'LEGACY_LIAB_C'].includes(r.acc)).reduce((a, r) => a + r.lessee, 0);
    assert.equal(g.get('L-LIAB.cur').amount, cur, `${p.label} うち流動`);
    assert.ok(!g.get('L-LIAB.cur').rows.some((x) => noSplit.includes(x.co)), `${p.label} 流動区分なしの会社は流動に含めない`);
  }
});

test('連結精算表：会社で抽出した表を全社分（連結の組替を含む）足すと、全社の表と一致し、会社ごとにもグループ内の科目は連結後0', () => {
  for (const p of FY.slice(0, 3)) {
    const gen = generateAll(data, p, pol);
    const all = worksheet(gen, data.companies, pol, {}, p);
    const sum = new Map();
    for (const co of [...data.companies.map((c) => c.code), 'CONSOL']) {
      for (const r of worksheet(gen, data.companies, pol, {}, p, { company: co })) {
        const s = sum.get(r.label) || { lessee: 0, lessor: 0, ind: 0, con: 0, consol: 0 };
        for (const k of Object.keys(s)) s[k] += r[k];
        sum.set(r.label, s);
        if (['ROU_COST', 'ROU_ACC', 'LL_C', 'LL_NC', 'LEASE_INC', 'INT', 'DEP_ROU'].includes(r.acc)) assert.equal(r.consol, 0, `${p.label} ${co} ${r.label}`);
      }
    }
    for (const r of all) for (const k of ['lessee', 'lessor', 'ind', 'con', 'consol']) assert.equal(sum.get(r.label)?.[k] || 0, r[k], `${p.label} ${r.label} ${k}`);
  }
});
