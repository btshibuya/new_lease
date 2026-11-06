// 連結精算表・連結CF消去データ・満期分析（共通部品）
import { accountLabel, ACCOUNTS, metaOf } from './accounts.js';
import { round } from './util.js';
import { phaseAtIndex } from './schedule.js';

/**
 * 個別財務諸表上のグループ内リース関連残高（アプリの計算値）。借方＋。
 * 借手が旧科目名を使う会社は旧科目で、流動区分しない会社は全額固定で表示する。
 */
export function individualLines(result, companies, pol) {
  const { contract: c, ps, cur, sched } = result;
  const co = Object.fromEntries(companies.map((x) => [x.code, x]));
  const lessee = co[c.lesseeCo] || {};
  const meta = metaOf(c);
  const R = (v) => round(v, pol['POL-11'] || 'half_up');
  const out = [];
  const add = (acc, company, amt, basis) => { if (amt) out.push({ acc, co: company, amt, meta, basis }); };
  const cl = ps.close;
  const legacy = !!lessee.legacyAccounts;
  const model = sched.meta.model;
  const pS = result.periodStart, pE = result.periodEnd;
  if (model !== 'offbalance') {
    const curAmt = lessee.splitsCurrent === false ? 0 : cur;
    if (legacy) {
      add('LEGACY_ASSET', c.lesseeCo, cl.cost, '借手個別：リース資産');
      add('LEGACY_ACC', c.lesseeCo, -cl.acc, '借手個別：減価償却累計額');
      add('LEGACY_LIAB_C', c.lesseeCo, -curAmt, '借手個別：リース債務（流動）');
      add('LEGACY_LIAB', c.lesseeCo, -(cl.L - curAmt), '借手個別：リース債務（固定）');
    } else {
      add('ROU_COST', c.lesseeCo, cl.cost, '借手個別：使用権資産');
      add('ROU_ACC', c.lesseeCo, -cl.acc, '借手個別：減価償却累計額');
      add('LL_C', c.lesseeCo, -curAmt, '借手個別：リース負債（流動）');
      add('LL_NC', c.lesseeCo, -(cl.L - curAmt), '借手個別：リース負債（固定）');
    }
  }
  add('LEASE_ACCRUED', c.lesseeCo, -cl.X, '借手個別：未払リース料');
  add('DEP_ROU', c.lesseeCo, ps.dep, '借手個別：減価償却費');
  add('INT', c.lesseeCo, ps.int, '借手個別：支払利息');
  const inP = sched.months.filter((x) => x.m >= pS && x.m <= pE);
  const preT = inP.filter((x) => !x.lessee.active).reduce((a, x) => a + x.lessor.cash, 0);
  add('PRE_RENT', c.lesseeCo, preT, '借手個別：適用開始前の支払リース料');
  add(model === 'asc842ol' ? 'ASC_COST' : 'SHORT_COST', c.lesseeCo, ps.cost, '借手個別：リース費用');
  if (ps.term && ps.term.gain) add('TERM_GAIN', c.lesseeCo, -ps.term.gain, '借手個別：解約損益');
  if (ps.modGain) add('MOD_GAIN', c.lesseeCo, -ps.modGain, '借手個別：条件変更損益');
  const pen = inP.reduce((a, x) => a + (x.lessee.penalty || 0), 0);
  add('PENALTY_EXP', c.lesseeCo, pen, '借手個別：支払違約金');
  add('PENALTY_INC', c.lessorCo, -pen, '貸手個別：受取違約金');
  // 貸手
  add('LEASE_INC', c.lessorCo, -ps.inc, '貸手個別：受取リース料');
  add('ACCR_INC', c.lessorCo, cl.R, '貸手個別：未収リース料（定額法）');
  const r = c.lessor || {};
  if (r.assetCost > 0) {
    const ratio = r.ratio ?? 1;
    const endRec = sched.byIndex(pE);
    if (endRec && !endRec.lessee.term) {
      add('RENTAL_ASSET', c.lessorCo, R(r.assetCost * ratio), '貸手個別：賃貸資産（按分後）');
      add('RENTAL_ACC', c.lessorCo, -R(endRec.lessor.assetAcc_end * ratio), '貸手個別：減価償却累計額（按分後）');
    }
    const act = inP.filter((x) => x.m >= sched.meta.start);
    add('RENTAL_DEP', c.lessorCo, R(act.reduce((a, x) => a + (x.lessor.assetDep || 0), 0) * ratio), '貸手個別：減価償却費（リース期間分・按分後）');
  }
  return out;
}

/** 連結精算表（グループ内リース関連科目） */
export function worksheet(gen, companies, pol, names, period) {
  const rows = new Map();
  const key = (l) => accountLabel(l, pol, names);
  const get = (l) => {
    const k = key(l);
    // items：計算の確認（内訳）用に、どの契約・仕訳から来た金額かを保持する
    if (!rows.has(k)) rows.set(k, { label: k, acc: l.acc, meta: l.meta, type: ACCOUNTS[l.acc]?.type, lessee: 0, lessor: 0, ind: 0, con: 0, items: [] });
    return rows.get(k);
  };
  for (const r of gen.results) {
    for (const l of individualLines(r, companies, pol)) {
      const row = get(l);
      const col = ACCOUNTS[l.acc]?.side === 'R' ? 'lessor' : 'lessee';
      row[col] += l.amt;
      row.items.push({ col, contract: r.contract.id, co: l.co, src: '個別（アプリの計算値）', amt: l.amt, basis: l.basis });
    }
  }
  for (const j of gen.journals) {
    for (const l of j.lines) {
      const row = get(l);
      const col = j.kind === 'IND' ? 'ind' : 'con';
      row[col] += l.amt;
      row.items.push({ col, contract: j.contractId, co: l.co, src: `${j.tpl} ${j.title}`, amt: l.amt, basis: (l.bases || [])[0] || '' });
    }
  }
  const out = [...rows.values()].map((r) => ({ ...r, simple: r.lessee + r.lessor, consol: r.lessee + r.lessor + r.ind + r.con }));
  const order = Object.keys(ACCOUNTS);
  out.sort((a, b) => (a.type === b.type ? order.indexOf(a.acc) - order.indexOf(b.acc) : a.type === 'BS' ? -1 : 1));
  return out;
}

/** グループ内で消去後に0となるべき科目 */
export const MUST_BE_ZERO = ['ROU_COST', 'ROU_ACC', 'LL_C', 'LL_NC', 'LEASE_ACCRUED', 'DEP_ROU', 'INT', 'ASC_COST', 'SHORT_COST', 'PRE_RENT', 'LEASE_INC', 'ACCR_INC', 'PENALTY_INC', 'PENALTY_EXP', 'MOD_GAIN', 'LEGACY_ASSET', 'LEGACY_ACC', 'LEGACY_LIAB', 'LEGACY_LIAB_C'];

/** 連結CF計算書の消去データ */
export function cashFlowEliminations(gen, pol, period) {
  let repay = 0, interestPaid = 0, opLease = 0, receipts = 0, penalty = 0;
  for (const r of gen.results) {
    const { sched } = r;
    const term = r.contract.terminationYm ? sched.meta.lastIdx : null;
    for (const rec of sched.months) {
      if (rec.m < period.start || rec.m > period.end) continue;
      receipts += rec.lessor.cash;
      penalty += rec.lessee.penalty || 0;
      if (!rec.lessee.active || sched.meta.model !== 'jgaap') opLease += rec.lessor.cash;
    }
    if (sched.meta.model === 'jgaap') {
      // 未払利息を繰り越し、支払額はまず未払利息に充当する（フリーレント期間の利息は次の支払で支払われる）
      let unpaid = 0;
      const adv = r.contract.timing === 'advance';
      for (const x of sched.months) {
        if (!x.lessee.active) continue;
        if (x.m > period.end) break;
        const p = x.lessee.pay || 0;
        let ip = 0;
        if (adv && p) { ip = Math.min(unpaid, p); unpaid -= ip; }
        unpaid += x.lessee.int || 0;
        if (!adv && p) { ip = Math.min(unpaid, p); unpaid -= ip; }
        if (x.lessee.term) unpaid = 0;
        if (x.m >= period.start && p) { interestPaid += ip; repay += p - ip; }
      }
    }
  }
  return {
    items: [
      { section: '財務活動', label: 'リース負債の返済による支出（借手）', amount: -repay, elim: repay },
      { section: pol['POL-09'] === 'financing' ? '財務活動' : '営業活動', label: '利息の支払額（借手・リース負債分）', amount: -interestPaid, elim: interestPaid },
      { section: '営業活動', label: 'リース料の支払（借手：短期・少額、ASC842オペ、適用開始前）', amount: -opLease, elim: opLease },
      { section: '営業活動', label: '解約違約金の支払（借手）', amount: -penalty, elim: penalty },
      { section: '営業活動', label: 'リース料・違約金の受取（貸手：営業収入）', amount: receipts + penalty, elim: -(receipts + penalty) },
    ],
    check: repay + interestPaid + opLease - receipts,
    totals: { repay, interestPaid, opLease, receipts, penalty },
  };
}

/** 満期分析（割引前の将来リース料、グループ内消去額） */
export function maturity(gen, period) {
  const buckets = [
    { label: '1年以内', from: 1, to: 12 },
    { label: '1年超2年以内', from: 13, to: 24 },
    { label: '2年超3年以内', from: 25, to: 36 },
    { label: '3年超4年以内', from: 37, to: 48 },
    { label: '4年超5年以内', from: 49, to: 60 },
    { label: '5年超', from: 61, to: 1e9 },
  ];
  const vals = buckets.map((b) => ({ ...b, amount: 0, principal: 0 }));
  for (const r of gen.results) {
    const { sched } = r;
    if (sched.meta.model === 'offbalance') continue;
    const term = r.contract.terminationYm ? sched.meta.lastIdx : null;
    const endRec = sched.byIndex(period.end);
    if (!endRec || !endRec.lessee.active || endRec.lessee.term) continue;
    let prevAfter = endRec.lessee.L_end;
    const ph = phaseAtIndex(sched, period.end);
    for (const sg of ph.segs) {
      const p = sg.pay;
      if (p.month <= period.end) continue; // 流動区分（currentPortion）と同じく、決算日時点の契約上の支払予定で区分する
      const d = p.month - period.end;
      const b = vals.find((x) => d >= x.from && d <= x.to);
      // 元本ベース：その支払で減少する残高（期末残高からの減少分）
      const principal = Math.max(0, prevAfter - sg.after);
      prevAfter = sg.after;
      if (b) { b.amount += p.amount; b.principal += principal; }
    }
  }
  return vals;
}

/**
 * スケジュールから直接求める会社別の純資産修正額（仕訳とは別経路の検証用）
 * 借手：リース負債＋未払リース料−使用権資産簿価（初期直接費用を資産計上する方針では、その未償却残高を除く）
 * 貸手：−未収リース料
 */
export function eFromSchedule(sched, idx, pol) {
  const c = sched.contract;
  const rec = idx < sched.meta.firstIdx ? null : sched.byIndex(Math.min(idx, sched.meta.lastIdx));
  if (!rec || (idx > sched.meta.lastIdx)) return { [c.lesseeCo]: 0, [c.lessorCo]: 0 };
  const le = rec.lessee;
  let eL = (le.L_end || 0) + (le.X_end || 0) - ((le.cost_end || 0) - (le.acc_end || 0));
  if (pol['POL-07'] === 'capitalize' && le.active && !le.term && sched.meta.idc) eL += sched.meta.idc - (le.idcAcc_end || 0);
  return { [c.lesseeCo]: eL, [c.lessorCo]: -(rec.lessor.R_end || 0) };
}

/**
 * 契約の年度別サマリー（要件定義書 第10章の表と同じ構成）
 * @returns rows: { label, openL, pay, int, principal, closeL, cur, rouNet, dep, lesseeExp, inc, diff, cumE }
 */
export function contractYearly(sched, periods, currentPortionFn) {
  const rows = [];
  for (const p of periods) {
    const inP = sched.months.filter((x) => x.m >= p.start && x.m <= p.end);
    if (!inP.length) continue;
    const before = sched.months.filter((x) => x.m < p.start);
    const lb = before[before.length - 1];
    const le = inP[inP.length - 1];
    const sum = (f) => inP.reduce((a, x) => a + (f(x) || 0), 0);
    const openL = lb ? lb.lessee.L_end || 0 : 0;
    const newL = inP.find((x) => x.lessee.commence)?.lessee.commence.L0 || 0;
    const remL = inP.reduce((a, x) => a + (x.lessee.remeasure ? x.lessee.remeasure.Lnew - x.lessee.remeasure.Lold : 0), 0);
    const int = sum((x) => x.lessee.int) + sum((x) => x.lessee.accr);
    const pay = sum((x) => x.lessee.pay);
    const term = inP.find((x) => x.lessee.term)?.lessee.term;
    const closeL = le.lessee.L_end || 0;
    const rouNet = (le.lessee.cost_end || 0) - (le.lessee.acc_end || 0);
    const dep = sum((x) => x.lessee.dep);
    const lesseeExp = dep + int + sum((x) => x.lessee.cost) + sum((x) => (!x.lessee.active ? x.lessor.cash : 0)) - (sched.meta.model === 'asc842ol' ? sum((x) => x.lessee.accr) : 0);
    const inc = sum((x) => x.lessor.inc);
    const cumE = closeL + (le.lessee.X_end || 0) - rouNet - (le.lessor.R_end || 0);
    rows.push({
      label: p.label, start: p.start, end: p.end, openL, newL, remL, pay, int, principal: pay - int, closeL,
      cur: currentPortionFn ? currentPortionFn(sched, p.end) : 0,
      rouNet, dep, lesseeExp, inc, diff: lesseeExp - inc, cumE, termGain: term ? term.gain : 0,
      idc: inP.find((x) => x.lessee.commence)?.lessee.commence.idc || 0,
      // 当期の連結損益への影響（初期直接費用を連結上費用処理する場合）＝ 当期差 − 解約益 − 初期直接費用
      plEffect: lesseeExp - inc - (term ? term.gain : 0) - (inP.find((x) => x.lessee.commence)?.lessee.commence.idc || 0),
      R: le.lessor.R_end || 0, X: le.lessee.X_end || 0,
    });
  }
  return rows;
}

/**
 * 注記（新リース会計基準）に含まれるグループ内リースの金額。
 * 各社の個別の注記にはグループ内リースが含まれるが、連結の注記では除く（グループ内リースは連結上存在しない）。
 * ここでは「各社の注記に含まれるグループ内リース分」を契約別に求める。連結注記の調整額はその符号を反対にした額。
 * 根拠の status：confirmed＝公表資料で確認済み、check＝項番号・要否を基準の原文で確認する必要があるもの。
 * @returns {{ items: object[], maturity: object[] }}
 */
export function disclosures(gen, period, pol) {
  const R = (v) => round(v, pol['POL-11'] || 'half_up');
  const CLS = { building: '建物', machine: '機械装置', vehicle: '車両運搬具', tool: '工具器具備品', land: '土地', other: 'その他' };
  const items = [];
  const item = (o) => { const it = { ...o, rows: [] }; items.push(it); return it; };
  const L = {
    nbv: item({ id: 'N-L1', side: '借手', title: '使用権資産の帳簿価額（原資産の表示科目ごと）', when: '期末', byClass: true, basis: '使用権資産を区分表示しない場合は、含まれる科目と金額を注記。区分表示する場合も、原資産を自ら所有していたと仮定した表示科目ごとの内訳が求められる', status: 'check' }),
    add: item({ id: 'N-L2', side: '借手', title: '使用権資産の増加額', when: '当期', basis: '当期及び翌期以降のリースの金額を理解するための情報。適用初年度の経過措置で計上した額は含めない', status: 'check' }),
    dep: item({ id: 'N-L3', side: '借手', title: '使用権資産の減価償却費（原資産の表示科目ごと）', when: '当期', byClass: true, basis: '借手のリース活動の性質を理解するための情報として、使用権資産の減価償却費の注記が求められる', status: 'confirmed' }),
    int: item({ id: 'N-L4', side: '借手', title: 'リース負債に係る利息費用', when: '当期', basis: 'リースが経営成績に与える影響を理解するための情報（要否は原文で確認）', status: 'check' }),
    short: item({ id: 'N-L5', side: '借手', title: '短期リース・少額リース等に係る費用', when: '当期', basis: '使用権資産・リース負債を計上しない簡便的な取扱いを適用したリースの費用', status: 'check' }),
    cash: item({ id: 'N-L6', side: '借手', title: 'リースに係るキャッシュ・アウトフローの合計額', when: '当期', basis: '短期・少額リース等や解約違約金を含む、借手の支払額の合計', status: 'check' }),
  };
  const Rr = {
    inc: item({ id: 'N-R1', side: '貸手', title: 'オペレーティング・リースによる収益', when: '当期', basis: 'リースが貸手の経営成績に与える影響を理解するための情報', status: 'check' }),
    re: item({ id: 'N-R2', side: '貸手', title: '賃貸等不動産の期末簿価（グループ会社への賃貸分）', when: '期末', basis: '連結上は自己使用の資産となるため、連結の賃貸等不動産の注記から除く（企業会計基準第20号・適用指針第23号）', status: 'check' }),
    reInc: item({ id: 'N-R3', side: '貸手', title: '賃貸等不動産の賃貸損益（グループ会社への賃貸分）', when: '当期', basis: '賃貸収益−減価償却費。連結の賃貸等不動産の注記から除く', status: 'check' }),
  };
  const buckets = [
    { label: '1年以内', from: 1, to: 12 }, { label: '1年超2年以内', from: 13, to: 24 }, { label: '2年超3年以内', from: 25, to: 36 },
    { label: '3年超4年以内', from: 37, to: 48 }, { label: '4年超5年以内', from: 49, to: 60 }, { label: '5年超', from: 61, to: 1e9 },
  ];
  const recv = buckets.map((b) => ({ ...b, amount: 0, rows: [] }));
  for (const r of gen.results) {
    const { contract: c, ps, sched } = r;
    const model = sched.meta.model;
    const cls = CLS[c.assetClass] || 'その他';
    const push = (it, co, amt, note = '') => { if (amt) it.rows.push({ contract: c.id, name: c.name, co, cls, amt, note }); };
    const endRec = sched.byIndex(period.end);
    const alive = endRec && !endRec.lessee.term;
    const inP = sched.months.filter((x) => x.m >= period.start && x.m <= period.end);
    if (model !== 'offbalance') {
      if (alive) push(L.nbv, c.lesseeCo, ps.close.cost - ps.close.acc);
      const cm = ps.commence && sched.meta.measSource === 'none' ? (model === 'asc842ol' ? ps.commence.L0 : ps.commence.C0) : 0;
      const rm = inP.reduce((a, x) => a + (x.lessee.remeasure ? Math.max(0, x.lessee.remeasure.dL) : 0), 0);
      push(L.add, c.lesseeCo, cm + rm, rm ? `条件変更による増加 ${rm} を含む` : '');
      push(L.dep, c.lesseeCo, ps.dep);
      push(L.int, c.lesseeCo, ps.int + (model === 'asc842ol' ? 0 : ps.accr || 0));
    } else push(L.short, c.lesseeCo, ps.cost);
    const pen = inP.reduce((a, x) => a + (x.lessee.penalty || 0), 0);
    push(L.cash, c.lesseeCo, inP.reduce((a, x) => a + (x.lessor.cash || 0), 0) + pen, pen ? `解約違約金 ${pen} を含む` : '');
    push(Rr.inc, c.lessorCo, ps.inc);
    const lr = c.lessor || {};
    if (lr.assetCost > 0 && ['building', 'land'].includes(c.assetClass)) {
      const ratio = lr.ratio ?? 1;
      if (alive) push(Rr.re, c.lessorCo, R(lr.assetCost * ratio) - R((endRec.lessor.assetAcc_end || 0) * ratio));
      const dep = R(inP.filter((x) => x.m >= sched.meta.start).reduce((a, x) => a + (x.lessor.assetDep || 0), 0) * ratio);
      push(Rr.reInc, c.lessorCo, ps.inc - dep, `賃貸収益 ${ps.inc} − 減価償却費 ${dep}`);
    }
    // 貸手：将来の受取リース料（決算日後、1年ごと5年以内＋5年超）
    if (alive) {
      for (const x of sched.months) {
        if (x.m <= period.end || !x.lessor.cash) continue;
        const b = recv.find((y) => x.m - period.end >= y.from && x.m - period.end <= y.to);
        if (b) { b.amount += x.lessor.cash; const row = b.rows.find((z) => z.contract === c.id); if (row) row.amt += x.lessor.cash; else b.rows.push({ contract: c.id, name: c.name, co: c.lessorCo, amt: x.lessor.cash }); }
      }
    }
  }
  for (const it of items) it.amount = it.rows.reduce((a, x) => a + x.amt, 0);
  // 借手：リース負債の満期分析（割引前）と元本の返済予定額
  const lm = maturity(gen, period);
  return {
    items,
    maturity: buckets.map((b, i) => ({ label: b.label, lesseeAmount: lm[i].amount, lesseePrincipal: lm[i].principal, lessorReceipts: recv[i].amount, lessorRows: recv[i].rows })),
  };
}
