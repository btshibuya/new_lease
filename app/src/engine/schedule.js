// リース契約の月次スケジュール（共通部品）
// 借手：実効金利法によるリース負債、定額法による使用権資産償却、条件変更時の再測定
// 貸手：オペレーティング・リース（受取リース料の定額法認識、対象資産の定額法償却、条件変更は新たなリースとして扱う）
import { round, ymToIndex, indexToYm } from './util.js';

export const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'CONSOL']);

const idxOr = (ym, def = null) => { try { return ymToIndex(ym); } catch { return def; } };

/** 条件変更を年月順に並べる */
export function sortedMods(c) {
  return [...(c.modifications || [])].filter((m) => idxOr(m.ym) !== null).sort((a, b) => ymToIndex(a.ym) - ymToIndex(b.ym));
}

/** 借手の測定開始月（適用初年度の経過措置を反映） */
export function measurementStart(c, lesseeCompany) {
  const s = ymToIndex(c.commencement);
  const L = c.lessee || {};
  if (L.transition && L.transition.method === 'cumulative' && idxOr(L.transition.ym) !== null) {
    return { start: ymToIndex(L.transition.ym), rate: L.transition.rate, retro: false, source: 'contract' };
  }
  const ad = lesseeCompany?.adoption;
  if (ad && ad.method === 'cumulative' && idxOr(ad.ym) !== null) {
    const a = ymToIndex(ad.ym);
    if (s < a) return { start: a, rate: L.transitionRate ?? L.rate, retro: L.rouTransition === 'retrospective', source: 'company' };
  }
  return { start: s, rate: L.rate, retro: false, source: 'none' };
}

/** 契約入力の検証。エラーメッセージの配列を返す（空なら正常）。 */
export function validateContract(c, companies = []) {
  const e = [];
  const codes = new Set(companies.map((x) => x.code));
  const req = (cond, msg) => { if (!cond) e.push(msg); };
  req(c && typeof c === 'object', '契約データがありません');
  if (!c || typeof c !== 'object') return e;
  req(typeof c.id === 'string' && c.id.trim() !== '', '契約番号は必須です');
  req(!RESERVED_IDS.has(c.id), `契約番号「${c.id}」は予約語のため使用できません`);
  req(codes.size === 0 || codes.has(c.lessorCo), `貸手会社コード「${c.lessorCo}」が会社マスタにありません`);
  req(codes.size === 0 || codes.has(c.lesseeCo), `借手会社コード「${c.lesseeCo}」が会社マスタにありません`);
  req(c.lessorCo !== c.lesseeCo, '貸手と借手が同じ会社です');
  const s = idxOr(c.commencement);
  req(s !== null, 'リース開始年月が不正です（YYYY-MM）');
  req(Number.isInteger(c.termMonths) && c.termMonths > 0 && c.termMonths <= 1200, 'リース期間（月数）は1〜1200の整数で入力してください');
  req([1, 3, 6, 12].includes(c.frequencyMonths), '支払間隔は1・3・6・12か月のいずれかです');
  const okTerm = Number.isInteger(c.termMonths) && [1, 3, 6, 12].includes(c.frequencyMonths);
  if (okTerm) req(c.termMonths % c.frequencyMonths === 0, 'リース期間は支払間隔の整数倍にしてください');
  req(['arrears', 'advance'].includes(c.timing), '支払時期は後払（arrears）または前払（advance）です');
  req(Number.isFinite(c.payment) && c.payment >= 0, '1回あたりリース料は0以上の数値です');
  req(Number.isInteger(c.freePayments ?? 0) && (c.freePayments ?? 0) >= 0, 'フリーレント回数は0以上の整数です');
  for (const x of c.steps || []) req(Number.isInteger(x.fromPayment) && x.fromPayment >= 1 && Number.isFinite(x.amount) && x.amount >= 0, '段階賃料の指定が不正です');
  const L = c.lessee || {};
  req(['jgaap', 'asc842ol', 'offbalance'].includes(L.model), '借手の会計モデルが不正です');
  req(Number.isFinite(L.rate) && L.rate >= 0 && L.rate < 1, '割引率は0以上1未満（例：0.03）で入力してください');
  req(Number.isFinite(L.idc ?? 0) && (L.idc ?? 0) >= 0, '初期直接費用は0以上です');
  const K = okTerm ? c.termMonths / c.frequencyMonths : null;
  const froms = (c.steps || []).map((x) => x.fromPayment);
  req(new Set(froms).size === froms.length, '段階賃料の開始回が重複しています');
  if (K) req(froms.every((x) => x <= K), `段階賃料の開始回は支払回数（${K}回）以内にしてください`);
  if (K) req((c.freePayments || 0) < K, 'フリーレント回数が支払回数以上です');
  req(Number.isFinite(c.terminationPenalty ?? 0) && (c.terminationPenalty ?? 0) >= 0, '違約金は0以上です');
  if (c.terminationPenalty > 0) req(!!c.terminationYm, '違約金は中途解約年月とあわせて入力してください');
  const lessee = companies.find((x) => x.code === c.lesseeCo);
  let ms = s;
  if (s !== null && okTerm) {
    const m = measurementStart(c, lessee);
    ms = m.start;
    if (m.source !== 'none') {
      req(L.model !== 'asc842ol', '適用初年度の累積的影響方式は日本基準の借手のみ対応しています（IFRS・US GAAP の子会社は会社マスタで「適用済み」を選択）');
      req(Number.isFinite(m.rate) && m.rate >= 0 && m.rate < 1, '適用開始時の割引率が不正です');
    }
    if (m.source === 'contract') req(ms > s && ms < s + c.termMonths, '契約の適用開始年月はリース期間の途中である必要があります');
  }
  // 条件変更
  const mods = sortedMods(c);
  req(mods.length === (c.modifications || []).length, '条件変更の年月が不正です');
  let prevN = c.termMonths;
  let prevM = s;
  for (const m of mods) {
    const mi = ymToIndex(m.ym);
    req(mi > prevM, `条件変更 ${m.ym}：年月は開始月・前回の変更より後にしてください`);
    if (s !== null) req(mi < s + prevN, `条件変更 ${m.ym}：リース期間の終了前にしてください`);
    const n = m.termMonths ?? prevN;
    if (s !== null && okTerm) {
      req(Number.isInteger(n) && n % c.frequencyMonths === 0 && n <= 1200, `条件変更 ${m.ym}：変更後のリース期間は支払間隔の整数倍にしてください`);
      req(s + n - 1 >= mi, `条件変更 ${m.ym}：変更後のリース期間は変更月以降まで必要です`);
    }
    req(m.payment === null || m.payment === undefined || (Number.isFinite(m.payment) && m.payment >= 0), `条件変更 ${m.ym}：リース料が不正です`);
    req(m.rate === null || m.rate === undefined || (Number.isFinite(m.rate) && m.rate >= 0 && m.rate < 1), `条件変更 ${m.ym}：割引率が不正です`);
    if (c.terminationYm) req(mi <= ymToIndex(c.terminationYm), `条件変更 ${m.ym}：中途解約より後の条件変更はできません`);
    prevN = n; prevM = mi;
  }
  const finalN = prevN;
  if (L.depMonths !== null && L.depMonths !== undefined) {
    req(Number.isInteger(L.depMonths) && L.depMonths > 0, '償却月数は正の整数です');
    if (s !== null && Number.isInteger(c.termMonths)) req(!(L.depMonths > s + c.termMonths - ms), '償却月数が（適用開始後の）残存リース期間を超える契約（所有権移転・購入オプション行使が合理的に確実）は未対応です');
    req(!mods.length, '償却月数を指定した契約の条件変更は未対応です');
  }
  if (c.terminationYm) {
    const t = idxOr(c.terminationYm);
    req(t !== null, '中途解約年月が不正です');
    if (t !== null && s !== null) req(t >= s && t < s + finalN - 1, '中途解約年月はリース期間の途中である必要があります');
  }
  const r = c.lessor || {};
  req(Number.isFinite(r.assetCost ?? 0) && (r.assetCost ?? 0) >= 0, '貸手資産の取得原価は0以上です');
  req(Number.isFinite(r.ratio ?? 1) && (r.ratio ?? 1) > 0 && (r.ratio ?? 1) <= 1, '貸手資産の按分比率は0超1以下です');
  if ((r.assetCost ?? 0) > 0 && c.assetClass !== 'land') {
    req(Number.isInteger(r.assetLifeMonths) && r.assetLifeMonths > 0, '貸手資産の耐用年数（月数）を入力してください（土地は不要）');
    req(idxOr(r.assetStart) !== null, '貸手資産の取得年月が不正です');
  }
  if (r.termMonths !== null && r.termMonths !== undefined) {
    req(Number.isInteger(r.termMonths) && r.termMonths > 0, '貸手のリース期間（月数）は正の整数です');
    if (Number.isInteger(c.termMonths)) req(r.termMonths <= c.termMonths, '貸手のリース期間は借手のリース期間以下にしてください');
  }
  return e;
}

/** j回目（1始まり）の当初条件の支払額 */
function paymentAmount(c, j) {
  if (j <= (c.freePayments || 0)) return 0;
  let amt = c.payment;
  for (const x of [...(c.steps || [])].sort((a, b) => a.fromPayment - b.fromPayment)) if (j >= x.fromPayment) amt = x.amount;
  return amt;
}

/**
 * k 件目までの条件変更を反映した支払予定（その時点で借手が知っている契約条件）
 * @returns {{N:number, payments:Array<{no,month,t,amount}>}}
 */
export function paymentPlan(c, k) {
  const s = ymToIndex(c.commencement);
  const f = c.frequencyMonths;
  const mods = sortedMods(c).slice(0, k);
  let N = c.termMonths;
  for (const m of mods) N = m.termMonths ?? N;
  const payments = [];
  for (let j = 1; j <= N / f; j++) {
    const month = c.timing === 'advance' ? s + (j - 1) * f : s + j * f - 1;
    const t = c.timing === 'advance' ? month : month + 1;
    let amount = paymentAmount(c, j);
    for (const m of mods) if (ymToIndex(m.ym) <= month && m.payment !== null && m.payment !== undefined) amount = m.payment;
    // 返済スケジュールの手修正（支払月ごとの支払額）
    const ov = (c.paymentOverrides || []).find((x) => x.ym === indexToYm(month));
    if (ov) amount = ov.amount;
    payments.push({ no: j, month, t, amount, overridden: !!ov });
  }
  return { N, payments };
}

/**
 * 月次スケジュールを作成する（計算量は契約月数に比例）。
 * @param {object} c 契約
 * @param {object} pol 会計方針（POL-10 割引率換算・期間内按分、POL-11 端数処理）
 * @param {object} opts { lesseeCompany } 借手会社（適用初年度の方法に使用）
 */
export function buildSchedule(c, pol = {}, opts = {}) {
  const R = (v) => round(v, pol['POL-11'] || 'half_up');
  const s = ymToIndex(c.commencement);
  const f = c.frequencyMonths;
  const L = c.lessee;
  const nominal = pol['POL-10'] !== 'effective';
  const mods = sortedMods(c);
  const plans = [paymentPlan(c, 0)];
  for (let k = 1; k <= mods.length; k++) plans.push(paymentPlan(c, k));
  const finalPlan = plans[plans.length - 1];
  const termIdx = c.terminationYm ? ymToIndex(c.terminationYm) : null;
  const finalEnd = s + finalPlan.N - 1;
  const lastIdx = termIdx ?? finalEnd;
  const penalty = termIdx !== null ? Math.max(0, c.terminationPenalty || 0) : 0;
  const ms = measurementStart(c, opts.lesseeCompany);
  const measStart = ms.start;
  const modStarts = mods.map((m) => ymToIndex(m.ym));
  // 月 m に有効な条件（何件目の条件変更まで反映済みか）
  const planIndexAt = (m) => { let k = 0; for (let i = 0; i < modStarts.length; i++) if (modStarts[i] <= m) k = i + 1; return k; };
  const payInMonth = (m) => {
    if (termIdx !== null && m > termIdx) return 0;
    const p = plans[planIndexAt(m)].payments.find((x) => x.month === m);
    return p ? p.amount : 0;
  };

  // 測定開始（適用開始）以前の条件変更の割引率は使わない（適用時の割引率で測定する）
  const rateFor = (k) => { let r = ms.rate; for (let i = 0; i < k; i++) if (mods[i].rate !== null && mods[i].rate !== undefined && modStarts[i] > measStart) r = mods[i].rate; return r; };
  const rpOf = (rate) => (nominal ? (rate * f) / 12 : Math.pow(1 + rate, f / 12) - 1);
  const segFactorOf = (rp) => (len) => (nominal ? (rp * len) / f : Math.pow(1 + rp, len / f) - 1);

  const lesseeOnBalance = L.model === 'jgaap' || L.model === 'asc842ol';
  // ── 借手の測定区間（フェーズ）：測定開始、以後は条件変更ごと ──
  const phaseStarts = [measStart, ...modStarts.filter((m) => m > measStart)];
  const phases = phaseStarts.map((start, i) => {
    const k = planIndexAt(start);
    const plan = plans[k];
    const rate = rateFor(k);
    const rp = rpOf(rate);
    const seg = segFactorOf(rp);
    const rem = plan.payments.filter((p) => p.month >= start);
    let pv = 0;
    for (let j = rem.length - 1; j >= 0; j--) pv = (pv + rem[j].amount) / (1 + seg(rem[j].t - (j > 0 ? rem[j - 1].t : start)));
    return { idx: i, start, next: i + 1 < phaseStarts.length ? phaseStarts[i + 1] : Infinity, k, plan, rate, rp, seg, rem, pv, end: s + plan.N - 1 };
  });
  for (const ph of phases) {
    let L0 = R(ph.pv);
    if (ph.idx === 0 && ms.source === 'none' && L.liabilityOverride !== null && L.liabilityOverride !== undefined) L0 = L.liabilityOverride;
    ph.L0 = lesseeOnBalance ? L0 : 0;
    const segs = [];
    let B = ph.L0, ta = ph.start;
    for (const p of ph.rem) {
      const len = p.t - ta;
      segs.push({ ta, tb: p.t, base: B, interest: len > 0 ? R(B * ph.seg(len)) : 0, pay: p });
      B = B + segs[segs.length - 1].interest - p.amount;
      ta = p.t;
    }
    ph.finalResidual = ph.rem.length ? B : 0;
    if (ph.next === Infinity && ph.rem.length && B !== 0) {
      for (let j = segs.length - 1; j >= 0; j--) if (segs[j].tb - segs[j].ta > 0) { segs[j].interest -= B; break; }
    }
    let B2 = ph.L0;
    for (const sg of segs) { sg.base = B2; B2 = B2 + sg.interest - sg.pay.amount; sg.after = B2; }
    ph.segs = segs;
    // 月ごとの利息（区間内の按分：名目＝定額、実効＝複利の累計で端数処理）
    ph.monthInt = new Map();
    for (const sg of segs) {
      const len = sg.tb - sg.ta;
      if (len <= 0) continue;
      let prev = 0;
      for (let j = 1; j <= len; j++) {
        const cum = j === len ? sg.interest : nominal ? R((sg.interest * j) / len) : R((sg.interest * (Math.pow(1 + ph.rp, j / f) - 1)) / (Math.pow(1 + ph.rp, len / f) - 1 || 1));
        const m = sg.ta + j - 1;
        ph.monthInt.set(m, (ph.monthInt.get(m) || 0) + cum - prev);
        prev = cum;
      }
    }
  }
  const phaseAt = (m) => { let p = phases[0]; for (const ph of phases) if (ph.start <= m) p = ph; return p; };

  // 使用権資産（フェーズ0）
  const idc = L.model === 'jgaap' && ms.source === 'none' ? L.idc || 0 : 0;
  const ph0 = phases[0];
  let C0 = L.model === 'jgaap' ? ph0.L0 + idc : ph0.L0;
  let dep0 = { accBase: 0, net: C0, from: measStart, months: L.depMonths || ph0.end - measStart + 1 };
  if (ms.retro && L.model === 'jgaap') {
    // 適用開始時に、リース開始時から適用していたかのように測定（割引率は適用開始時のもの）
    const plan0 = plans[planIndexAt(measStart)];
    const seg = segFactorOf(rpOf(ms.rate));
    let pvAll = 0;
    const all = plan0.payments;
    for (let j = all.length - 1; j >= 0; j--) pvAll = (pvAll + all[j].amount) / (1 + seg(all[j].t - (j > 0 ? all[j - 1].t : s)));
    C0 = R(pvAll);
    dep0 = { accBase: 0, net: C0, from: s, months: plan0.N };
  }

  const meta = {
    start: s, end: lastIdx, measStart, measSource: ms.source, retro: ms.retro, N: finalPlan.N, N0: plans[0].N, f, K: finalPlan.N / f, rp: ph0.rp, rate: ph0.rate,
    payments: finalPlan.payments, plans, phases, totalPayments: plans[0].payments.reduce((a, p) => a + p.amount, 0),
    model: L.model, nominal, penalty, L0: ph0.L0, C0, idc, depMonths: dep0.months, segments: ph0.segs, finalResidual: phases[phases.length - 1].finalResidual,
    pvExact: lesseeOnBalance ? ph0.pv : 0, modifications: mods, transferLike: false,
  };
  meta.totalInterest = phases.reduce((a, ph) => a + [...ph.monthInt.entries()].filter(([m]) => m < ph.next && m >= ph.start).reduce((x, [, v]) => x + v, 0), 0);

  // ── 貸手の収益認識区間：開始、条件変更（新たなリース）、貸手のリース期間の終了 ──
  const r = c.lessor || {};
  const TRend = r.termMonths ? s + r.termMonths - 1 : Infinity;
  const ratio = r.ratio ?? 1;
  const depreciable = r.assetCost > 0 && c.assetClass !== 'land' && r.assetLifeMonths > 0;
  const aStart = depreciable ? ymToIndex(r.assetStart) : null;
  const lessorAccAt = (m) => {
    if (!depreciable) return 0;
    const k = Math.min(Math.max(m - aStart + 1, 0), r.assetLifeMonths);
    return R((r.assetCost * k) / r.assetLifeMonths);
  };

  const firstIdx = Math.min(s, measStart);
  const months = [];
  let prevL = 0, prevCost = 0, prevAcc = 0, prevIdcAcc = 0, prevX = 0, prevR = 0;
  let prevLessorAcc = lessorAccAt(firstIdx - 1);
  let curPh = null, dep = dep0;
  let idcDep = { base: 0, net: idc, from: measStart, months: dep0.months };
  // 費用（ASC842・簡便法）と貸手収益の区間
  let costSeg = null, incSeg = null;
  const sumPay = (plan, a, b) => plan.payments.filter((p) => p.month >= a && p.month <= b).reduce((x, p) => x + p.amount, 0);
  let terminated = false;

  for (let m = firstIdx; m <= lastIdx; m++) {
    const rec = { m, ym: indexToYm(m), lessee: {}, lessor: {} };
    const le = rec.lessee, lo = rec.lessor;
    const k = planIndexAt(m);
    const plan = plans[k];
    const pay = payInMonth(m);
    const active = m >= measStart && m >= s;
    le.active = active;
    le.pay = active ? pay : 0;
    lo.cash = m >= s ? pay : 0;

    // 貸手の収益区間の切替
    const modHere = modStarts.includes(m);
    if (m === s || modHere || (incSeg && m === incSeg.end + 1)) {
      const endPlanned = Math.min(TRend >= m ? TRend : Infinity, s + plan.N - 1);
      incSeg = { start: m, end: endPlanned, total: sumPay(plan, m, endPlanned) - (m === s ? 0 : prevR), prevCum: 0 };
    }

    if (lesseeOnBalance && active) {
      const ph = phaseAt(m);
      if (curPh !== ph) {
        if (ph.idx === 0) {
          le.commence = { L0: ph.L0, C0, idc, retroAcc: ms.retro ? R((C0 * Math.min(m - s, dep0.months)) / dep0.months) : 0 };
          prevL = ph.L0; prevCost = C0;
          prevAcc = le.commence.retroAcc; prevIdcAcc = 0;
          if (L.model === 'asc842ol') { prevCost = ph.L0; prevAcc = 0; costSeg = { start: s, months: plans[0].N, total: plans[0].payments.reduce((a, p) => a + p.amount, 0), prevCum: 0 }; costSeg.prevCum = R((costSeg.total * Math.max(m - s, 0)) / costSeg.months); }
        } else {
          // 条件変更：リース負債を再測定し、使用権資産を同額調整（リースの範囲が縮小する場合は一部取崩し・損益）
          const oldEnd = curPh.end, newEnd = ph.end;
          let Lbefore = prevL, cost = prevCost, acc = prevAcc, gain = 0, costOut = 0, accOut = 0, Lpart = 0;
          if (newEnd < oldEnd && L.model === 'jgaap') {
            const keep = (newEnd - m + 1) / (oldEnd - m + 1);
            costOut = R(cost * (1 - keep)); accOut = R(acc * (1 - keep)); Lpart = R(Lbefore * (1 - keep));
            gain = Lpart - (costOut - accOut);
            cost -= costOut; acc -= accOut; Lbefore -= Lpart;
          }
          const dL = ph.L0 - Lbefore;
          cost += dL;
          le.remeasure = { ym: indexToYm(m), Lold: prevL, Lnew: ph.L0, dL, costOut, accOut, Lpart, gain, rate: ph.rate };
          prevL = ph.L0; prevCost = cost; prevAcc = acc;
          if (L.model === 'jgaap') {
            dep = { accBase: acc, net: cost - acc, from: m, months: newEnd - m + 1 };
            if (idc) idcDep = { base: prevIdcAcc, net: idc - prevIdcAcc, from: m, months: newEnd - m + 1 };
          }
          if (L.model === 'asc842ol') costSeg = { start: m, months: newEnd - m + 1, total: sumPay(ph.plan, m, newEnd) + (prevCost - prevL), prevCum: 0 };
        }
        curPh = ph;
      }
      const mi = m < ph.next ? ph.monthInt.get(m) || 0 : 0;
      if (L.model === 'jgaap') { le.int = mi; le.accr = 0; } else { le.int = 0; le.accr = mi; }
      le.L_open = le.commence ? 0 : prevL;
      le.L_end = prevL + mi - le.pay;
      if (L.model === 'jgaap') {
        const kk = Math.min(m - dep.from + 1, dep.months);
        const acc = dep.accBase + R((dep.net * kk) / dep.months);
        le.dep = acc - prevAcc;
        le.acc_end = acc;
        le.cost_end = prevCost;
        const idcAcc = idc > 0 ? idcDep.base + R((idcDep.net * Math.min(m - idcDep.from + 1, idcDep.months)) / idcDep.months) : 0;
        le.idcDep = idcAcc - prevIdcAcc;
        le.idcAcc_end = idcAcc;
        prevIdcAcc = idcAcc;
      } else {
        // ASC842 オペレーティング・リース：単一リース費用（区間内は定額）、使用権資産は「費用−利息相当」で償却
        const cum = R((costSeg.total * (m - costSeg.start + 1)) / costSeg.months);
        le.cost = cum - costSeg.prevCum;
        costSeg.prevCum = cum;
        le.cost_end = prevCost - (le.cost - mi);
        le.acc_end = 0;
        le.dep = 0;
      }
      le.X_end = 0;
    } else if (L.model === 'offbalance' && active) {
      if (m === s || modHere) {
        const end = s + plan.N - 1;
        costSeg = { start: m, months: end - m + 1, total: sumPay(plan, m, end) - (m === s ? 0 : prevX), prevCum: 0 };
      }
      const cum = R((costSeg.total * (m - costSeg.start + 1)) / costSeg.months);
      le.cost = cum - costSeg.prevCum;
      costSeg.prevCum = cum;
      Object.assign(le, { X_end: prevX + le.cost - le.pay, L_end: 0, L_open: 0, int: 0, accr: 0, dep: 0, cost_end: 0, acc_end: 0 });
    } else {
      Object.assign(le, { L_end: 0, L_open: 0, int: 0, accr: 0, dep: 0, cost_end: 0, acc_end: 0, X_end: 0, cost: 0 });
    }

    // 貸手：受取リース料（区間内は定額法）
    if (m >= s) {
      const cum = R((incSeg.total * (m - incSeg.start + 1)) / (incSeg.end - incSeg.start + 1));
      lo.inc = cum - incSeg.prevCum;
      incSeg.prevCum = cum;
    } else lo.inc = 0;
    lo.R_end = prevR + lo.inc - lo.cash;

    // 貸手資産の減価償却（按分比率適用前の全体額。土地は非償却）
    const accL = lessorAccAt(m);
    lo.assetDep = accL - prevLessorAcc;
    lo.assetAcc_end = accL;
    lo.assetCost = r.assetCost > 0 ? r.assetCost : 0;
    prevLessorAcc = accL;
    lo.ratio = ratio;

    // 中途解約・満了
    const isTerm = termIdx !== null && m === termIdx;
    const isExpiry = termIdx === null && m === finalEnd;
    if (isTerm || isExpiry) {
      const rouNet = (le.cost_end || 0) - (le.acc_end || 0);
      le.term = {
        kind: isTerm ? 'termination' : 'expiry',
        L: le.L_end || 0, cost: le.cost_end || 0, acc: le.acc_end || 0, X: le.X_end || 0, idcAcc: le.idcAcc_end || 0,
        gain: (le.L_end || 0) + (le.X_end || 0) - rouNet,
      };
      if (isTerm) {
        lo.termAdj = -lo.R_end;
        lo.inc += lo.termAdj;
        lo.R_end = 0;
        if (penalty) { le.penalty = penalty; lo.penalty = penalty; }
      }
      le.L_end = 0; le.cost_end = 0; le.acc_end = 0; le.X_end = 0; le.idcAcc_end = 0;
      terminated = true;
    }
    prevL = le.L_end || 0;
    prevCost = le.cost_end || 0;
    prevAcc = le.acc_end || 0;
    prevX = le.X_end || 0;
    prevR = lo.R_end || 0;
    months.push(rec);
  }
  Object.assign(meta, { terminated, firstIdx, lastIdx, finalEnd });
  return { contract: c, meta, months, byIndex: (i) => (i >= firstIdx && i <= lastIdx ? months[i - firstIdx] : null) };
}

/** 月末時点で有効な借手の測定区間（条件変更前の決算日では、その時点の契約条件で区分する） */
export function phaseAtIndex(sched, idx) {
  let p = sched.meta.phases[0];
  for (const ph of sched.meta.phases) if (ph.start <= idx) p = ph;
  return p;
}

/**
 * 月末時点の借手リース負債の流動部分（決算日後1年以内に支払われるリース料に対応する元本）
 * = 期末残高 − 12か月以内の最後の支払直後の残高（その時点の契約条件による）
 */
export function currentPortion(sched, endIdx) {
  const { meta } = sched;
  if (meta.model === 'offbalance') return 0;
  const rec = sched.byIndex(endIdx);
  if (!rec || !rec.lessee.active) return 0;
  const Lend = rec.lessee.L_end;
  if (!Lend) return 0;
  const within = phaseAtIndex(sched, endIdx).segs.filter((sg) => sg.pay.month > endIdx && sg.pay.month <= endIdx + 12);
  if (!within.length) return 0;
  // 1年以内の支払が0（フリーレント等）の場合に利息の増加で負にならないよう、0〜期末残高の範囲に収める
  return Math.min(Lend, Math.max(0, Lend - within[within.length - 1].after));
}

/** 期間 [startIdx, endIdx] の合計値と期首・期末残高 */
export function periodSummary(sched, startIdx, endIdx) {
  const before = sched.months.filter((x) => x.m < startIdx);
  const inP = sched.months.filter((x) => x.m >= startIdx && x.m <= endIdx);
  const lastBefore = before[before.length - 1];
  const bal = (rec) => ({
    L: rec ? rec.lessee.L_end || 0 : 0,
    cost: rec ? rec.lessee.cost_end || 0 : 0,
    acc: rec ? rec.lessee.acc_end || 0 : 0,
    X: rec ? rec.lessee.X_end || 0 : 0,
    R: rec ? rec.lessor.R_end || 0 : 0,
    idcAcc: rec ? rec.lessee.idcAcc_end || 0 : 0,
  });
  const sm = (fn) => inP.reduce((a, x) => a + (fn(x) || 0), 0);
  const ended = sched.months.length && sched.months[sched.months.length - 1].m < startIdx;
  return {
    open: bal(lastBefore),
    close: ended ? bal(null) : bal(inP.length ? inP[inP.length - 1] : lastBefore),
    int: sm((x) => x.lessee.int),
    accr: sm((x) => x.lessee.accr),
    pay: sm((x) => x.lessee.pay),
    dep: sm((x) => x.lessee.dep),
    cost: sm((x) => x.lessee.cost),
    idcDep: sm((x) => x.lessee.idcDep),
    inc: sm((x) => x.lessor.inc),
    cash: sm((x) => x.lessor.cash),
    assetDep: sm((x) => x.lessor.assetDep),
    remeasureL: sm((x) => (x.lessee.remeasure ? x.lessee.remeasure.Lnew - x.lessee.remeasure.Lold : 0)),
    remeasureCost: sm((x) => (x.lessee.remeasure ? x.lessee.remeasure.dL - x.lessee.remeasure.costOut : 0)),
    remeasureAcc: sm((x) => (x.lessee.remeasure ? -x.lessee.remeasure.accOut : 0)),
    modGain: sm((x) => (x.lessee.remeasure ? x.lessee.remeasure.gain : 0)),
    commence: inP.find((x) => x.lessee.commence)?.lessee.commence || null,
    term: inP.find((x) => x.lessee.term)?.lessee.term || null,
    months: inP.length,
    activeMonths: inP.filter((x) => x.lessee.active).length,
    lastRec: inP[inP.length - 1] || null,
  };
}
