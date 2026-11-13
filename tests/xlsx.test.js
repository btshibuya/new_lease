// 注記の収集用 Excel（.xlsx）の書出し・読込のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeXlsx, readXlsx, zipStore, unzip, crc32, STYLE } from '../app/src/engine/xlsx.js';
import { noteCollectionXlsx, importNoteCollectionXlsx, groupNoteAmounts, noteRows } from '../app/src/engine/notes.js';
import { generateAll } from '../app/src/engine/elimination.js';
import { defaultPolicies } from '../app/src/engine/policies.js';
import { sampleData } from '../app/src/engine/sample.js';
import { sanitizeData } from '../app/src/engine/data.js';
import { buildPeriods, ymToIndex } from '../app/src/engine/util.js';

const pol = defaultPolicies();
const d = sanitizeData(sampleData()).data;
const p = buildPeriods(ymToIndex('2027-04'), ymToIndex('2030-03'), 3, 'year')[0];
const g = groupNoteAmounts(generateAll(d, p, pol), p, pol, d.companies);
const td = new TextDecoder();

test('CRC32 と ZIP：既知の値・書いた ZIP を展開すると同じ内容', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const z = zipStore([{ name: 'xl/workbook.xml', data: '<a>あいう</a>' }, { name: 'xl/worksheets/sheet1.xml', data: '<b/>' }]);
  const m = await unzip(z);
  assert.equal(td.decode(m.get('xl/workbook.xml')), '<a>あいう</a>');
  assert.equal(td.decode(m.get('xl/worksheets/sheet1.xml')), '<b/>');
});

test('deflate で圧縮された ZIP（Excel が保存する形式）も展開できる', async () => {
  const data = new TextEncoder().encode('<x>'.repeat(200));
  const comp = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  // 無圧縮の ZIP を作り、本体を圧縮版に差し替える（方法 8・サイズを書き換える）
  const name = new TextEncoder().encode('xl/workbook.xml');
  const u16 = (v) => [v & 0xff, v >> 8], u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const crc = crc32(data);
  const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(crc), ...u32(comp.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
  const cd = [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(crc), ...u32(comp.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0)];
  const off = local.length + name.length + comp.length;
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(cd.length + name.length), ...u32(off), ...u16(0)];
  const zip = new Uint8Array([...local, ...name, ...comp, ...cd, ...name, ...end]);
  const m = await unzip(zip);
  assert.equal(td.decode(m.get('xl/workbook.xml')), '<x>'.repeat(200));
});

test('書いたブックを読むと、文字・数値・数式の位置が保たれる（記号・制御文字は無害化）', async () => {
  const x = writeXlsx([{ name: 'テスト<&>', rows: [[{ v: '見出し', s: STYLE.header }, { v: 12.5 }], null, [{ v: 'A&B<C>"' }, { f: 'B1*2' }, { v: '改行\nあり\u0001' }]] }]);
  const [sh] = await readXlsx(x);
  assert.equal(sh.name, 'テスト<&>');
  assert.deepEqual(sh.rows[0], ['見出し', '12.5']);
  assert.deepEqual(sh.rows[1], []);
  assert.equal(sh.rows[2][0], 'A&B<C>"');
  assert.equal(sh.rows[2][2], '改行\nあり');
});

test('収集用 Excel：シートは2枚、全項目の行があり、入力値を入れて読み込むと収集値になる', async () => {
  const cos = d.companies.filter((c) => ['S1', 'S2'].includes(c.code));
  const inputs = { S1: { 'L-VAR': { total: 30, group: 5, memo: '' } } };
  const bytes = noteCollectionXlsx(cos, p, g, inputs);
  const sheets = await readXlsx(bytes);
  assert.deepEqual(sheets.map((s) => s.name), ['注記の収集表', '記入方法・チェック']);
  const rows = sheets[0].rows;
  const h = rows.findIndex((r) => r.includes('項目キー'));
  const head = rows[h];
  const data = rows.slice(h + 1).filter((r) => r[head.indexOf('項目キー')]);
  assert.equal(data.length, noteRows().length * cos.length, '会社×注記項目の行');
  // 既存の収集値が入っている
  const lvar = data.find((r) => r[0] === 'S1' && r[head.indexOf('項目キー')] === 'L-VAR');
  assert.equal(lvar[head.indexOf('各社の注記額（記入）')], '30');
  // アプリ計算値（グループ内分）が収集表に載っている
  const liab = data.find((r) => r[0] === 'S1' && r[head.indexOf('項目キー')] === 'L-LIAB.nc');
  assert.equal(Number(liab[head.indexOf('グループ内リース分（アプリ計算値・参考）')]), g.get('L-LIAB.nc').rows.filter((x) => x.co === 'S1').reduce((a, x) => a + x.amt, 0));
  // 読み込むと収集値になる
  const r = await importNoteCollectionXlsx(bytes, d.companies, p);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.inputs, { S1: { 'L-VAR': { total: 30, group: 5, memo: '' } } });
});

test('収集用 Excel の読込の誤り：別の期間・存在しない会社は行番号つきで知らせ、Excel 以外は読めないと知らせる', async () => {
  const other = buildPeriods(ymToIndex('2027-04'), ymToIndex('2030-03'), 3, 'year')[1];
  const bytes = noteCollectionXlsx(d.companies.filter((c) => c.code === 'S1'), p, g, { S1: { 'L-VAR': { total: 1, group: null, memo: '' } } });
  const r = await importNoteCollectionXlsx(bytes, d.companies, other);
  assert.ok(r.errors.length > 0 && /注記の収集表.*行目.*決算期末/.test(r.errors[0]));
  const bad = await importNoteCollectionXlsx(new TextEncoder().encode('a,b,c'), d.companies, p);
  assert.ok(/ZIP|Excel/.test(bad.errors[0]));
});
