// 自動検算（共通部品）
// 原則：仕訳の生成（elimination.js の「個別仕訳の取消」）とは別の計算経路で、期待値を独立に組み立てて比較する。
// 各検算の「独立性」の程度は independence に明記する（自己一致にすぎない検算を独立検証と誤認させないため）。
import { generateAll } from './elimination.js';
import { worksheet, MUST_BE_ZERO, eFromSchedule } from './reports.js';
import { validateContract } from './schedule.js';
import { round, fmt, ymToIndex, indexToJp, indexToYm } from './util.js';
import { ACCOUNTS, rateAt } from './accounts.js';

const OK = 'ok', WARN = 'warn', NG = 'ng';

function item(id, title, status, detail, rows = [], independence = '') {
  return { id, title, status, detail, rows, independence };
}

const FLOW_TPLS = new Set(['C-01', 'C-02', 'C-03', 'C-04', 'C-17', 'C-B']);
const TAX_TPLS = new Set(['C-01T', 'C-13', 'C-BT']);
const NCI_TPLS = new Set(['C-01N', 'C-14', 'C-BN']);

/** 契約条件から直接、月ごとの支払額を求める（スケジュール計算とは別の実装） */
function paymentsFromTerms(c) {
  const s = ymToIndex(c.commencement);
  const out = new Map();
  const term = c.terminationYm ? ymToIndex(c.terminationYm) : null;
  const steps = [...(c.steps || [])].sort((a, b) => b.fromPayment - a.fromPayment);
  for (let m = s; m < s + c.termMonths; m++) {
    const rel = m - s;
    let no = null;
    if (c.timing === 'advance' && rel % c.frequencyMonths === 0) no = rel / c.frequencyMonths + 1;
    if (c.timing !== 'advance' && (rel + 1) % c.frequencyMonths === 0) no = (rel + 1) / c.frequencyMonths;
    if (no === null || (term !== null && m > term)) continue;
    const amt = no <= (c.freePayments || 0) ? 0 : (steps.find((x) => no >= x.fromPayment)?.amount ?? c.payment);
    if (amt) out.set(m, amt);
  }
  return out;
}

/** スケジュールの残高・期間合計から、消去額（開始＋当期の動き）の期待値を独立に組み立てる（科目|会社 → 金額） */
function expectedFlowNet(r, pol, period) {
  const { sched, contract: c } = r;
  const m = sched.meta;
  const exp = new Map();
  const add = (acc, co, v) => { if (v) exp.set(`${acc}|${co}`, (exp.get(`${acc}|${co}`) || 0) + v); };
  const endRec = period.end < m.firstIdx ? null : sched.byIndex(Math.min(period.end, m.lastIdx));
  const alive = endRec && period.end <= m.lastIdx && !endRec.lessee.term;
  const L = c.lesseeCo, Rc = c.lessorCo;
  if (alive) {
    const le = endRec.lessee;
    add('LL_NC', L, le.L_end || 0);
    add('ROU_COST', L, -(le.cost_end || 0));
    add('ROU_ACC', L, le.acc_end || 0);
    add('LEASE_ACCRUED', L, le.X_end || 0);
    add('ACCR_INC', Rc, -(endRec.lessor.R_end || 0));
    if (pol['POL-07'] === 'capitalize' && m.idc && le.active) { add('OTHER_ASSET', L, m.idc); add('OTHER_ACC', L, -(le.idcAcc_end || 0)); }
  }
  for (const x of sched.months) {
    if (x.m < period.start || x.m > period.end) continue;
    const le = x.lessee, lo = x.lessor;
    if (m.model === 'jgaap') add('DEP_ROU', L, -(le.dep || 0));
    add('INT', L, -(le.int || 0));
    if (m.model === 'asc842ol') add('ASC_COST', L, -(le.cost || 0));
    if (m.model === 'offbalance') add('SHORT_COST', L, -(le.cost || 0));
    if (!le.active) add('PRE_RENT', L, -(lo.cash || 0));
    add('LEASE_INC', Rc, lo.inc || 0);
    if (le.commence && le.commence.idc && pol['POL-07'] !== 'capitalize') add('IDC_EXP', L, le.commence.idc);
    if (pol['POL-07'] === 'capitalize') add('DEP_OTHER', L, le.idcDep || 0);
    if (le.term) {
      add('TERM_GAIN', L, m.model === 'offbalance' ? le.term.X || 0 : le.term.gain || 0);
      if (pol['POL-07'] === 'capitalize' && m.idc) add('TERM_GAIN', L, m.idc - (le.term.idcAcc || 0));
    }
    if (le.penalty) { add('PENALTY_INC', Rc, le.penalty); add('PENALTY_EXP', L, -le.penalty); }
  }
  // 利益剰余金期首＝前期末のスケジュール残高から求めた純資産修正額の合計（符号反転）
  const eo = eFromSchedule(sched, period.start - 1, pol);
  add('RE_OPEN', 'CONSOL', -((eo[L] || 0) + (eo[Rc] || 0)));
  for (const [k, v] of [...exp]) if (!v) exp.delete(k);
  return exp;
}

function netOf(journals, tplSet, cid) {
  const m = new Map();
  for (const j of journals) {
    if (!tplSet.has(j.tpl) || j.contractId !== cid) continue;
    for (const l of j.lines) {
      const acc = l.acc === 'LL_C' ? 'LL_NC' : l.acc;
      m.set(`${acc}|${l.co}`, (m.get(`${acc}|${l.co}`) || 0) + l.amt);
    }
  }
  for (const [k, v] of [...m]) if (!v) m.delete(k);
  return m;
}

function diffMaps(a, b) {
  const out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) || 0, y = b.get(k) || 0;
    if (x !== y) out.push({ key: k, a: x, b: y });
  }
  return out;
}

/**
 * @returns {Array<{id,title,status,detail,rows,independence}>}
 */
export function runChecks(data, period, pol, gen, names = {}, opts = {}) {
  const out = [];
  const co = Object.fromEntries(data.companies.map((x) => [x.code, x]));
  const R = (v) => round(v, pol['POL-11'] || 'half_up');

  // CHK-00 入力検証
  const inv = [];
  const seen = new Set();
  for (const c of data.contracts) {
    if (seen.has(c.id)) inv.push({ contract: c.id, message: '契約番号が重複しています（別の契約のスケジュールで仕訳が作られるおそれ）' });
    seen.add(c.id);
    for (const e of validateContract(c, data.companies)) inv.push({ contract: c.id, message: e });
  }
  for (const e of gen.errors) inv.push({ contract: e.contractId, message: `計算エラー：${e.message}` });
  out.push(item('CHK-00', '契約データの入力検証', inv.length ? NG : OK, inv.length ? `${inv.length}件の入力エラーがあります` : 'すべての契約が入力ルールを満たし、契約番号は一意です', inv, '入力ルールの検査'));

  // CHK-01 貸借一致
  const unbal = gen.journals.filter((j) => j.lines.reduce((a, l) => a + l.amt, 0) !== 0).map((j) => ({ contract: j.contractId, message: `${j.tpl} ${j.title}：差額 ${fmt(j.lines.reduce((a, l) => a + l.amt, 0))}` }));
  out.push(item('CHK-01', '仕訳の貸借一致', unbal.length ? NG : OK, unbal.length ? `${unbal.length}本の仕訳で貸借が一致しません` : `${gen.journals.length}本すべて貸借一致`, unbal, '仕訳ごとの合計検査'));

  // CHK-02 契約条件からの支払額の独立計算
  const pay = [];
  for (const r of gen.results) {
    const c = r.contract;
    let expP = 0;
    for (const [m, a] of paymentsFromTerms(c)) if (m >= period.start && m <= period.end) expP += a;
    const schedP = r.sched.months.filter((x) => x.m >= period.start && x.m <= period.end).reduce((a, x) => a + (x.lessor.cash || 0), 0);
    if (expP !== schedP) pay.push({ contract: c.id, message: `契約条件から求めた当期の支払 ${fmt(expP)} ≠ スケジュールの支払 ${fmt(schedP)}` });
    // 貸手の受取リース料（定額法）：総リース料 × 経過月数 ÷ リース期間（解約月までは定額、解約月に未収を取崩）
    const s0 = ymToIndex(c.commencement);
    const total = [...paymentsFromTerms({ ...c, terminationYm: null }).values()].reduce((a, v) => a + v, 0);
    const term = c.terminationYm ? ymToIndex(c.terminationYm) : null;
    const cumInc = (idx) => {
      if (idx < s0) return 0;
      if (term !== null && idx >= term) return [...paymentsFromTerms(c)].filter(([m]) => m <= term).reduce((a, [, v]) => a + v, 0);
      return R((total * Math.min(idx - s0 + 1, c.termMonths)) / c.termMonths);
    };
    const expInc = cumInc(period.end) - cumInc(period.start - 1);
    const schedInc = r.ps.inc;
    if (expInc !== schedInc) pay.push({ contract: c.id, message: `契約条件から求めた当期の受取リース料（定額法）${fmt(expInc)} ≠ スケジュール ${fmt(schedInc)}` });
  }
  out.push(item('CHK-02', '支払額・受取リース料の独立計算（契約条件 → 当期の金額）', pay.length ? NG : OK, pay.length ? `${pay.length}契約で不一致` : '契約条件（回数・フリーレント・段階賃料・解約）から別実装で求めた支払額・貸手の定額収益と一致', pay, '別実装で再計算'));

  // CHK-03 ロールフォワードと消去差額の恒等式
  const idt = [];
  for (const r of gen.results) {
    const { ps, sched, contract: c } = r;
    if (sched.meta.model !== 'offbalance') {
      const newL = ps.commence ? ps.commence.L0 : 0;
      const tL = ps.term ? ps.term.L : 0;
      const Lcalc = ps.open.L + newL + ps.int + ps.accr - ps.pay - tL;
      if (Lcalc !== ps.close.L) idt.push({ contract: c.id, message: `リース負債：期首 ${fmt(ps.open.L)} ＋新規 ${fmt(newL)} ＋利息 ${fmt(ps.int + ps.accr)} −支払 ${fmt(ps.pay)} −取崩 ${fmt(tL)} ＝ ${fmt(Lcalc)} ≠ 期末 ${fmt(ps.close.L)}` });
    }
    let expL = 0, inc = 0, gain = 0, idcExp = 0, idcKeep = 0;
    for (const x of sched.months) {
      if (x.m > period.end) break;
      const le = x.lessee;
      expL += (le.dep || 0) + (le.int || 0) + (le.cost || 0) + (!le.active ? x.lessor.cash : 0);
      inc += x.lessor.inc || 0;
      if (le.term) gain += le.term.gain || 0;
      if (le.commence && le.commence.idc) idcExp += le.commence.idc;
      if (pol['POL-07'] === 'capitalize') {
        idcKeep += le.idcDep || 0;
        if (le.term && sched.meta.idc) idcKeep += sched.meta.idc - le.term.idcAcc;
      }
    }
    const plEffect = expL - inc - gain - (pol['POL-07'] === 'capitalize' ? idcKeep : idcExp);
    const es = eFromSchedule(sched, period.end, pol);
    const bs = (es[c.lesseeCo] || 0) + (es[c.lessorCo] || 0);
    const E = (r.E.close[c.lesseeCo] || 0) + (r.E.close[c.lessorCo] || 0);
    if (plEffect !== E || bs !== E) idt.push({ contract: c.id, message: `損益の累計 ${fmt(plEffect)}、残高の差 ${fmt(bs)}、仕訳の純資産修正額 ${fmt(E)} が一致しません` });
    else idt.push({ contract: c.id, message: `一致：Σ借手費用 ${fmt(expL)} − Σ貸手収益 ${fmt(inc)} − 解約益 ${fmt(gain)}${pol['POL-07'] !== 'capitalize' && idcExp ? ` − 初期直接費用 ${fmt(idcExp)}` : ''} ＝ 残高の差 ＝ ${fmt(E)}`, ok: true });
  }
  const idtNg = idt.filter((x) => !x.ok);
  out.push(item('CHK-03', '消去差額の恒等式（損益の累計＝残高の差＝仕訳の純資産修正額）とロールフォワード', idtNg.length ? NG : OK, idtNg.length ? `${idtNg.length}件の不一致` : '全契約で3つの計算経路が一致', idt, '損益・残高（スケジュール）と仕訳の比較'));

  // CHK-04 消去の完全性
  const ws = worksheet(gen, data.companies, pol, names, period);
  const zero = new Set(MUST_BE_ZERO);
  if (pol['POL-04'] === 'reclass') { zero.add('RENTAL_ASSET'); zero.add('RENTAL_ACC'); }
  if (pol['POL-05'] === 'by_lessee_dept') zero.add('RENTAL_DEP');
  const nz = ws.filter((r) => zero.has(r.acc) && r.consol !== 0).map((r) => ({ message: `${r.label}：連結後 ${fmt(r.consol)}` }));
  out.push(item('CHK-04', '消去の完全性（連結後のグループ内残高・取引が0）', nz.length ? NG : OK, nz.length ? `${nz.length}科目で残高が残っています` : '使用権資産・リース負債・受取リース料・支払利息等はすべて0（個別欄はアプリの計算値。帳簿との一致は CHK-10）', nz, 'アプリ計算の個別残高に対する検査'));

  // CHK-05 期末残高からの独立組立
  const d5 = [];
  for (const r of gen.results) {
    const expM = expectedFlowNet(r, pol, period);
    const act = netOf(gen.journals, FLOW_TPLS, r.contract.id);
    for (const d of diffMaps(expM, act)) d5.push({ contract: r.contract.id, message: `${ACCOUNTS[d.key.split('|')[0]]?.name || d.key}（${d.key.split('|')[1]}）：期待値 ${fmt(d.a)} ≠ 仕訳 ${fmt(d.b)}` });
  }
  out.push(item('CHK-05', '消去額の独立組立（期末残高・当期損益から期待値を作り仕訳と比較）', d5.length ? NG : OK, d5.length ? `${d5.length}件の差異` : '期末残高・当期の損益・前期末残高から独立に組み立てた消去額と、仕訳（月次の取消の集計）が科目・会社別に一致', d5, '別経路で組立'));

  // CHK-06 期間の連続性
  const cont = [];
  for (const r of gen.results) {
    const { sched, contract: c } = r;
    const prev = period.start - 1;
    const eo = eFromSchedule(sched, prev, pol);
    for (const k of [c.lesseeCo, c.lessorCo]) {
      const C = co[k];
      const t = pol['POL-02'] === 'reverse' && C?.taxEffect !== false ? rateAt(C, prev, 'taxRate') : 0;
      const n = pol['POL-01'] === 'allocate' ? rateAt(C, prev, 'nciRatio') : 0;
      const dt = R((eo[k] || 0) * t);
      const nci = R(((eo[k] || 0) - dt) * n);
      if ((r.E.open[k] || 0) !== (eo[k] || 0)) cont.push({ contract: c.id, message: `${C?.name || k}：期首の純資産修正額 ${fmt(r.E.open[k])} ≠ 前期末残高から求めた額 ${fmt(eo[k])}` });
      if ((r.DT.open[k] || 0) !== dt) cont.push({ contract: c.id, message: `${C?.name || k}：期首税効果 ${fmt(r.DT.open[k])} ≠ ${fmt(dt)}` });
      if ((r.NCI.open[k] || 0) !== nci) cont.push({ contract: c.id, message: `${C?.name || k}：期首非支配株主持分 ${fmt(r.NCI.open[k])} ≠ ${fmt(nci)}` });
    }
  }
  out.push(item('CHK-06', '期間の連続性（期首額＝前期末の残高・前期末の税率/持分比率から独立に計算した額）', cont.length ? NG : OK, cont.length ? `${cont.length}件の不一致` : '開始仕訳・期首税効果・期首非支配株主持分が前期末から独立に計算した額と一致', cont, '別経路で計算'));

  // CHK-07 スケジュールの完結性と現在価値の独立再計算（年金現価の公式）
  const sc = [];
  for (const r of gen.results) {
    const { sched, contract: c } = r;
    const m = sched.meta;
    if (m.model === 'offbalance') continue;
    if (Math.abs(m.finalResidual || 0) > m.K) sc.push({ contract: c.id, message: `最終回の端数調整額 ${fmt(m.finalResidual)} が大きすぎます（支払回数 ${m.K}）` });
    const rem = m.payments.filter((p) => p.month >= m.measStart);
    const regular = rem.length && rem.every((p) => p.amount === rem[0].amount) && (rem[0].t - m.measStart) % m.f === 0;
    const override = c.lessee.liabilityOverride !== null && c.lessee.liabilityOverride !== undefined && c.lessee.transition?.method !== 'cumulative';
    if (regular && m.rp > 0) {
      const k0 = (rem[0].t - m.measStart) / m.f;
      const n = rem.length;
      const L0calc = R(rem[0].amount * (1 - Math.pow(1 + m.rp, -n)) / m.rp * Math.pow(1 + m.rp, 1 - k0));
      if (!override && Math.abs(L0calc - m.L0) > 1) sc.push({ contract: c.id, message: `当初リース負債：年金現価の公式 ${fmt(L0calc)} ≠ スケジュール ${fmt(m.L0)}` });
      if (override && L0calc !== m.L0) sc.push({ contract: c.id, message: `取込値（借手の帳簿）${fmt(m.L0)} と再計算値 ${fmt(L0calc)} に差異 ${fmt(m.L0 - L0calc)}。割引率・支払条件を確認してください`, warn: true });
    }
    if (m.model === 'jgaap') {
      const endRec = sched.byIndex(Math.min(period.end, m.lastIdx));
      if (endRec && period.end >= m.measStart && period.end <= m.lastIdx && !endRec.lessee.term) {
        const s0 = ymToIndex(c.commencement);
        const months = c.lessee.depMonths || (s0 + c.termMonths - m.measStart);
        const expAcc = R((m.C0 * Math.min(period.end - m.measStart + 1, months)) / months);
        if (expAcc !== endRec.lessee.acc_end) sc.push({ contract: c.id, message: `減価償却累計額：取得原価 ${fmt(m.C0)} × 経過月数 ÷ 償却月数 ${months} ＝ ${fmt(expAcc)} ≠ スケジュール ${fmt(endRec.lessee.acc_end)}` });
      }
    }
    const totInt = m.segments.reduce((a, x) => a + x.interest, 0);
    const remTotal = rem.reduce((a, p) => a + p.amount, 0);
    if (!c.terminationYm && totInt !== remTotal - m.L0) sc.push({ contract: c.id, message: `利息総額 ${fmt(totInt)} ≠ 支払総額 ${fmt(remTotal)} − 当初負債 ${fmt(m.L0)}` });
  }
  const scNg = sc.filter((x) => !x.warn);
  out.push(item('CHK-07', 'スケジュールの完結性と現在価値の独立再計算（年金現価の公式）', scNg.length ? NG : sc.length ? WARN : OK, scNg.length ? `${scNg.length}件の不一致` : sc.length ? `${sc.length}件の確認事項` : '均等払の契約は年金現価の公式と一致、全契約で利息総額＝支払総額−当初負債', sc, '公式による再計算'));

  // CHK-08 貸手資産の按分比率
  const ratio = new Map();
  for (const c of data.contracts) {
    const r = c.lessor || {};
    if (!(r.assetCost > 0) || !r.assetId) continue;
    ratio.set(r.assetId, (ratio.get(r.assetId) || 0) + (r.ratio ?? 1));
  }
  const over = [...ratio.entries()].filter(([, v]) => v > 1 + 1e-9).map(([k, v]) => ({ message: `貸手資産 ${k}：按分比率合計 ${(v * 100).toFixed(1)}%（100%超）` }));
  out.push(item('CHK-08', '貸手資産の按分比率（二重計上の防止）', over.length ? NG : OK, over.length ? '按分比率の合計が100%を超える資産があります' : 'すべての貸手資産で按分比率合計が100%以下', over, '入力の検査'));

  // CHK-09 決算日の差異（POL-08）
  const fy = [];
  const parentFe = data.companies.find((x) => x.isParent)?.fyeMonth || 3;
  if (pol['POL-08'] !== 'provisional') {
    for (const r of gen.results) {
      const c = r.contract;
      for (const [who, code] of [['借手', c.lesseeCo], ['貸手', c.lessorCo]]) {
        const fe = co[code]?.fyeMonth;
        if (!fe || fe === parentFe) continue;
        const gap = (parentFe - fe + 12) % 12;
        const gapStart = period.end - gap + 1;
        const ev = r.sched.months.filter((x) => x.m >= gapStart && x.m <= period.end && (x.lessee.commence || x.lessee.term));
        fy.push({ contract: c.id, message: `${who}（${co[code]?.name}）は${fe}月決算。差異期間（${indexToJp(gapStart)}〜${indexToJp(period.end)}）${ev.length ? `に${ev.map((x) => (x.lessee.commence ? '開始' : '終了')).join('・')}があり、重要な不一致の調整を検討してください` : 'に新規・解約はありません'}`, warn: ev.length > 0 });
      }
    }
  }
  const fyWarn = fy.filter((x) => x.warn);
  out.push(item('CHK-09', '決算日の差異による不一致（POL-08）', fyWarn.length ? WARN : OK, pol['POL-08'] === 'provisional' ? '方針「仮決算」：全社を連結決算日で計算しています' : fyWarn.length ? `${fyWarn.length}件の調整候補` : fy.length ? '決算日の異なる会社はありますが、差異期間に新規・解約はありません' : '決算日の異なる会社はありません', fy, '差異期間のイベント検出'));

  // CHK-10 個別の帳簿残高（実績）との突合
  const act = [];
  const key = indexToYm(period.end);
  const fullYear = period.end - period.start === 11;
  let missing = 0;
  for (const r of gen.results) {
    const c = r.contract;
    const live = r.ps.activeMonths > 0;
    const a2 = (c.actuals || {})[key];
    if (!a2) { if (live) { missing++; act.push({ contract: c.id, message: `${key} 末の実績が未入力です（未突合）`, warn: true }); } continue; }
    const cl = r.ps.close;
    const cmp = [['リース負債', a2.L, cl.L], ['使用権資産簿価', a2.rouNet, cl.cost - cl.acc]];
    if (fullYear) cmp.push(['受取リース料（当期）', a2.inc, r.ps.inc]);
    for (const [nm, book, app] of cmp) {
      if (book === undefined || book === null || book === '') continue;
      if (Number(book) !== app) act.push({ contract: c.id, message: `${nm}：個別帳簿 ${fmt(Number(book))} ／ アプリ計算 ${fmt(app)} ／ 差異 ${fmt(Number(book) - app)}` });
      else act.push({ contract: c.id, message: `${nm}：一致（${fmt(app)}）`, ok: true });
    }
  }
  const actNg = act.filter((x) => !x.ok && !x.warn);
  out.push(item('CHK-10', '個別の帳簿残高（実績）との突合', actNg.length ? NG : missing ? WARN : OK, actNg.length ? `${actNg.length}件の差異。原因を調査し個社修正を検討してください` : missing ? `${missing}契約が未突合（実績未入力）。入力済みの契約は一致` : '有効な全契約で実績と一致', act, '外部（個別帳簿）との突合'));

  // CHK-11 税効果・非支配株主持分の期末残高検証
  const tx = [];
  for (const r of gen.results) {
    const { sched, contract: c } = r;
    const es = eFromSchedule(sched, period.end, pol);
    const dtaNet = netOf(gen.journals, TAX_TPLS, c.id);
    const nciNet = netOf(gen.journals, NCI_TPLS, c.id);
    for (const k of [c.lesseeCo, c.lessorCo]) {
      const C = co[k];
      const t = pol['POL-02'] === 'reverse' && C?.taxEffect !== false ? rateAt(C, period.end, 'taxRate') : 0;
      const n = pol['POL-01'] === 'allocate' ? rateAt(C, period.end, 'nciRatio') : 0;
      const expDT = R((es[k] || 0) * t);
      const expN = R(((es[k] || 0) - expDT) * n);
      const gotDT = -(dtaNet.get(`DTA|${k}`) || 0);
      const gotN = -(nciNet.get(`NCI|${k}`) || 0);
      if (expDT !== gotDT) tx.push({ contract: c.id, message: `${C?.name || k}：期末の税効果取消額 期待値 ${fmt(expDT)}（残高 ${fmt(es[k])}×${(t * 100).toFixed(2)}%）≠ 仕訳累計 ${fmt(gotDT)}` });
      if (expN !== gotN) tx.push({ contract: c.id, message: `${C?.name || k}：期末の非支配株主持分 期待値 ${fmt(expN)} ≠ 仕訳累計 ${fmt(gotN)}` });
    }
  }
  out.push(item('CHK-11', '税効果・非支配株主持分の期末残高検証（スケジュール残高×期末税率・持分比率）', tx.length ? NG : OK, tx.length ? `${tx.length}件の不一致` : '開始仕訳＋当期仕訳の累計が、期末残高から独立に計算した額と一致（符号・税率・比率の誤りを検出）', tx, '別経路で計算'));

  // CHK-14 流動部分の独立計算（月次残高から：決算日後12か月以内の最終支払直後の残高との差）
  const cp = [];
  for (const r of gen.results) {
    const { sched, contract: c } = r;
    if (sched.meta.model === 'offbalance') continue;
    const endRec = sched.byIndex(period.end);
    if (!endRec || !endRec.lessee.active || endRec.lessee.term) continue;
    const pays = paymentsFromTerms({ ...c, terminationYm: null });
    let last = null;
    for (let mm = period.end + 1; mm <= period.end + 12; mm++) if (pays.has(mm)) last = mm;
    if (last !== null && (last > sched.meta.lastIdx || (c.terminationYm && last >= sched.meta.lastIdx))) continue; // 解約月以降は月次残高がないため独立計算の対象外
    let expCur = 0;
    if (last !== null) {
      const after = c.timing === 'advance'
        ? (sched.byIndex(last - 1)?.lessee.L_end || 0) - pays.get(last)
        : sched.byIndex(last)?.lessee.L_end || 0;
      expCur = endRec.lessee.L_end - after;
    }
    // C-10 の流動側を直接集計する
    const c10 = gen.journals.filter((j) => j.tpl === 'C-10' && j.contractId === c.id).flatMap((j) => j.lines).filter((l) => l.acc === 'LL_C').reduce((a, l) => a + l.amt, 0);
    if (c10 !== expCur) cp.push({ contract: c.id, message: `流動部分：月次残高から ${fmt(expCur)}（${last !== null ? `${indexToJp(last)}の支払直後の残高との差` : '1年以内の支払なし'}）≠ 仕訳 ${fmt(c10)}` });
  }
  out.push(item('CHK-14', 'リース負債の流動部分の独立計算（決算日後1年以内）', cp.length ? NG : OK, cp.length ? `${cp.length}契約で不一致` : '月次の残高推移から独立に求めた流動部分と C-10 の金額が一致', cp, '別経路で計算'));

  // CHK-12 棚卸資産等への原価算入（POL-12）
  const note12 = (data.checkNotes || {})['CHK-12'];
  const mfg = data.contracts.filter((c) => c.lessee?.dept === 'mfg').map((c) => ({ contract: c.id, message: `${c.name}：借手は製造部門で使用。期末在庫に含まれる償却費の重要性を確認してください`, warn: !note12 }));
  out.push(item('CHK-12', '棚卸資産に含まれる償却費（POL-12）', mfg.length && !note12 ? WARN : OK, mfg.length ? (note12 ? `判断を記録済み：${note12}` : `${mfg.length}契約が製造部門で使用（方針：${pol['POL-12'] === 'manual' ? '手入力で調整' : '調整しない'}）。重要性の判断を記録してください`) : '製造部門で使用する契約はありません', mfg, '判断の記録'));

  // CHK-13 確定済み期間の再現性
  const lk = [];
  if (!opts.skipLocks) {
    for (const l of data.locks || []) {
      const p = { start: ymToIndex(l.periodStart), end: ymToIndex(l.periodEnd), label: l.label };
      const g = generateAll(data, p, pol, { schedCache: opts.schedCache });
      const nets = snapshotNets(g);
      for (const cid of new Set([...Object.keys(l.snapshot), ...Object.keys(nets)])) {
        const a = new Map(Object.entries(l.snapshot[cid]?.nets || {}));
        const b = new Map(Object.entries(nets[cid]?.nets || {}));
        for (const d of diffMaps(a, b)) lk.push({ contract: cid, message: `${l.label}：${d.key} 確定時 ${fmt(d.a)} → 現在 ${fmt(d.b)}` });
      }
    }
  }
  out.push(item('CHK-13', '確定済み期間の再現性（確定時のスナップショットと現在の再計算の一致）', lk.length ? NG : OK, lk.length ? `確定済み期間の数値が ${lk.length}件変わっています。マスタ・方針の変更を取り消すか、理由を記録して確定を解除してください` : (data.locks || []).length ? `確定済み ${(data.locks || []).length} 期間すべてで再計算結果が確定時と一致` : '確定済みの期間はありません', lk, '確定値との比較'));

  return out;
}

/** 期間確定用：契約別・科目|会社別の仕訳純額 */
export function snapshotNets(gen) {
  const out = {};
  for (const j of gen.journals) {
    const cid = j.contractId || '—';
    out[cid] ||= { nets: {} };
    for (const l of j.lines) {
      const k = `${l.acc}|${l.co}`;
      out[cid].nets[k] = (out[cid].nets[k] || 0) + l.amt;
    }
  }
  for (const v of Object.values(out)) for (const k of Object.keys(v.nets)) if (!v.nets[k]) delete v.nets[k];
  return out;
}

export function overallStatus(checks) {
  if (checks.some((c) => c.status === NG)) return NG;
  if (checks.some((c) => c.status === WARN)) return WARN;
  return OK;
}
