// リース契約の月次スケジュール（共通部品）
// 借手：実効金利法によるリース負債、定額法による使用権資産償却
// 貸手：オペレーティング・リース（受取リース料の定額法認識、対象資産の定額法償却）
import { round, ymToIndex, indexToYm } from './util.js';

/** 契約入力の検証。エラーメッセージの配列を返す（空なら正常）。 */
export function validateContract(c, companies = []) {
  const e = [];
  const codes = new Set(companies.map((x) => x.code));
  const req = (cond, msg) => { if (!cond) e.push(msg); };
  req(c && typeof c === 'object', '契約データがありません');
  if (!c || typeof c !== 'object') return e;
  req(typeof c.id === 'string' && c.id.trim() !== '', '契約番号は必須です');
  req(codes.size === 0 || codes.has(c.lessorCo), `貸手会社コード「${c.lessorCo}」が会社マスタにありません`);
  req(codes.size === 0 || codes.has(c.lesseeCo), `借手会社コード「${c.lesseeCo}」が会社マスタにありません`);
  req(c.lessorCo !== c.lesseeCo, '貸手と借手が同じ会社です');
  try { ymToIndex(c.commencement); } catch { e.push('リース開始年月が不正です（YYYY-MM）'); }
  req(Number.isInteger(c.termMonths) && c.termMonths > 0 && c.termMonths <= 1200, 'リース期間（月数）は1〜1200の整数で入力してください');
  req([1, 3, 6, 12].includes(c.frequencyMonths), '支払間隔は1・3・6・12か月のいずれかです');
  if (Number.isInteger(c.termMonths) && [1, 3, 6, 12].includes(c.frequencyMonths)) {
    req(c.termMonths % c.frequencyMonths === 0, 'リース期間は支払間隔の整数倍にしてください');
  }
  req(['arrears', 'advance'].includes(c.timing), '支払時期は後払（arrears）または前払（advance）です');
  req(Number.isFinite(c.payment) && c.payment >= 0, '1回あたりリース料は0以上の数値です');
  req(Number.isInteger(c.freePayments ?? 0) && (c.freePayments ?? 0) >= 0, 'フリーレント回数は0以上の整数です');
  for (const s of c.steps || []) {
    req(Number.isInteger(s.fromPayment) && s.fromPayment >= 1 && Number.isFinite(s.amount) && s.amount >= 0, '段階賃料の指定が不正です');
  }
  const l = c.lessee || {};
  req(['jgaap', 'asc842ol', 'offbalance'].includes(l.model), '借手の会計モデルが不正です');
  req(Number.isFinite(l.rate) && l.rate >= 0 && l.rate < 1, '割引率は0以上1未満（例：0.03）で入力してください');
  req(Number.isFinite(l.idc ?? 0) && (l.idc ?? 0) >= 0, '初期直接費用は0以上です');
  if (l.depMonths !== null && l.depMonths !== undefined) {
    req(Number.isInteger(l.depMonths) && l.depMonths > 0, '償却月数は正の整数です');
    if (Number.isInteger(c.termMonths)) req(!(l.depMonths > c.termMonths), '償却月数がリース期間を超える契約（所有権移転・購入オプション行使が合理的に確実）は未対応です（今後対応）');
  }
  const K = Number.isInteger(c.termMonths) && [1, 3, 6, 12].includes(c.frequencyMonths) ? c.termMonths / c.frequencyMonths : null;
  const froms = (c.steps || []).map((x) => x.fromPayment);
  req(new Set(froms).size === froms.length, '段階賃料の開始回が重複しています');
  if (K) req(froms.every((x) => x <= K), `段階賃料の開始回は支払回数（${K}回）以内にしてください`);
  if (K) req((c.freePayments || 0) < K, 'フリーレント回数が支払回数以上です');
  req(Number.isFinite(c.terminationPenalty ?? 0) && (c.terminationPenalty ?? 0) >= 0, '違約金は0以上です');
  if (c.terminationPenalty > 0) req(!!c.terminationYm, '違約金は中途解約年月とあわせて入力してください');
  if (l.transition && l.transition.method === 'cumulative') {
    try {
      const t = ymToIndex(l.transition.ym);
      const s = ymToIndex(c.commencement);
      req(t > s && t < s + c.termMonths, '適用開始年月はリース期間の途中である必要があります');
    } catch { e.push('適用開始年月が不正です'); }
    req(Number.isFinite(l.transition.rate) && l.transition.rate >= 0, '適用開始時の割引率が不正です');
    req(l.model === 'jgaap', '累積的影響方式（使用権資産＝リース負債）は日本基準モデルのみ対応しています');
  }
  if (c.terminationYm) {
    try {
      const t = ymToIndex(c.terminationYm);
      const s = ymToIndex(c.commencement);
      req(t >= s && t < s + c.termMonths - 1, '中途解約年月はリース期間の途中である必要があります');
    } catch { e.push('中途解約年月が不正です'); }
  }
  const r = c.lessor || {};
  req(Number.isFinite(r.assetCost ?? 0) && (r.assetCost ?? 0) >= 0, '貸手資産の取得原価は0以上です');
  req(Number.isFinite(r.ratio ?? 1) && (r.ratio ?? 1) > 0 && (r.ratio ?? 1) <= 1, '貸手資産の按分比率は0超1以下です');
  if ((r.assetCost ?? 0) > 0 && c.assetClass !== 'land') {
    req(Number.isInteger(r.assetLifeMonths) && r.assetLifeMonths > 0, '貸手資産の耐用年数（月数）を入力してください（土地は不要）');
    try { ymToIndex(r.assetStart); } catch { e.push('貸手資産の取得年月が不正です'); }
  }
  return e;
}

/** j回目（1始まり）の支払額 */
function paymentAmount(c, j) {
  if (j <= (c.freePayments || 0)) return 0;
  let amt = c.payment;
  for (const s of [...(c.steps || [])].sort((a, b) => a.fromPayment - b.fromPayment)) {
    if (j >= s.fromPayment) amt = s.amount;
  }
  return amt;
}

/**
 * 月次スケジュールを作成する（計算量は契約月数に比例）。
 * @param {object} c 契約
 * @param {object} pol 会計方針（POL-10 割引率換算・期間内按分、POL-11 端数処理）
 */
export function buildSchedule(c, pol = {}) {
  const rm = pol['POL-11'] || 'half_up';
  const R = (v) => round(v, rm);
  const s = ymToIndex(c.commencement);
  const N = c.termMonths;
  const f = c.frequencyMonths;
  const K = N / f;
  const L = c.lessee;
  const termIdx = c.terminationYm ? ymToIndex(c.terminationYm) : null;
  const lastIdx = termIdx ?? s + N - 1;
  const nominal = pol['POL-10'] !== 'effective';

  // 支払予定（契約上）
  const payments = [];
  for (let j = 1; j <= K; j++) {
    const month = c.timing === 'advance' ? s + (j - 1) * f : s + j * f - 1;
    // t: 時点（月単位）。後払は月末＝month+1、前払は月初＝month
    const t = c.timing === 'advance' ? month : month + 1;
    payments.push({ no: j, month, t, amount: paymentAmount(c, j) });
  }
  const totalPayments = payments.reduce((a, p) => a + p.amount, 0);
  const payByMonth = new Map();
  for (const p of payments) if (termIdx === null || p.month <= termIdx) payByMonth.set(p.month, (payByMonth.get(p.month) || 0) + p.amount);
  const penalty = termIdx !== null ? Math.max(0, c.terminationPenalty || 0) : 0;

  // ── 借手：リース負債 ──
  const transition = L.transition && L.transition.method === 'cumulative' ? L.transition : null;
  const measStart = transition ? ymToIndex(transition.ym) : s;
  const rate = transition ? transition.rate : L.rate;
  // 期間（支払間隔f）あたりの利率
  const rp = nominal ? (rate * f) / 12 : Math.pow(1 + rate, f / 12) - 1;
  // len か月分の利率：名目＝単利按分、実効＝複利
  const segFactor = (len) => (nominal ? (rp * len) / f : Math.pow(1 + rp, len / f) - 1);

  const months = [];
  const meta = { start: s, end: lastIdx, measStart, N, f, K, rp, rate, payments, totalPayments, model: L.model, nominal, penalty };

  const lesseeOnBalance = L.model === 'jgaap' || L.model === 'asc842ol';
  const remaining = payments.filter((p) => p.month >= measStart);
  // 現在価値：後ろから順に割り戻す（前進計算と同じ利率規約）
  let pv = 0;
  for (let i = remaining.length - 1; i >= 0; i--) {
    const p = remaining[i];
    const prevT = i > 0 ? remaining[i - 1].t : measStart;
    pv = (pv + p.amount) / (1 + segFactor(p.t - prevT));
  }
  meta.pvExact = lesseeOnBalance ? pv : 0;
  let L0 = 0;
  if (lesseeOnBalance) {
    L0 = L.liabilityOverride !== null && L.liabilityOverride !== undefined && !transition ? L.liabilityOverride : R(pv);
  }
  meta.L0 = L0;

  // 区間（支払時点間）の利息。最終支払で残高0となるよう、最後の区間で端数を調整
  const segs = [];
  if (lesseeOnBalance) {
    let B = L0;
    let ta = measStart;
    for (const p of remaining) {
      const len = p.t - ta;
      segs.push({ ta, tb: p.t, base: B, interest: len > 0 ? R(B * segFactor(len)) : 0, pay: p });
      B = B + segs[segs.length - 1].interest - p.amount;
      ta = p.t;
    }
    meta.finalResidual = remaining.length ? B : 0;
    if (remaining.length && B !== 0) {
      for (let k = segs.length - 1; k >= 0; k--) {
        if (segs[k].tb - segs[k].ta > 0) { segs[k].interest -= B; break; }
      }
    }
    let B2 = L0;
    for (const sg of segs) { sg.base = B2; B2 = B2 + sg.interest - sg.pay.amount; sg.after = B2; }
  }
  meta.segments = segs;
  meta.totalInterest = segs.reduce((a, x) => a + x.interest, 0);

  // 月ごとの利息（区間内の按分：名目＝定額、実効＝複利の累計で端数処理）
  const monthInt = new Map();
  for (const sg of segs) {
    const len = sg.tb - sg.ta;
    if (len <= 0) continue;
    let prev = 0;
    for (let k = 1; k <= len; k++) {
      const cum = k === len ? sg.interest : nominal ? R((sg.interest * k) / len) : R((sg.interest * (Math.pow(1 + rp, k / f) - 1)) / (Math.pow(1 + rp, len / f) - 1 || 1));
      const m = sg.ta + k - 1;
      monthInt.set(m, (monthInt.get(m) || 0) + cum - prev);
      prev = cum;
    }
  }

  // ── 借手：使用権資産 ──
  const idc = L.model === 'jgaap' ? L.idc || 0 : 0;
  const C0 = L.model === 'jgaap' ? L0 + idc : L0;
  const depMonths = L.depMonths || s + N - measStart;
  Object.assign(meta, { C0, idc, depMonths, transferLike: depMonths > s + N - measStart });

  // ── 貸手 ──
  const r = c.lessor || {};
  const ratio = r.ratio ?? 1;
  const depreciable = r.assetCost > 0 && c.assetClass !== 'land' && r.assetLifeMonths > 0;
  const aStart = depreciable ? ymToIndex(r.assetStart) : null;
  const lessorAccAt = (m) => {
    if (!depreciable) return 0;
    const k = Math.min(Math.max(m - aStart + 1, 0), r.assetLifeMonths);
    return R((r.assetCost * k) / r.assetLifeMonths);
  };

  const firstIdx = Math.min(s, measStart);
  let prevL = 0, prevAcc = 0, prevIncCum = 0, prevCostCum = 0, prevIdcAcc = 0;
  let prevLessorAcc = lessorAccAt(firstIdx - 1);
  let cashCumL = 0, cashCumR = 0, terminated = false;

  for (let m = firstIdx; m <= lastIdx; m++) {
    const rec = { m, ym: indexToYm(m), lessee: {}, lessor: {} };
    const payInMonth = payByMonth.get(m) || 0;
    const lesseeActive = m >= measStart;
    const le = rec.lessee;
    const lo = rec.lessor;
    le.active = lesseeActive;
    le.pay = lesseeActive ? payInMonth : 0;
    lo.cash = payInMonth; // 貸手は契約開始から受け取る（適用開始前の支払も含む）

    if (lesseeOnBalance && lesseeActive) {
      const commence = m === measStart;
      if (commence) le.commence = { L0, C0, idc };
      const mi = monthInt.get(m) || 0;
      // 日本基準・IFRS：支払利息／ASC842オペ：単一リース費用に含まれるため accr（利息相当の増加）として保持
      if (L.model === 'jgaap') { le.int = mi; le.accr = 0; } else { le.int = 0; le.accr = mi; }
      cashCumL += le.pay;
      le.L_open = commence ? 0 : prevL;
      le.L_end = (commence ? L0 : prevL) + mi - le.pay;
      if (L.model === 'jgaap') {
        const k = Math.min(m - measStart + 1, depMonths);
        const acc = R((C0 * k) / depMonths);
        le.dep = acc - (commence ? 0 : prevAcc);
        le.acc_end = acc;
        le.cost_end = C0;
        const idcAcc = idc > 0 ? R((idc * k) / depMonths) : 0;
        le.idcDep = idcAcc - (commence ? 0 : prevIdcAcc);
        le.idcAcc_end = idcAcc;
        prevIdcAcc = idcAcc;
      } else {
        // ASC842 オペレーティング・リース：単一リース費用（定額）、使用権資産＝リース負債＋支払累計−費用累計
        const costCum = R((totalPayments * (m - s + 1)) / N);
        le.cost = costCum - prevCostCum;
        prevCostCum = costCum;
        le.cost_end = le.L_end + cashCumL - costCum;
        le.acc_end = 0;
        le.dep = 0;
      }
      le.X_end = 0;
    } else if (L.model === 'offbalance' && lesseeActive) {
      // 短期・少額リース等：借手はオフバランス、費用は定額
      const expCum = R((totalPayments * (m - s + 1)) / N);
      le.cost = expCum - prevCostCum;
      prevCostCum = expCum;
      cashCumL += le.pay;
      Object.assign(le, { X_end: expCum - cashCumL, L_end: 0, L_open: 0, int: 0, accr: 0, dep: 0, cost_end: 0, acc_end: 0 });
    } else {
      Object.assign(le, { L_end: 0, L_open: 0, int: 0, accr: 0, dep: 0, cost_end: 0, acc_end: 0, X_end: 0, cost: 0 });
    }

    // 貸手：受取リース料（定額法）
    const incCum = R((totalPayments * (m - s + 1)) / N);
    lo.inc = incCum - prevIncCum;
    cashCumR += lo.cash;
    lo.R_end = incCum - cashCumR;
    prevIncCum = incCum;

    // 貸手資産の減価償却（按分比率適用前の全体額。土地は非償却）
    const accL = lessorAccAt(m);
    lo.assetDep = accL - prevLessorAcc;
    lo.assetAcc_end = accL;
    lo.assetCost = r.assetCost > 0 ? r.assetCost : 0;
    prevLessorAcc = accL;
    lo.ratio = ratio;

    // 中途解約・満了
    const isTerm = termIdx !== null && m === termIdx;
    const isExpiry = termIdx === null && m === s + N - 1;
    if (isTerm || isExpiry) {
      const rouNet = (le.cost_end || 0) - (le.acc_end || 0);
      le.term = {
        kind: isTerm ? 'termination' : 'expiry',
        L: le.L_end || 0, cost: le.cost_end || 0, acc: le.acc_end || 0, X: le.X_end || 0, idcAcc: le.idcAcc_end || 0,
        gain: (le.L_end || 0) + (le.X_end || 0) - rouNet, // ＋＝解約益（違約金は別建て）
      };
      if (isTerm) {
        // 貸手は定額法による未収（前受）を解約時に取り崩す（受取リース料の修正）
        lo.termAdj = -lo.R_end;
        lo.inc += lo.termAdj;
        lo.R_end = 0;
        if (penalty) { le.penalty = penalty; lo.penalty = penalty; }
      }
      le.L_end = 0; le.cost_end = 0; le.acc_end = 0; le.X_end = 0; le.idcAcc_end = 0;
      terminated = true;
    }
    prevL = le.L_end || 0;
    prevAcc = le.acc_end || 0;
    months.push(rec);
  }
  Object.assign(meta, { terminated, firstIdx, lastIdx, payByMonth });
  return { contract: c, meta, months, byIndex: (i) => (i >= firstIdx && i <= lastIdx ? months[i - firstIdx] : null) };
}

/**
 * 月末時点の借手リース負債の流動部分（決算日後1年以内に支払われるリース料に対応する元本）
 * = 期末残高 − 12か月以内の最後の支払直後の残高
 */
export function currentPortion(sched, endIdx) {
  const { meta } = sched;
  if (meta.model === 'offbalance') return 0;
  const rec = sched.byIndex(endIdx);
  if (!rec || !rec.lessee.active) return 0;
  const Lend = rec.lessee.L_end;
  if (!Lend) return 0;
  // 中途解約は解約月に発生する事象として扱い、それ以前の決算日では契約上の支払予定で区分する（借手の個別帳簿と同じ前提）
  const within = meta.segments.filter((sg) => sg.pay.month > endIdx && sg.pay.month <= endIdx + 12);
  if (!within.length) return 0;
  const last = within[within.length - 1];
  return Lend - last.after;
}

/** 期間 [startIdx, endIdx] の合計値と期首・期末残高 */
export function periodSummary(sched, startIdx, endIdx) {
  const before = sched.months.filter((x) => x.m < startIdx);
  const inP = sched.months.filter((x) => x.m >= startIdx && x.m <= endIdx);
  const lastBefore = before[before.length - 1];
  const lastIn = inP[inP.length - 1] || (sched.months.length && sched.months[sched.months.length - 1].m < startIdx ? sched.months[sched.months.length - 1] : null);
  const bal = (rec) => ({
    L: rec ? rec.lessee.L_end || 0 : 0,
    cost: rec ? rec.lessee.cost_end || 0 : 0,
    acc: rec ? rec.lessee.acc_end || 0 : 0,
    X: rec ? rec.lessee.X_end || 0 : 0,
    R: rec ? rec.lessor.R_end || 0 : 0,
    idcAcc: rec ? rec.lessee.idcAcc_end || 0 : 0,
  });
  const s = (f) => inP.reduce((a, x) => a + (f(x) || 0), 0);
  const ended = sched.months.length && sched.months[sched.months.length - 1].m < startIdx;
  return {
    open: bal(lastBefore),
    close: ended ? bal(null) : bal(inP.length ? inP[inP.length - 1] : lastBefore),
    int: s((x) => x.lessee.int),
    accr: s((x) => x.lessee.accr),
    pay: s((x) => x.lessee.pay),
    dep: s((x) => x.lessee.dep),
    cost: s((x) => x.lessee.cost),
    idcDep: s((x) => x.lessee.idcDep),
    inc: s((x) => x.lessor.inc),
    cash: s((x) => x.lessor.cash),
    assetDep: s((x) => x.lessor.assetDep),
    commence: inP.find((x) => x.lessee.commence)?.lessee.commence || null,
    term: inP.find((x) => x.lessee.term)?.lessee.term || null,
    months: inP.length,
    activeMonths: inP.filter((x) => x.lessee.active).length,
    lastRec: lastIn,
  };
}
