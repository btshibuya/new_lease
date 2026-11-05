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
  if (l.depMonths !== null && l.depMonths !== undefined) req(Number.isInteger(l.depMonths) && l.depMonths > 0, '償却月数は正の整数です');
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
  if ((r.assetCost ?? 0) > 0) {
    req(Number.isInteger(r.assetLifeMonths) && r.assetLifeMonths > 0, '貸手資産の耐用年数（月数）を入力してください');
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
 * 月次スケジュールを作成する。
 * @param {object} c 契約
 * @param {object} pol 会計方針（POL-10 割引率換算、POL-11 端数処理）
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

  // 支払予定（契約上）
  const payments = [];
  for (let j = 1; j <= K; j++) {
    const month = c.timing === 'advance' ? s + (j - 1) * f : s + j * f - 1;
    // t: 時点（月単位）。後払は月末＝month+1、前払は月初＝month
    const t = c.timing === 'advance' ? month : month + 1;
    payments.push({ no: j, month, t, amount: paymentAmount(c, j) });
  }
  const paid = payments.filter((p) => termIdx === null || p.month <= termIdx);
  const totalPayments = payments.reduce((a, p) => a + p.amount, 0);

  // ── 借手：リース負債 ──
  const transition = L.transition && L.transition.method === 'cumulative' ? L.transition : null;
  const measStart = transition ? ymToIndex(transition.ym) : s;
  const rate = transition ? transition.rate : L.rate;
  const rp = pol['POL-10'] === 'effective' ? Math.pow(1 + rate, f / 12) - 1 : (rate * f) / 12;
  const rmon = Math.pow(1 + rp, 1 / f) - 1; // 月次の複利換算率（支払期間内の按分に使用）
  const g = (x) => (rmon === 0 ? x : Math.pow(1 + rmon, x) - 1);

  const months = [];
  const meta = { start: s, end: lastIdx, measStart, N, f, K, rp, rate, payments, totalPayments, model: L.model };

  const lesseeOnBalance = L.model === 'jgaap' || L.model === 'asc842ol';
  const remaining = payments.filter((p) => p.month >= measStart);
  let L0 = 0;
  if (lesseeOnBalance) {
    const pv = remaining.reduce((a, p) => a + p.amount / Math.pow(1 + rmon, p.t - measStart), 0);
    L0 = L.liabilityOverride !== null && L.liabilityOverride !== undefined && !transition ? L.liabilityOverride : R(pv);
  }
  meta.L0 = L0;
  meta.pvExact = lesseeOnBalance ? remaining.reduce((a, p) => a + p.amount / Math.pow(1 + rmon, p.t - measStart), 0) : 0;

  // 区間（支払時点間）の利息を計算し、最終支払で残高0となるよう最後の区間で調整
  const points = remaining.filter((p) => termIdx === null || p.month <= termIdx);
  const segs = []; // {ta, tb, base, interest}
  if (lesseeOnBalance) {
    let B = L0;
    let ta = measStart;
    for (const p of remaining) {
      const len = p.t - ta;
      const I = len > 0 ? R(B * g(len)) : 0;
      segs.push({ ta, tb: p.t, base: B, interest: I, pay: p });
      B = B + I - p.amount;
      ta = p.t;
    }
    if (remaining.length) {
      const eps = B; // 最終支払後の残差
      // 最後に長さ>0の区間で調整
      for (let k = segs.length - 1; k >= 0; k--) {
        if (segs[k].tb - segs[k].ta > 0) { segs[k].interest -= eps; break; }
      }
      // 基礎残高を再計算
      let B2 = L0;
      for (const sg of segs) { sg.base = B2; B2 = B2 + sg.interest - sg.pay.amount; sg.after = B2; }
      meta.finalResidual = eps;
    }
  }
  meta.segments = segs;
  const totalInterest = segs.reduce((a, x) => a + x.interest, 0);
  meta.totalInterest = totalInterest;

  // 時点tにおける累積利息（区間内の按分）
  function cumInterestAt(t) {
    let cum = 0;
    for (const sg of segs) {
      if (t >= sg.tb) cum += sg.interest;
      else if (t > sg.ta) {
        const len = sg.tb - sg.ta;
        cum += R((sg.interest * g(t - sg.ta)) / g(len));
        break;
      } else break;
    }
    return cum;
  }
  function cumPaidThroughMonth(m) {
    // 月mの末日までに支払済みの額（前払は月初、後払は月末に支払）
    let cum = 0;
    for (const p of remaining) if (p.month <= m && (termIdx === null || p.month <= termIdx)) cum += p.amount;
    return cum;
  }

  // ── 借手：使用権資産 ──
  const idc = L.model === 'jgaap' ? L.idc || 0 : 0;
  const C0 = L.model === 'jgaap' ? L0 + idc : L0;
  const depMonths = L.depMonths || s + N - measStart;
  meta.C0 = C0;
  meta.idc = idc;
  meta.depMonths = depMonths;
  meta.transferLike = depMonths > s + N - measStart;

  // ── 貸手 ──
  const r = c.lessor || {};
  const ratio = r.ratio ?? 1;
  const aStart = r.assetCost > 0 ? ymToIndex(r.assetStart) : null;
  function lessorAccAt(m) {
    if (!(r.assetCost > 0)) return 0;
    const k = Math.min(Math.max(m - aStart + 1, 0), r.assetLifeMonths);
    return R((r.assetCost * k) / r.assetLifeMonths);
  }

  const firstIdx = Math.min(s, measStart);
  let prevL = 0, prevAcc = 0, prevCost = 0, prevX = 0, prevR = 0, prevIncCum = 0, prevCostCum = 0;
  let prevIdcAcc = 0, prevLessorAcc = aStart !== null ? lessorAccAt(firstIdx - 1) : 0;
  let cashCumL = 0, cashCumR = 0, terminated = false;

  for (let m = firstIdx; m <= lastIdx; m++) {
    const rec = { m, ym: indexToYm(m), lessee: {}, lessor: {} };
    const tEnd = m + 1;
    const payInMonth = paid.filter((p) => p.month === m).reduce((a, p) => a + p.amount, 0);
    const lesseeActive = m >= measStart;
    const le = rec.lessee;
    le.active = lesseeActive;
    le.pay = lesseeActive ? payInMonth : 0;
    // 貸手は契約開始から現金を受け取る（適用開始前の支払も含む）
    const lo = rec.lessor;
    lo.cash = payInMonth;

    if (lesseeOnBalance && lesseeActive) {
      const commence = m === measStart;
      if (commence) le.commence = { L0, C0, idc };
      const intCum = cumInterestAt(tEnd);
      const intPrev = m === measStart ? 0 : cumInterestAt(m);
      // 日本基準・IFRS：支払利息として計上／ASC842オペ：単一リース費用に含まれるため accr（利息相当の増加）として保持
      if (L.model === 'jgaap') { le.int = intCum - intPrev; le.accr = 0; } else { le.int = 0; le.accr = intCum - intPrev; }
      cashCumL += le.pay;
      const Lend = L0 + intCum - cumPaidThroughMonth(m);
      le.L_open = commence ? 0 : prevL;
      le.L_end = Lend;
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
        // ASC842 オペレーティング・リース：単一リース費用（定額）、使用権資産はリース負債からの差額
        const k = m - s + 1;
        const costCum = R((totalPayments * k) / N);
        le.cost = costCum - prevCostCum;
        prevCostCum = costCum;
        le.cost_end = Lend + cashCumL - costCum; // 使用権資産（純額）
        le.acc_end = 0;
        le.dep = 0;
      }
      le.X_end = 0;
    } else if (L.model === 'offbalance' && lesseeActive) {
      // 短期・少額リース等：借手はオフバランス、費用は定額
      const k = m - s + 1;
      const expCum = R((totalPayments * k) / N);
      le.cost = expCum - prevCostCum;
      prevCostCum = expCum;
      cashCumL += le.pay;
      le.X_end = expCum - cashCumL; // 未払リース料（＋）／前払（−）
      le.L_end = 0; le.L_open = 0; le.int = 0; le.dep = 0; le.cost_end = 0; le.acc_end = 0;
    } else {
      Object.assign(le, { L_end: 0, L_open: 0, int: 0, dep: 0, cost_end: 0, acc_end: 0, X_end: 0, cost: 0 });
    }

    // 貸手：受取リース料（定額法）
    const kR = m - s + 1;
    const incCum = R((totalPayments * kR) / N);
    lo.inc = incCum - prevIncCum;
    cashCumR += lo.cash;
    lo.R_end = incCum - cashCumR;
    prevIncCum = incCum;

    // 貸手資産の減価償却（按分比率適用前の全体額と按分後）
    if (aStart !== null) {
      const acc = lessorAccAt(m);
      lo.assetDep = acc - prevLessorAcc;
      lo.assetAcc_end = acc;
      lo.assetCost = r.assetCost;
      prevLessorAcc = acc;
    } else { lo.assetDep = 0; lo.assetAcc_end = 0; lo.assetCost = 0; }
    lo.ratio = ratio;

    // 中途解約・満了
    const isTerm = termIdx !== null && m === termIdx;
    const isExpiry = termIdx === null && m === s + N - 1;
    if (isTerm || (isExpiry && L.derecognizeAtExpiry !== false && !meta.transferLike)) {
      const rouNet = (le.cost_end || 0) - (le.acc_end || 0);
      le.term = {
        kind: isTerm ? 'termination' : 'expiry',
        L: le.L_end || 0,
        cost: le.cost_end || 0,
        acc: le.acc_end || 0,
        X: le.X_end || 0,
        idcAcc: le.idcAcc_end || 0,
        gain: (le.L_end || 0) + (le.X_end || 0) - rouNet, // ＋＝解約益
      };
      if (isTerm) {
        // 貸手は定額法による未収（前受）を解約時に取り崩す（受取リース料の修正）
        lo.termAdj = -lo.R_end;
        lo.inc += lo.termAdj;
        lo.R_end = 0;
      }
      le.L_end = 0; le.cost_end = 0; le.acc_end = 0; le.X_end = 0; le.idcAcc_end = 0;
      terminated = true;
    }
    prevL = le.L_end || 0;
    prevAcc = le.acc_end || 0;
    prevCost = le.cost_end || 0;
    prevX = le.X_end || 0;
    prevR = lo.R_end;
    months.push(rec);
  }
  meta.terminated = terminated;
  meta.firstIdx = firstIdx;
  meta.lastIdx = lastIdx;
  return { contract: c, meta, months, byIndex: (i) => months.find((x) => x.m === i) || null };
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
  const term = sched.contract.terminationYm ? ymToIndex(sched.contract.terminationYm) : null;
  const within = meta.segments.filter((sg) => sg.pay.month > endIdx && sg.pay.month <= endIdx + 12 && (term === null || sg.pay.month <= term));
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
