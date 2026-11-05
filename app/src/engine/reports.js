// 連結精算表・連結CF消去データ・満期分析（共通部品）
import { accountLabel, ACCOUNTS } from './accounts.js';
import { round } from './util.js';

function metaOf(c) {
  return { contractId: c.id, assetClass: c.assetClass, lesseeDept: c.lessee?.dept, lessorIncClass: c.lessor?.incClass || 'sales', lessorDepClass: c.lessor?.depClass || 'cogs' };
}

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
  if (model !== 'offbalance') {
    const curAmt = lessee.splitsCurrent === false ? 0 : cur;
    if (legacy) {
      add('LEGACY_ASSET', c.lesseeCo, cl.cost, '借手個別：リース資産');
      add('LEGACY_ACC', c.lesseeCo, -cl.acc, '借手個別：減価償却累計額');
      add('LEGACY_LIAB', c.lesseeCo, -cl.L, '借手個別：リース債務');
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
  // 適用開始前（旧基準）の支払リース料・簡便法/ASC842の単一費用
  const preT = sched.months.filter((x) => x.m >= result.periodStart && x.m <= result.periodEnd && !x.lessee.active).reduce((a, x) => a + x.lessor.cash, 0);
  add('LEASE_COST', c.lesseeCo, ps.cost + preT, '借手個別：リース費用');
  if (ps.term && ps.term.gain) add('TERM_GAIN', c.lesseeCo, -ps.term.gain, '借手個別：解約損益');
  if (pol['POL-07'] === 'capitalize') {
    /* 個別では初期直接費用は使用権資産に含まれている */
  }
  // 貸手
  add('LEASE_INC', c.lessorCo, -ps.inc, '貸手個別：受取リース料');
  add('ACCR_INC', c.lessorCo, cl.R, '貸手個別：未収リース料（定額法）');
  const r = c.lessor || {};
  if (r.assetCost > 0) {
    const ratio = r.ratio ?? 1;
    const endRec = ps.lastRec;
    const ongoing = result.periodEnd >= sched.meta.start && result.periodEnd <= sched.meta.lastIdx && !(endRec && endRec.lessee.term);
    if (ongoing && endRec) {
      add('RENTAL_ASSET', c.lessorCo, R(r.assetCost * ratio), '貸手個別：賃貸資産（按分後）');
      add('RENTAL_ACC', c.lessorCo, -R(endRec.lessor.assetAcc_end * ratio), '貸手個別：減価償却累計額（按分後）');
    }
    const act = sched.months.filter((x) => x.m >= result.periodStart && x.m <= result.periodEnd && x.m >= sched.meta.start);
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
    if (!rows.has(k)) rows.set(k, { label: k, acc: l.acc, type: ACCOUNTS[l.acc]?.type, lessee: 0, lessor: 0, ind: 0, con: 0 });
    return rows.get(k);
  };
  for (const r of gen.results) {
    r.periodStart = period.start;
    r.periodEnd = period.end;
    for (const l of individualLines(r, companies, pol)) {
      const row = get(l);
      if (ACCOUNTS[l.acc]?.side === 'R') row.lessor += l.amt;
      else row.lessee += l.amt;
    }
  }
  for (const j of gen.journals) {
    for (const l of j.lines) {
      const row = get(l);
      if (j.kind === 'IND') row.ind += l.amt;
      else row.con += l.amt;
    }
  }
  const out = [...rows.values()].map((r) => ({ ...r, simple: r.lessee + r.lessor, consol: r.lessee + r.lessor + r.ind + r.con }));
  const order = Object.keys(ACCOUNTS);
  out.sort((a, b) => (a.type === b.type ? order.indexOf(a.acc) - order.indexOf(b.acc) : a.type === 'BS' ? -1 : 1));
  return out;
}

/** グループ内で消去後に0となるべき科目 */
export const MUST_BE_ZERO = ['ROU_COST', 'ROU_ACC', 'LL_C', 'LL_NC', 'LEASE_ACCRUED', 'DEP_ROU', 'INT', 'LEASE_COST', 'LEASE_INC', 'ACCR_INC', 'LEGACY_ASSET', 'LEGACY_ACC', 'LEGACY_LIAB'];

/** 連結CF計算書の消去データ */
export function cashFlowEliminations(gen, pol, period) {
  let repay = 0, interestPaid = 0, opLease = 0, receipts = 0;
  for (const r of gen.results) {
    const { sched } = r;
    const c = r.contract;
    const term = c.terminationYm ? sched.meta.lastIdx : null;
    for (const rec of sched.months) {
      if (rec.m < period.start || rec.m > period.end) continue;
      receipts += rec.lessor.cash;
      if (!rec.lessee.active || sched.meta.model !== 'jgaap') { opLease += rec.lessor.cash; continue; }
    }
    if (sched.meta.model === 'jgaap') {
      for (const sg of sched.meta.segments) {
        const pm = sg.pay.month;
        if (pm < period.start || pm > period.end) continue;
        if (term !== null && pm > term) continue;
        const ip = Math.min(sg.interest, sg.pay.amount);
        interestPaid += ip;
        repay += sg.pay.amount - ip;
      }
    }
  }
  return {
    items: [
      { section: '財務活動', label: 'リース負債の返済による支出（借手）', amount: -repay, elim: repay },
      { section: pol['POL-09'] === 'financing' ? '財務活動' : '営業活動', label: '利息の支払額（借手・リース負債分）', amount: -interestPaid, elim: interestPaid },
      { section: '営業活動', label: 'リース料の支払（借手：短期・少額、ASC842オペ、適用開始前）', amount: -opLease, elim: opLease },
      { section: '営業活動', label: 'リース料の受取（貸手：営業収入）', amount: receipts, elim: -receipts },
    ],
    check: repay + interestPaid + opLease - receipts,
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
  const vals = buckets.map((b) => ({ ...b, amount: 0 }));
  for (const r of gen.results) {
    const { sched } = r;
    if (sched.meta.model === 'offbalance') continue;
    const term = r.contract.terminationYm ? sched.meta.lastIdx : null;
    for (const p of sched.meta.payments) {
      if (p.month <= period.end) continue;
      if (term !== null && p.month > term) continue;
      if (p.month < sched.meta.measStart) continue;
      const d = p.month - period.end;
      const b = vals.find((x) => d >= x.from && d <= x.to);
      if (b) b.amount += p.amount;
    }
  }
  return vals;
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
      label: p.label, start: p.start, end: p.end, openL, newL, pay, int, principal: pay - int, closeL,
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
