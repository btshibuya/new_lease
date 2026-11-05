// 共通ユーティリティ（端数処理・年月計算）
// 金額は「入力単位（円・千円など）の整数」で保持する。浮動小数点で計算した値は必ず round() を通す。

const EPS = 1e-7;

/**
 * 端数処理
 * @param {number} v
 * @param {'half_up'|'floor'|'ceil'} mode 四捨五入／切捨（0方向）／切上（0から離れる方向）
 */
export function round(v, mode = 'half_up') {
  if (!Number.isFinite(v)) throw new Error(`数値ではありません: ${v}`);
  const s = v < 0 ? -1 : 1;
  const a = Math.abs(v);
  let r;
  if (mode === 'floor') r = Math.floor(a + EPS);
  else if (mode === 'ceil') r = Math.ceil(a - EPS);
  else r = Math.floor(a + 0.5 + EPS);
  return r === 0 ? 0 : s * r;
}

/** "2027-04" → 月インデックス（西暦×12＋月−1） */
export function ymToIndex(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) throw new Error(`年月の形式が不正です（YYYY-MM）: ${ym}`);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new Error(`月が不正です: ${ym}`);
  return Number(m[1]) * 12 + mon - 1;
}

/** 月インデックス → "2027-04" */
export function indexToYm(i) {
  const y = Math.floor(i / 12);
  const m = (i % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** 月インデックス → "2027年4月" */
export function indexToJp(i) {
  const y = Math.floor(i / 12);
  const m = (i % 12) + 1;
  return `${y}年${m}月`;
}

/**
 * 決算月（1〜12）から、指定年月を含む会計年度の [開始, 終了] 月インデックスを返す。
 * 例：決算月3、2027-06 → [2027-04, 2028-03]
 */
export function fiscalYearOf(index, fyeMonth) {
  const fe = fyeMonth - 1; // 0-based
  const m = index % 12;
  const y = Math.floor(index / 12);
  const endYear = m <= fe ? y : y + 1;
  const end = endYear * 12 + fe;
  return [end - 11, end];
}

/** 会計年度の表示名（例：2028年3月期） */
export function fiscalLabel(endIndex) {
  return `${indexToJp(endIndex).replace(/月$/, '')}月期`;
}

/** 期間の一覧（会計年度または四半期）を生成 */
export function buildPeriods(fromIndex, toIndex, fyeMonth, granularity = 'year') {
  const periods = [];
  let [s, e] = fiscalYearOf(fromIndex, fyeMonth);
  while (s <= toIndex) {
    if (granularity === 'quarter') {
      for (let q = 0; q < 4; q++) {
        const qs = s + q * 3;
        const qe = qs + 2;
        periods.push({ start: qs, end: qe, label: `${fiscalLabel(e)} 第${q + 1}四半期（〜${indexToJp(qe)}）`, fyEnd: e });
      }
    } else {
      periods.push({ start: s, end: e, label: fiscalLabel(e), fyEnd: e });
    }
    s += 12;
    e += 12;
  }
  return periods;
}

export function sum(arr, f = (x) => x) {
  let t = 0;
  for (const x of arr) t += f(x);
  return t;
}

/** 金額の表示（3桁区切り、マイナスは△） */
export function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  const n = Math.round(v);
  const s = Math.abs(n).toLocaleString('ja-JP');
  return n < 0 ? `△${s}` : s;
}

export function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}
