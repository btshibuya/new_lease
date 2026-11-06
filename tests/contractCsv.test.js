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
import { disclosures, cashFlowEliminations, worksheet, maturity } from '../app/src/engine/reports.js';

test('注記：キャッシュ・アウトフロー＝連結CFの消去額、使用権資産の帳簿価額＝精算表、満期分析＝既存の計算', () => {
  const pol = defaultPolicies();
  for (const gran of ['year', 'quarter']) {
    for (const p of buildPeriods(ymToIndex('2027-04'), ymToIndex('2033-03'), 3, gran).slice(0, gran === 'year' ? 6 : 8)) {
      const gen = generateAll(data, p, pol);
      const d = disclosures(gen, p, pol);
      const get = (id) => d.items.find((x) => x.id === id).amount;
      const cf = cashFlowEliminations(gen, pol, p);
      assert.equal(get('N-L6'), cf.totals.receipts + cf.totals.penalty, `${p.label} キャッシュ・アウトフロー`);
      const ws = worksheet(gen, data.companies, pol, {}, p);
      const rou = ws.filter((r) => ['ROU_COST', 'ROU_ACC', 'LEGACY_ASSET', 'LEGACY_ACC'].includes(r.acc)).reduce((a, r) => a + r.lessee, 0);
      assert.equal(get('N-L1'), rou, `${p.label} 使用権資産の帳簿価額`);
      const m = maturity(gen, p);
      assert.deepEqual(d.maturity.map((x) => x.lesseeAmount), m.map((x) => x.amount));
      // 貸手の将来の受取リース料：契約のスケジュールから直接合計した額と一致
      let fut = 0;
      for (const r of gen.results) { const e = r.sched.byIndex(p.end); if (e && !e.lessee.term) fut += r.sched.months.filter((x) => x.m > p.end).reduce((a, x) => a + (x.lessor.cash || 0), 0); }
      assert.equal(d.maturity.reduce((a, x) => a + x.lessorReceipts, 0), fut, `${p.label} 将来の受取リース料`);
      // 原資産の表示科目ごとの内訳の合計は総額と一致
      for (const it of d.items) assert.equal(it.rows.reduce((a, x) => a + x.amt, 0), it.amount);
    }
  }
});
