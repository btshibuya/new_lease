// テスト用の注記の収集値（各社の注記額）。サンプルの契約からアプリが計算したグループ内分に、
// グループ外のリースに係る分（会社・項目ごとに決まった疑似的な額）を加えて「各社の注記額」とする。
// アプリで計算しない項目（変動リース料など）は各社の注記額と「うちグループ会社とのリース分」の両方を、文章の項目は備考を入れる。
import { generateAll } from './elimination.js';
import { groupNoteAmounts, noteRows, notePeriodKey } from './notes.js';
import { buildPeriods, ymToIndex } from './util.js';

// 文字列から決まった数（0〜9999）を作る（乱数を使わず、毎回同じテストデータにするため）
function seed(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
  return x % 10000;
}

const MEMOS = {
  'R-CHG': 'リース投資資産の残高に重要な変動はありません。',
  'O-SLB': 'セール・アンド・リースバック取引はありません。',
  'O-SUB': 'サブリース取引はありません。',
};

/**
 * テスト用の注記の収集値を作る（年度末：2028年3月期〜2030年3月期）。
 * @returns {object} noteInputs（期間キー → 会社コード → 行キー → { total, group, memo }）
 */
export function sampleNoteInputs(data, pol, fyEnds = ['2028-03', '2029-03', '2030-03']) {
  const out = {};
  const years = buildPeriods(ymToIndex('2027-04'), ymToIndex('2031-03'), data.config?.fyeMonth || 3, 'year');
  for (const fy of fyEnds) {
    const p = years.find((x) => x.end === ymToIndex(fy));
    if (!p) continue;
    const g = groupNoteAmounts(generateAll(data, p, pol), p, pol, data.companies);
    const pk = notePeriodKey(p);
    out[pk] = {};
    for (const co of data.companies) {
      const m = {};
      for (const r of noteRows()) {
        const it = r.item;
        const own = (g.get(r.key)?.rows || []).filter((x) => x.co === co.code).reduce((a, x) => a + x.amt, 0);
        const h = seed(`${pk}|${co.code}|${r.key}`);
        const ext = h % 6 === 0 ? 0 : 20 + (h % 480); // グループ外のリースに係る分（0 の場合もある）
        if (it.kind === 'text') { m[r.key] = { total: null, group: null, memo: MEMOS[it.id] || '特記事項はありません。' }; continue; }
        if (it.kind === 'input') {
          const grp = h % 3 === 0 ? 0 : Math.round(ext * 0.25);
          m[r.key] = { total: ext + grp, group: grp, memo: '' };
          continue;
        }
        // アプリで計算する項目・グループ内分のない項目：各社の注記額＝グループ内分＋グループ外分（控除項目は負の向き）
        const neg = own < 0 || /unearned/.test(r.key);
        m[r.key] = { total: own + (neg ? -ext : ext), group: null, memo: '' };
      }
      out[pk][co.code] = m;
    }
  }
  return out;
}
