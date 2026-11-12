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
  ['新しい持分比率をみなし日の翌月でなく当月から使う', 'accounts.js', 'return { rec: r, deemedIdx: dm, fromIdx: dm + 1,', 'return { rec: r, deemedIdx: dm, fromIdx: dm,'],
  ['みなし日が等距離のとき後の日にする', 'accounts.js', 'return day - monthEndDay(prev) <= monthEndDay(next) - day ? prev : next;', 'return day - monthEndDay(prev) < monthEndDay(next) - day ? prev : next;'],
  ['持分比率の推移を無視して基準の比率を使う', 'accounts.js', "if (key === 'nciRatio' && co.ownership && co.ownership.length) {", "if (false) {"],
  ['四半期末みなしで子会社の決算月を無視する', 'accounts.js', 'const fy0 = (fyeMonth - 1) % 12;', 'const fy0 = 0;'],
  ['非支配株主持分の符号を逆にする', 'elimination.js', "return { N: R(rateAt(L, idx, 'nciRatio') * baseAt(idx)), cap };", "return { N: -R(rateAt(L, idx, 'nciRatio') * baseAt(idx)), cap };"],
  ['税効果に貸手の税率を使う', 'elimination.js', 'res.DTc[co] = taxOf(C, res.Eclose[co], closeIdx, pol, R);', 'res.DTc[co] = taxOf(coMap[c.lessorCo], res.Eclose[co], closeIdx, pol, R);'],
  ['税効果を期間損益で計算する', 'elimination.js', 'res.DTc[co] = taxOf(C, res.Eclose[co], closeIdx, pol, R);', 'res.DTc[co] = taxOf(C, res.Eclose[co] - res.Eopen[co], closeIdx, pol, R);'],
  ['流動部分を13か月で判定する', 'schedule.js', 'sg.pay.month <= endIdx + 12);', 'sg.pay.month <= endIdx + 13);'],
  ['償却月数を1か月短くする', 'schedule.js', 'months: L.depMonths || ph0.end - measStart + 1 };', 'months: L.depMonths || ph0.end - measStart };'],
  ['C-11で按分比率を無視する', 'elimination.js', 'const cost = R(r.assetCost * ratio);', 'const cost = R(r.assetCost);'],
  ['開始仕訳の税効果を0にする', 'elimination.js', 'res.DTo[co] = taxOf(C, res.Eopen[co], openIdx, pol, R);', 'res.DTo[co] = 0;'],
  ['貸手の定額収益の月数を誤る', 'schedule.js', 'const cum = R((incSeg.total * (m - incSeg.start + 1)) / (incSeg.end - incSeg.start + 1));', 'const cum = R((incSeg.total * (m - incSeg.start + 1)) / (incSeg.end - incSeg.start + 2));'],
  ['利息の月按分を1か月ずらす', 'schedule.js', 'const m = sg.ta + j - 1;', 'const m = sg.ta + j;'],
  ['C-12で按分比率を無視する', 'elimination.js', 'const dep = lessorDepBetween(sched, period.start, period.end, ratio, R);', 'const dep = lessorDepBetween(sched, period.start, period.end, 1, R);'],
  ['持分変動を資本剰余金に分けない', 'elimination.js', 'const capPart = capClose - capOpen;', 'const capPart = 0;'],
  ['解約益の取消の符号を誤る', 'elimination.js', "if (t.gain) lines.push(ln('TERM_GAIN', lesseeCo, t.gain, meta,", "if (t.gain) lines.push(ln('TERM_GAIN', lesseeCo, -t.gain, meta,"],
  ['違約金を消去しない', 'elimination.js', "    if (le.penalty) {\n      lines.push(ln('PENALTY_INC'", "    if (false) {\n      lines.push(ln('PENALTY_INC'"],
  ['前払の初回支払を負債から控除しない', 'schedule.js', 'le.L_end = prevL + mi - le.pay;', 'le.L_end = prevL + mi - (le.commence ? 0 : le.pay);'],
  ['当期損益分の非支配按分に期首の比率を使う', 'elimination.js', "return { N: R(rateAt(L, idx, 'nciRatio') * baseAt(idx)), cap };", "return { N: R(rateAt(L, idx - 12, 'nciRatio') * baseAt(idx)), cap };"],
  ['持分変動分を全額当期損益にする', 'elimination.js', 'if (n0 !== n1) { const b = baseAt(t - 1); cap += R(n1 * b) - R(n0 * b); }\n    }\n  } else {', 'if (n0 !== n1) { const b = baseAt(t - 1); cap += 0 * (R(n1 * b) - R(n0 * b)); }\n    }\n  } else {'],
  ['税率の切替を1か月遅らせる', 'accounts.js', 'if (y * 12 + m - 1 <= idx) v = h[key] || 0;', 'if (y * 12 + m <= idx) v = h[key] || 0;'],
  ['ASC842の単一費用の按分月数を誤る', 'schedule.js', 'const cum = R((costSeg.total * (m - costSeg.start + 1)) / costSeg.months);\n        le.cost = cum - costSeg.prevCum;\n        costSeg.prevCum = cum;\n        le.cost_end', 'const cum = R((costSeg.total * (m - costSeg.start + 1)) / (costSeg.months + 1));\n        le.cost = cum - costSeg.prevCum;\n        costSeg.prevCum = cum;\n        le.cost_end'],
  ['貸手資産の償却開始を1か月遅らせる', 'schedule.js', 'const k = Math.min(Math.max(m - aStart + 1, 0), r.assetLifeMonths);', 'const k = Math.min(Math.max(m - aStart, 0), r.assetLifeMonths);'],
  ['CF消去で利息を元本に含める', 'reports.js', 'if (x.m >= period.start && p) { interestPaid += ip; repay += p - ip; }', 'if (x.m >= period.start && p) { interestPaid += 0; repay += p; }'],
  ['条件変更の再測定額を使用権資産に反映しない', 'schedule.js', '          cost += dL;\n', ''],
  ['範囲縮小の取崩割合を誤る', 'schedule.js', 'const keep = (newEnd - m + 1) / (oldEnd - m + 1);', 'const keep = (newEnd - m + 2) / (oldEnd - m + 1);'],
  ['範囲縮小で減価償却累計額を取り崩さない', 'schedule.js', 'accOut = R(acc * (1 - keep));', 'accOut = 0;'],
  ['条件変更後の償却月数を1か月長くする', 'schedule.js', 'dep = { accBase: acc, net: cost - acc, from: m, months: newEnd - m + 1 };', 'dep = { accBase: acc, net: cost - acc, from: m, months: newEnd - m + 2 };'],
  ['条件変更後も変更前の割引率を使う', 'schedule.js', '&& modStarts[i] > measStart) r = mods[i].rate;', '&& modStarts[i] > measStart) r = r;'],
  ['遡及測定に契約時の割引率を使う', 'schedule.js', 'const seg = segFactorOf(rpOf(ms.rate));', 'const seg = segFactorOf(rpOf(L.rate));'],
  ['ASC842の条件変更後の費用から前払・未払を除く', 'schedule.js', 'total: sumPay(ph.plan, m, newEnd) + (prevCost - prevL), prevCum: 0 };', 'total: sumPay(ph.plan, m, newEnd), prevCum: 0 };'],
  ['貸手の条件変更後の未収を新たなリース料から控除しない', 'schedule.js', "incSeg = { start: m, end: endPlanned, total: sumPay(plan, m, endPlanned) - (m === s ? 0 : prevR), prevCum: 0 };", "incSeg = { start: m, end: endPlanned, total: sumPay(plan, m, endPlanned), prevCum: 0 };"],
];

async function ngIds(dir) {
  const imp = (f) => import(pathToFileURL(join(dir, f)).href + `?v=${Math.random()}`);
  const { sampleData } = await imp('sample.js');
  const { generateAll } = await imp('elimination.js');
  const { runChecks } = await imp('checks.js');
  const { buildSchedule } = await imp('schedule.js');
  const { defaultPolicies } = await imp('policies.js');
  const { buildPeriods, ymToIndex } = await imp('util.js');
  const d = sampleData();
  // 旧科目＋流動区分あり・税率/持分比率の変更がある会社も加えて検査範囲を広げる
  d.companies.push({ code: 'M4', name: 'M4', fyeMonth: 3, taxRate: 0.3, nciRatio: 0.3, taxEffect: true, legacyAccounts: true, splitsCurrent: true, history: [{ fromYm: '2029-04', taxRate: 0.32, nciRatio: 0.2 }] });
  d.contracts.push({ ...JSON.parse(JSON.stringify(d.contracts[0])), id: 'K-901', lesseeCo: 'M4', actuals: {}, lessor: { ...d.contracts[0].lessor, assetId: 'M-09' } });
  // 範囲縮小（期間短縮）、遡及測定（適用時の割引率が契約時と異なる）、ASC842 の条件変更
  d.companies.push({ code: 'M5', name: 'M5', fyeMonth: 3, taxRate: 0.3, nciRatio: 0, taxEffect: true, adoption: { method: 'cumulative', ym: '2027-04' } });
  d.contracts.push({ ...JSON.parse(JSON.stringify(d.contracts[0])), id: 'K-903', lesseeCo: 'M4', modifications: [{ ym: '2029-04', payment: null, termMonths: 48, rate: null }], lessor: { ...d.contracts[0].lessor, assetId: 'M-11' }, actuals: {} });
  d.contracts.push({ ...JSON.parse(JSON.stringify(d.contracts[0])), id: 'K-904', lesseeCo: 'M5', commencement: '2025-04', termMonths: 96, lessee: { ...d.contracts[0].lessee, rate: 0.04, rouTransition: 'retrospective', transitionRate: 0.025 }, lessor: { ...d.contracts[0].lessor, assetId: 'M-12', assetStart: '2025-04' }, actuals: {} });
  d.contracts.push({ ...JSON.parse(JSON.stringify(d.contracts[3])), id: 'K-905', modifications: [{ ym: '2028-08', payment: 360, termMonths: 60, rate: 0.05 }], lessor: { ...d.contracts[3].lessor, assetId: 'M-13' }, actuals: {} });
  // フリーレント中に条件変更（貸手の未収が残った状態で新たなリースとして扱う）
  d.contracts.push({ ...JSON.parse(JSON.stringify(d.contracts[1])), id: 'K-902', lesseeCo: 'M4', freePayments: 4, steps: [], modifications: [{ ym: '2027-07', payment: 60, termMonths: 36, rate: 0.03 }], lessee: { ...d.contracts[1].lessee, idc: 0 }, lessor: { ...d.contracts[1].lessor, assetId: 'M-10', ratio: 1 }, actuals: {} });
  // 持分比率の推移（異動日・みなし日）がある会社：期中の追加取得（等距離の日付）、四半期末みなしの一部売却
  d.companies.push({ code: 'M6', name: 'M6', fyeMonth: 3, taxRate: 0.3, nciRatio: 0, taxEffect: true, adoption: { method: 'cumulative', ym: '2027-04' }, ownership: [
    { date: '2027-04-01', ratio: 0.8, kind: 'acquire', deemed: 'nearest_month_end' }, { date: '2027-09-15', ratio: 0.9, kind: 'add', deemed: 'nearest_month_end' },
    { date: '2028-11-15', ratio: 0.6, kind: 'sell', deemed: 'nearest_quarter_end' }] });
  d.contracts.push({ ...JSON.parse(JSON.stringify(d.contracts[0])), id: 'K-906', lesseeCo: 'M6', frequencyMonths: 1, payment: 90, lessor: { ...d.contracts[0].lessor, assetId: 'M-14' }, actuals: {} });
  const periods = [...buildPeriods(ymToIndex('2027-04'), ymToIndex('2034-03'), 3), ...buildPeriods(ymToIndex('2027-04'), ymToIndex('2029-03'), 3, 'quarter')];
  const hit = new Set();
  for (const pol of [defaultPolicies(), { ...defaultPolicies(), 'POL-07': 'capitalize', 'POL-03': 'balance' }]) {
    // スケジュールは方針ごとに一度だけ作る（誤りを入れたスケジュール計算も、この同じ版を使う）
    const schedCache = new Map();
    for (const k of d.contracts) { try { schedCache.set(k.id, buildSchedule(k, pol, { lesseeCompany: d.companies.find((x) => x.code === k.lesseeCo) })); } catch (e) { hit.add(`例外:${e.message}`); } }
    for (const p of periods) {
      try {
        for (const c of runChecks(d, p, pol, generateAll(d, p, pol, { schedCache }), {}, { schedCache })) if (c.status === 'ng' && c.id !== 'CHK-10') hit.add(c.id);
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
