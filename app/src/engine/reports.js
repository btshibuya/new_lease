// 連結精算表・連結CF消去データ・満期分析（共通部品）
import { accountLabel, ACCOUNTS, metaOf } from './accounts.js';
import { round, ymToIndex } from './util.js';
import { phaseAtIndex, lessorDepBetween } from './schedule.js';
import { monthReversals } from './elimination.js';

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
  add('INT', c.lesseeCo, ps.int, '借手個別：リース負債に係る利息費用');
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
  const r = c.lessor || {};
  if (sched.meta.lessorModel === 'finance') {
    // 所有権移転外ファイナンス・リース：物件は個別では除却し、リース投資資産と利息相当額（受取利息）を計上
    const endRec = sched.byIndex(Math.min(pE, sched.meta.lastIdx));
    add('LEASE_INT_INC', c.lessorCo, -ps.inc, '貸手個別：リース投資資産に係る受取利息（利息相当額）');
    if (endRec && pE < sched.meta.lastIdx) add('LEASE_INV', c.lessorCo, endRec.lessor.NI_end || 0, '貸手個別：リース投資資産');
    return out;
  }
  add('LEASE_INC', c.lessorCo, -ps.inc, '貸手個別：受取リース料');
  add('ACCR_INC', c.lessorCo, cl.R, '貸手個別：未収リース料（定額法）');
  if (r.assetCost > 0) {
    const ratio = r.ratio ?? 1;
    const endRec = sched.byIndex(pE);
    if (endRec && !endRec.lessee.term) {
      add('RENTAL_ASSET', c.lessorCo, R(r.assetCost * ratio), '貸手個別：賃貸資産（按分後）');
      add('RENTAL_ACC', c.lessorCo, -R(endRec.lessor.assetAcc_end * ratio), '貸手個別：減価償却累計額（按分後）');
    }
    const act = inP.filter((x) => x.m >= sched.meta.start);
    add('RENTAL_DEP', c.lessorCo, lessorDepBetween(sched, pS, pE, ratio, R), `貸手個別：減価償却費（リース期間分・按分後、${act.length}か月）`);
  }
  return out;
}

/** 連結精算表（グループ内リース関連科目） */
export function worksheet(gen, companies, pol, names, period, opts = {}) {
  const rows = new Map();
  // opts.company：その会社の行だけで集計する（'CONSOL' は会社に属さない組替の行）
  const ok = (l) => !opts.company || l.co === opts.company;
  const key = (l) => accountLabel(l, pol, names);
  const get = (l) => {
    const k = key(l);
    // items：計算の確認（内訳）用に、どの契約・仕訳から来た金額かを保持する
    if (!rows.has(k)) rows.set(k, { label: k, acc: l.acc, meta: l.meta, type: ACCOUNTS[l.acc]?.type, lessee: 0, lessor: 0, ind: 0, con: 0, items: [] });
    return rows.get(k);
  };
  for (const r of gen.results) {
    for (const l of individualLines(r, companies, pol)) {
      if (!ok(l)) continue;
      const row = get(l);
      const col = ACCOUNTS[l.acc]?.side === 'R' ? 'lessor' : 'lessee';
      row[col] += l.amt;
      row.items.push({ col, contract: r.contract.id, co: l.co, src: '個別（アプリの計算値）', amt: l.amt, basis: l.basis });
    }
  }
  for (const j of gen.journals) {
    for (const l of j.lines) {
      if (!ok(l)) continue;
      const row = get(l);
      const col = j.kind === 'IND' ? 'ind' : 'con';
      row[col] += l.amt;
      // content：仕訳の内容（開始仕訳・洗替は元の内容つき）。精算表の列を内容別に分けるときに使う
      row.items.push({ col, contract: j.contractId, co: l.co, src: `${j.tpl}${j.src ? `・${j.src}` : ''} ${j.title}`, content: j.src ? `${j.tpl}:${j.src}` : j.tpl, contentTitle: j.title, tpl: j.tpl, srcTpl: j.src || '', amt: l.amt, basis: (l.bases || [])[0] || '' });
    }
  }
  const out = [...rows.values()].map((r) => ({ ...r, simple: r.lessee + r.lessor, consol: r.lessee + r.lessor + r.ind + r.con }));
  const order = Object.keys(ACCOUNTS);
  out.sort((a, b) => (a.type === b.type ? order.indexOf(a.acc) - order.indexOf(b.acc) : a.type === 'BS' ? -1 : 1));
  return out;
}

/** グループ内で消去後に0となるべき科目 */
export const MUST_BE_ZERO = ['ROU_COST', 'ROU_ACC', 'LL_C', 'LL_NC', 'LEASE_ACCRUED', 'DEP_ROU', 'INT', 'ASC_COST', 'SHORT_COST', 'PRE_RENT', 'LEASE_INC', 'ACCR_INC', 'LEASE_INV', 'LEASE_INT_INC', 'PENALTY_INC', 'PENALTY_EXP', 'MOD_GAIN', 'LEGACY_ASSET', 'LEGACY_ACC', 'LEGACY_LIAB', 'LEGACY_LIAB_C'];

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
 * 貸手：−未収リース料（ファイナンス・リースは、連結上の自己所有資産の帳簿価額−リース投資資産）
 */
export function eFromSchedule(sched, idx, pol) {
  const c = sched.contract;
  const rec = idx < sched.meta.firstIdx ? null : sched.byIndex(Math.min(idx, sched.meta.lastIdx));
  if (!rec || (idx > sched.meta.lastIdx)) return { [c.lesseeCo]: 0, [c.lessorCo]: 0 };
  const le = rec.lessee;
  let eL = (le.L_end || 0) + (le.X_end || 0) - ((le.cost_end || 0) - (le.acc_end || 0));
  if (pol['POL-07'] === 'capitalize' && le.active && !le.term && sched.meta.idc) eL += sched.meta.idc - (le.idcAcc_end || 0);
  if (sched.meta.lessorModel === 'finance') {
    // リース期間終了の月は、返還された物件（見積残存価額＝連結上の帳簿価額）で個別と連結が一致する
    const eR = idx >= sched.meta.lastIdx || idx < ymToIndex(c.commencement) ? 0 : ((rec.lessor.assetCost || 0) - (rec.lessor.assetAcc_end || 0)) - (rec.lessor.NI_end || 0);
    return { [c.lesseeCo]: eL, [c.lessorCo]: eR };
  }
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
      label: p.label, start: p.start, end: p.end, openL, newL, remL, pay, int, principal: sched.meta.model === 'offbalance' ? 0 : pay - int, closeL, // 短期・少額リース等はリース負債がないため元本0
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
 * 契約の月次レポート：返済（元本・利息）、償却、借手の貸借対照表・損益、貸手の収益、連結への影響。
 * 連結損益への影響＝消去差額（純資産修正額）の当月の増減（年度別サマリーの「当期の連結損益への影響」と同じ定義）。
 * @returns 月ごとの行（m, ym, pay, int, principal, L, cost, dep, acc, rou, X, assets, liabs, equity, lesseeExp, inc, R, cumE, plEffect）
 */
export function contractMonthly(sched, pol) {
  const eAt = (idx) => Object.values(eFromSchedule(sched, idx, pol)).reduce((a, v) => a + v, 0);
  const model = sched.meta.model;
  const out = [];
  let prevE = eAt(sched.meta.firstIdx - 1);
  for (const x of sched.months) {
    const le = x.lessee, lo = x.lessor;
    // 定義は年度別サマリー（contractYearly）と同じ：利息＝リース負債に係る利息費用＋未払利息、支払＝借手の支払（適用開始後）
    const int = (le.int || 0) + (le.accr || 0);
    const pay = le.pay || 0;
    const prePay = !le.active ? lo.cash || 0 : 0; // 適用開始前（経過措置の測定開始前）の支払リース料
    const other = (le.cost || 0) + prePay - (model === 'asc842ol' ? le.accr || 0 : 0); // 減価償却費・利息以外の借手の費用
    const lesseeExp = (le.dep || 0) + int + other; // 初期直接費用の償却は dep に含まれる（取得原価＝リース負債＋初期直接費用）
    const rou = (le.cost_end || 0) - (le.acc_end || 0);
    const liabs = (le.L_end || 0) + (le.X_end || 0);
    const cumE = eAt(x.m);
    const ev = [];
    if (le.commence) ev.push(sched.meta.measSource !== 'none' ? '適用開始（経過措置）' : 'リース開始');
    if (le.remeasure) ev.push(`条件変更（負債 ${le.remeasure.Lold}→${le.remeasure.Lnew}）`);
    if (le.term) ev.push(le.term.kind === 'termination' ? '中途解約' : '満了');
    if (prePay) ev.push('適用開始前の支払');
    out.push({
      m: x.m, pay, prePay, int, principal: model !== 'offbalance' && le.active ? pay - int : 0, L: le.L_end || 0,
      cost: le.cost_end || 0, dep: le.dep || 0, acc: le.acc_end || 0, rou, X: le.X_end || 0,
      assets: rou, liabs, equity: rou - liabs, other, lesseeExp, inc: lo.inc || 0, R: lo.R_end || 0,
      // 貸手のファイナンス・リース：リース投資資産と、連結上の自己所有資産の帳簿価額
      NI: lo.fl ? lo.NI_end || 0 : 0, BV: lo.fl && x.m >= ymToIndex(sched.contract.commencement) && x.m < sched.meta.lastIdx ? (lo.assetCost || 0) - (lo.assetAcc_end || 0) : 0,
      cumE, plEffect: cumE - prevE, event: ev.join('・'),
    });
    prevE = cumE;
  }
  return out;
}

/** 月次の行を期間（年度など）ごとにまとめる。残高は期末、フローは合計 */
export function rollupMonthly(rows, periods) {
  const FLOW = ['pay', 'prePay', 'int', 'principal', 'dep', 'other', 'lesseeExp', 'inc', 'plEffect', 'eChange', 'plImpact'];
  return periods.map((p) => {
    const inP = rows.filter((r) => r.m >= p.start && r.m <= p.end);
    if (!inP.length) return null;
    const last = inP[inP.length - 1];
    const o = { ...last, label: p.label, start: p.start, end: p.end };
    for (const f of FLOW) if (f in last) o[f] = inP.reduce((a, r) => a + (r[f] || 0), 0);
    // イベントは「・」で分けてから重複を除く（同じイベントが月ごとに繰り返し並ばないように）
    o.event = [...new Set(inP.flatMap((r) => (r.event ? r.event.split('・') : [])))].join('・');
    o.months = inP; // 年度の行から月ごとの内訳へドリルダウンするため
    return o;
  }).filter(Boolean);
}

/**
 * 会社別の集計：その会社が借手の契約（返済・利息・償却・資産・負債・費用）と、貸手の契約（受取リース料・未収）を月ごとに合計する。
 * 会社の純資産修正額（消去差額のうちこの会社の分）とその増減（eChange：会社をまたぐ現金の受払の消去を含む）、
 * この会社の連結損益への影響（plImpact：この会社の損益の行の消去・組替、税引前）も求める。
 * 各行の parts に契約ごとの金額を残す（ドリルダウン用）。
 * @param items [{ contract, sched }]
 */
export function companyMonthly(items, code, pol) {
  const LESSEE = ['pay', 'principal', 'int', 'dep', 'other', 'lesseeExp', 'L', 'X', 'rou', 'liabs'];
  const LESSOR = ['inc', 'R'];
  const mine = items.filter(({ contract: c }) => c.lesseeCo === code || c.lessorCo === code);
  if (!mine.length) return [];
  const rows = new Map();
  const blank = (m) => ({ m, pay: 0, prePay: 0, principal: 0, int: 0, dep: 0, other: 0, lesseeExp: 0, L: 0, X: 0, rou: 0, liabs: 0, assets: 0, equity: 0, inc: 0, R: 0, cumE: 0, eChange: 0, plImpact: 0, event: '', parts: [] });
  const R = (v) => round(v, pol['POL-11'] || 'half_up');
  let lo = Infinity, hi = -Infinity;
  for (const { contract: c, sched } of mine) {
    const mo = contractMonthly(sched, pol);
    const isL = c.lesseeCo === code, isR = c.lessorCo === code;
    for (const r of mo) {
      lo = Math.min(lo, r.m); hi = Math.max(hi, r.m);
      const row = rows.get(r.m) || rows.set(r.m, blank(r.m)).get(r.m);
      const part = { contract: c.id, role: isL && isR ? '借手・貸手' : isL ? '借手' : '貸手', eventText: r.event };
      if (isL) { for (const k of LESSEE) { row[k] += r[k]; part[k] = r[k]; } part.assets = r.rou; }
      if (isR) for (const k of LESSOR) { row[k] += r[k]; part[k] = r[k]; }
      // この会社の連結損益への影響（税引前）：その月の個別仕訳の取消のうち、この会社の損益の行（借方＋は利益の減少）
      const rec = sched.byIndex(r.m);
      let pl = 0;
      for (const rv of rec ? monthReversals(rec, sched, pol) : []) for (const l of rv.lines) if (l.co === code && ACCOUNTS[l.acc]?.type === 'PL') pl -= l.amt;
      // 貸手の減価償却費の組替（C-12）：貸手の会社の賃貸原価等を取り消し、連結（会社に属さない）の費用に組み替える
      if (isR && pol['POL-05'] === 'by_lessee_dept' && (c.lessor?.assetCost || 0) > 0 && sched.meta.lessorModel !== 'finance') pl += lessorDepBetween(sched, r.m, r.m, c.lessor.ratio ?? 1, R);
      pl = pl || 0; // −0 を 0 にそろえる
      row.plImpact += pl; part.plImpact = pl;
      const e = eFromSchedule(sched, r.m, pol)[code] || 0;
      row.cumE += e; part.cumE = e;
      row.parts.push(part);
      // イベントは「契約番号 イベント」の形で1件ずつ並べる（同じ月に複数のイベントがあっても契約番号が分かるように）
      if (r.event) row.event = [...new Set([...(row.event ? row.event.split('・') : []), ...r.event.split('・').map((e) => `${c.id} ${e}`)])].join('・');
    }
  }
  const out = [];
  let prev = 0;
  for (let m = lo; m <= hi; m++) {
    const row = rows.get(m) || blank(m);
    row.assets = row.rou;
    row.equity = row.rou - row.liabs;
    row.eChange = row.cumE - prev; // 純資産修正額の増減（会社をまたぐ現金の受払の消去を含むため、会社の損益への影響とは一致しない）
    prev = row.cumE;
    out.push(row);
  }
  return out;
}
