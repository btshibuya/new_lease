// ミューテーションテスト：エンジンに意図的な誤りを入れたとき、検算（runChecks）が必ず NG を出すことを確かめる。
// 検算が「自己一致」にとどまらず、独立した検証になっていることの継続的な確認。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'engine');

const MUTATIONS = [
  ['非支配株主持分の符号を逆にする', 'elimination.js', 'res.Nclose[co] = R((res.Eclose[co] - res.DTc[co]) * res.nC[co]);', 'res.Nclose[co] = -R((res.Eclose[co] - res.DTc[co]) * res.nC[co]);'],
  ['税効果に貸手の税率を使う', 'elimination.js', "res.tC[co] = taxOn ? rateAt(C, closeIdx, 'taxRate') : 0;", "res.tC[co] = taxOn ? rateAt(coMap[c.lessorCo], closeIdx, 'taxRate') : 0;"],
  ['税効果を期間損益で計算する', 'elimination.js', 'res.DTc[co] = R(res.Eclose[co] * res.tC[co]);', 'res.DTc[co] = R((res.Eclose[co] - res.Eopen[co]) * res.tC[co]);'],
  ['流動部分を13か月で判定する', 'schedule.js', 'sg.pay.month <= endIdx + 12);', 'sg.pay.month <= endIdx + 13);'],
  ['償却月数を1か月短くする', 'schedule.js', 'const depMonths = L.depMonths || s + N - measStart;', 'const depMonths = L.depMonths || s + N - measStart - 1;'],
  ['C-11で按分比率を無視する', 'elimination.js', 'const cost = R(r.assetCost * ratio);', 'const cost = R(r.assetCost);'],
  ['開始仕訳の税効果を0にする', 'elimination.js', 'res.DTo[co] = R(res.Eopen[co] * res.tO[co]);', 'res.DTo[co] = 0;'],
  ['貸手の定額収益の月数を誤る', 'schedule.js', 'const incCum = R((totalPayments * (m - s + 1)) / N);', 'const incCum = R((totalPayments * (m - s + 1)) / (N + 1));'],
  ['利息の月按分を1か月ずらす', 'schedule.js', 'const m = sg.ta + k - 1;', 'const m = sg.ta + k;'],
  ['C-12で按分比率を無視する', 'elimination.js', 'const dep = R(act.reduce((a, x) => a + (x.lessor.assetDep || 0), 0) * ratio);', 'const dep = R(act.reduce((a, x) => a + (x.lessor.assetDep || 0), 0));'],
  ['持分変動を資本剰余金に分けない', 'elimination.js', 'const capPart = dN - plPart;', 'const capPart = 0;'],
  ['解約益の取消の符号を誤る', 'elimination.js', "if (t.gain) lines.push(ln('TERM_GAIN', lesseeCo, t.gain, meta,", "if (t.gain) lines.push(ln('TERM_GAIN', lesseeCo, -t.gain, meta,"],
  ['違約金を消去しない', 'elimination.js', "    if (le.penalty) {\n      lines.push(ln('PENALTY_INC'", "    if (false) {\n      lines.push(ln('PENALTY_INC'"],
  ['前払の初回支払を負債から控除しない', 'schedule.js', 'le.L_end = (commence ? L0 : prevL) + mi - le.pay;', 'le.L_end = (commence ? L0 : prevL) + mi - (commence ? 0 : le.pay);'],
];

async function ngIds(dir) {
  const imp = (f) => import(pathToFileURL(join(dir, f)).href + `?v=${Math.random()}`);
  const { sampleData } = await imp('sample.js');
  const { generateAll } = await imp('elimination.js');
  const { runChecks } = await imp('checks.js');
  const { defaultPolicies } = await imp('policies.js');
  const { buildPeriods, ymToIndex } = await imp('util.js');
  const d = sampleData();
  // 旧科目＋流動区分あり・税率/持分比率の変更がある会社も加えて検査範囲を広げる
  d.companies.push({ code: 'S4', name: 'S4', fyeMonth: 3, taxRate: 0.3, nciRatio: 0.3, taxEffect: true, legacyAccounts: true, splitsCurrent: true, history: [{ fromYm: '2029-04', taxRate: 0.32, nciRatio: 0.2 }] });
  d.contracts.push({ ...JSON.parse(JSON.stringify(d.contracts[0])), id: 'K-901', lesseeCo: 'S4', actuals: {}, lessor: { ...d.contracts[0].lessor, assetId: 'A-09' } });
  const periods = [...buildPeriods(ymToIndex('2027-04'), ymToIndex('2034-03'), 3), ...buildPeriods(ymToIndex('2027-04'), ymToIndex('2029-03'), 3, 'quarter')];
  const hit = new Set();
  for (const pol of [defaultPolicies(), { ...defaultPolicies(), 'POL-07': 'capitalize', 'POL-03': 'balance' }]) {
    for (const p of periods) {
      try {
        for (const c of runChecks(d, p, pol, generateAll(d, p, pol))) if (c.status === 'ng' && c.id !== 'CHK-10') hit.add(c.id);
      } catch (e) { hit.add(`例外:${e.message}`); }
    }
  }
  return hit;
}

test('誤りのないエンジンでは検算 NG が出ない（基準線）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nl-base-'));
  try {
    cpSync(SRC, dir, { recursive: true });
    const hit = await ngIds(dir);
    assert.equal(hit.size, 0, [...hit].join(','));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [name, file, from, to] of MUTATIONS) {
  test(`意図的な誤り「${name}」を検算が検出する`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-mut-'));
    try {
      cpSync(SRC, dir, { recursive: true });
      const p = join(dir, file);
      const src = readFileSync(p, 'utf8');
      assert.ok(src.includes(from), `置換対象がエンジンにありません：${from}`);
      writeFileSync(p, src.replace(from, to));
      const hit = await ngIds(dir);
      assert.ok(hit.size > 0, '検算で検出されませんでした');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
