// 自動検算（共通部品）
// 原則：仕訳の生成（elimination.js の「個別仕訳の取消」）とは別の計算経路で、期待値を独立に組み立てて比較する。
// 各検算の「独立性」の程度は independence に明記する（自己一致にすぎない検算を独立検証と誤認させないため）。
// 注意：すべての誤りを検出できるわけではない。検出できる誤りの例は tests/mutation.test.js を参照。
import { generateAll, overrideDiff, overrideSuggestions, overlappingOverrides } from './elimination.js';
import { worksheet, MUST_BE_ZERO, eFromSchedule, cashFlowEliminations } from './reports.js';
import { validateContract, sortedMods, periodSummary } from './schedule.js';
import { round, fmt, ymToIndex, indexToJp, indexToYm } from './util.js';
import { ACCOUNTS, accountLabel } from './accounts.js';
import { chainHash } from './data.js';

const OK = 'ok', WARN = 'warn', NG = 'ng';

function item(id, title, status, detail, rows = [], independence = '') {
  return { id, title, status, detail, rows, independence };
}

const FLOW_TPLS = new Set(['C-01', 'C-02', 'C-03', 'C-04', 'C-20', 'C-17', 'C-B']); // 開始仕訳・洗替は src（元の内容）で判定
const TAX_TPLS = new Set(['C-01T', 'C-13', 'C-BT']);
const NCI_TPLS = new Set(['C-01N', 'C-14', 'C-BN']);

/** 税率・持分比率の時点値（エンジンの rateAt とは別実装：新しい履歴から逆順に探す） */
function rateIndep(co, idx, key) {
  if (!co) return 0;
  const hist = [...(co.history || [])].reverse();
  for (const h of hist) {
    const y = Number(h.fromYm.slice(0, 4)), m = Number(h.fromYm.slice(5, 7));
    if ((y - 0) * 12 + (m - 1) <= idx) return h[key] || 0;
  }
  return co[key] || 0;
}

/** 契約条件（条件変更を含む）から直接、月ごとの支払額を求める（スケジュール計算とは別の実装） */
function paymentsFromTerms(c, ignoreTermination = false) {
  const s = ymToIndex(c.commencement);
  const out = new Map();
  const term = c.terminationYm && !ignoreTermination ? ymToIndex(c.terminationYm) : null;
  const mods = sortedMods(c);
  let N = c.termMonths;
  for (const m of mods) N = m.termMonths ?? N;
  const steps = [...(c.steps || [])].sort((a, b) => b.fromPayment - a.fromPayment);
  for (let m = s; m < s + N; m++) {
    const rel = m - s;
    let no = null;
    if (c.timing === 'advance' && rel % c.frequencyMonths === 0) no = rel / c.frequencyMonths + 1;
    if (c.timing !== 'advance' && (rel + 1) % c.frequencyMonths === 0) no = (rel + 1) / c.frequencyMonths;
    if (no === null || (term !== null && m > term)) continue;
    let amt = no <= (c.freePayments || 0) ? 0 : (steps.find((x) => no >= x.fromPayment)?.amount ?? c.payment);
    const mod = [...mods].reverse().find((x) => ymToIndex(x.ym) <= m && x.payment !== null && x.payment !== undefined);
    if (mod) amt = mod.payment;
    const ov = (c.paymentOverrides || []).find((x) => ymToIndex(x.ym) === m); // 返済スケジュールの手修正
    if (ov) amt = ov.amount;
    if (amt) out.set(m, amt);
  }
  return out;
}

/** 貸手の受取リース料（定額法）を契約条件から別実装で計算：月→当月の収益 */
function lessorIncomeFromTerms(c, R) {
  const s = ymToIndex(c.commencement);
  const mods = sortedMods(c);
  const term = c.terminationYm ? ymToIndex(c.terminationYm) : null;
  const TR = c.lessor?.termMonths ? s + c.lessor.termMonths - 1 : null;
  const planAt = (m) => {
    // 月 m 時点で有効な契約条件のもとでの支払予定と終了月
    const known = { ...c, modifications: mods.filter((x) => ymToIndex(x.ym) <= m) };
    let N = c.termMonths;
    for (const x of known.modifications) N = x.termMonths ?? N;
    return { pays: paymentsFromTerms({ ...known, terminationYm: null }, true), end: s + N - 1 };
  };
  const out = new Map();
  let R_bal = 0, segStart = s, segEnd = null, segTotal = 0, cumPrev = 0;
  const finalEnd = planAt(Infinity).end;
  const last = term ?? finalEnd;
  for (let m = s; m <= last; m++) {
    const isMod = mods.some((x) => ymToIndex(x.ym) === m);
    if (m === s || isMod || m === segEnd + 1) {
      const p = planAt(m);
      const end = TR !== null && TR >= m ? Math.min(TR, p.end) : p.end;
      let tot = 0;
      for (const [mm, a] of p.pays) if (mm >= m && mm <= end) tot += a;
      segStart = m; segEnd = end; segTotal = tot - (m === s ? 0 : R_bal); cumPrev = 0;
    }
    const cum = R((segTotal * (m - segStart + 1)) / (segEnd - segStart + 1));
    let inc = cum - cumPrev;
    cumPrev = cum;
    const cash = planAt(m).pays.get(m) || 0;
    R_bal += inc - cash;
    if (term !== null && m === term) { inc -= R_bal; R_bal = 0; }
    out.set(m, inc);
  }
  return out;
}

/** 非支配株主持分の期待値（エンジンの nciAt とは別実装：月次に比率の変化点を走査） */
function nciExpected(sched, coMap, pol, idx, R) {
  const c = sched.contract;
  if (pol['POL-01'] !== 'allocate') return { N: 0, cap: 0 };
  const L = coMap[c.lesseeCo];
  const base = (t) => {
    const e = eFromSchedule(sched, t, pol);
    let b = 0;
    for (const k of [c.lesseeCo, c.lessorCo]) {
      const C = coMap[k];
      const ek = e[k] || 0;
      const tax = pol['POL-02'] === 'reverse' && C && C.taxEffect !== false ? R(ek * rateIndep(C, t, 'taxRate') * (ek > 0 ? (C.dtaRatio ?? 1) : 1)) : 0;
      b += ek - tax;
    }
    return b;
  };
  let cap = 0;
  for (let t = sched.meta.firstIdx + 1; t <= idx; t++) {
    const n0 = rateIndep(L, t - 1, 'nciRatio'), n1 = rateIndep(L, t, 'nciRatio');
    if (n0 !== n1) { const b = base(t - 1); cap += R(n1 * b) - R(n0 * b); }
  }
  const N = R(rateIndep(L, idx, 'nciRatio') * base(idx));
  return pol['POL-14'] === 'capital' ? { N: N - cap, cap: 0 } : { N, cap };
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
    if (le.commence && le.commence.retroAcc) add('RE_OPEN', L, le.commence.C0 - le.commence.retroAcc - le.commence.L0);
    if (pol['POL-07'] === 'capitalize') add('DEP_OTHER', L, le.idcDep || 0);
    if (le.remeasure && le.remeasure.gain) add('MOD_GAIN', L, le.remeasure.gain);
    if (le.term) {
      add('TERM_GAIN', L, m.model === 'offbalance' ? le.term.X || 0 : le.term.gain || 0);
      if (pol['POL-07'] === 'capitalize' && m.idc) add('TERM_GAIN', L, m.idc - (le.term.idcAcc || 0));
    }
    if (le.penalty) { add('PENALTY_INC', Rc, le.penalty); add('PENALTY_EXP', L, -le.penalty); }
  }
  // 利益剰余金期首＝前期末のスケジュール残高から求めた会社別の純資産修正額（符号反転）
  const eo = eFromSchedule(sched, period.start - 1, pol);
  add('RE_OPEN', L, -(eo[L] || 0));
  add('RE_OPEN', Rc, -(eo[Rc] || 0));
  for (const [k, v] of [...exp]) if (!v) exp.delete(k);
  return exp;
}

function netOf(journals, tplSet, cid) {
  const m = new Map();
  for (const j of journals) {
    // 開始仕訳・洗替は元の内容（src）で判定する
    if (!tplSet.has(j.src || j.tpl) || j.contractId !== cid || j.carriedOverride) continue;
    // 手修正した仕訳は修正前（アプリの計算値）で検算する（手修正は CHK-18 で別に警告）
    for (const l of j.origLines || j.lines) {
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
const accName = (key) => `${ACCOUNTS[key.split('|')[0]]?.name || key.split('|')[0]}（${key.split('|')[1]}）`;

/**
 * @returns {Array<{id,title,status,detail,rows,independence}>}
 */
export function runChecks(data, period, pol, gen, names = {}, opts = {}) {
  const out = [];
  const co = Object.fromEntries(data.companies.map((x) => [x.code, x]));
  const R = (v) => round(v, pol['POL-11'] || 'half_up');
  const safe = (id, title, fn, independence) => {
    try { out.push(fn()); } catch (e) { out.push(item(id, title, NG, `検算の実行中にエラーが発生しました：${e.message}`, [], independence)); }
  };

  safe('CHK-00', '契約データの入力検証', () => {
    const inv = [];
    const seen = new Set();
    for (const c of data.contracts) {
      if (seen.has(c.id)) inv.push({ contract: c.id, message: '契約番号が重複しています（別の契約のスケジュールで仕訳が作られるおそれ）' });
      seen.add(c.id);
      for (const e of validateContract(c, data.companies)) inv.push({ contract: c.id, message: e });
      if (c.lessee?.taxLease) inv.push({ contract: c.id, message: '法人税法上のリース取引（売買扱い）に該当する契約：個別の税務処理が異なるため、税効果（C-13）を個別に検討し、必要なら手入力仕訳で調整してください', warn: true });
    }
    for (const e of gen.errors) inv.push({ contract: e.contractId, message: `計算エラー：${e.message}` });
    for (const C of data.companies) {
      if (C.adoption?.method === 'cumulative' && C.adoption.ym) {
        const mon = Number(C.adoption.ym.slice(5, 7));
        if (mon !== (C.fyeMonth % 12) + 1) inv.push({ contract: '—', message: `${C.name}：適用初年度の開始年月 ${C.adoption.ym} が期首（決算月 ${C.fyeMonth}月の翌月）ではありません（新リース会計基準は期首から適用）` });
      }
    }
    const ng = inv.filter((x) => !x.warn);
    return item('CHK-00', '契約データの入力検証', ng.length ? NG : inv.length ? WARN : OK, ng.length ? `${ng.length}件の入力エラーがあります` : inv.length ? `${inv.length}件の確認事項` : 'すべての契約が入力ルールを満たし、契約番号は一意です', inv, '入力ルールの検査');
  });

  safe('CHK-01', '仕訳の貸借一致', () => {
    const unbal = gen.journals.filter((j) => j.lines.reduce((a, l) => a + l.amt, 0) !== 0).map((j) => ({ contract: j.contractId, message: `${j.tpl} ${j.title}：差額 ${fmt(j.lines.reduce((a, l) => a + l.amt, 0))}` }));
    return item('CHK-01', '仕訳の貸借一致', unbal.length ? NG : OK, unbal.length ? `${unbal.length}本の仕訳で貸借が一致しません` : `${gen.journals.length}本すべて貸借一致`, unbal, '合計検査');
  });

  safe('CHK-02', '支払額・受取リース料の独立計算（契約条件 → 当期の金額）', () => {
    const pay = [];
    for (const r of gen.results) {
      const c = r.contract;
      let expP = 0;
      for (const [m, a] of paymentsFromTerms(c)) if (m >= period.start && m <= period.end) expP += a;
      const schedP = r.sched.months.filter((x) => x.m >= period.start && x.m <= period.end).reduce((a, x) => a + (x.lessor.cash || 0), 0);
      if (expP !== schedP) pay.push({ contract: c.id, message: `契約条件から求めた当期の支払 ${fmt(expP)} ≠ スケジュールの支払 ${fmt(schedP)}` });
      let expI = 0;
      for (const [m, v] of lessorIncomeFromTerms(c, R)) if (m >= period.start && m <= period.end) expI += v;
      if (expI !== r.ps.inc) pay.push({ contract: c.id, message: `契約条件から求めた当期の受取リース料（定額法・貸手のリース期間・条件変更を反映）${fmt(expI)} ≠ スケジュール ${fmt(r.ps.inc)}` });
    }
    return item('CHK-02', '支払額・受取リース料の独立計算（契約条件 → 当期の金額）', pay.length ? NG : OK, pay.length ? `${pay.length}件の不一致` : '契約条件（回数・フリーレント・段階賃料・条件変更・解約・貸手のリース期間）から別実装で求めた支払額・貸手の定額収益と一致', pay, '別実装で再計算');
  });

  safe('CHK-03', '消去差額の恒等式（損益の累計＝残高の差＝仕訳の純資産修正額）とロールフォワード', () => {
    const idt = [];
    for (const r of gen.results) {
      const { ps, sched, contract: c } = r;
      if (sched.meta.model !== 'offbalance') {
        const newL = ps.commence ? ps.commence.L0 : 0;
        const tL = ps.term ? ps.term.L : 0;
        const Lcalc = ps.open.L + newL + ps.remeasureL + ps.int + ps.accr - ps.pay - tL;
        if (Lcalc !== ps.close.L) idt.push({ contract: c.id, message: `リース負債：期首 ${fmt(ps.open.L)} ＋新規 ${fmt(newL)} ＋再測定 ${fmt(ps.remeasureL)} ＋利息 ${fmt(ps.int + ps.accr)} −支払 ${fmt(ps.pay)} −取崩 ${fmt(tL)} ＝ ${fmt(Lcalc)} ≠ 期末 ${fmt(ps.close.L)}` });
      }
      let expL = 0, inc = 0, gain = 0, idcExp = 0, idcKeep = 0, transRE = 0;
      for (const x of sched.months) {
        if (x.m > period.end) break;
        const le = x.lessee;
        expL += (le.dep || 0) + (le.int || 0) + (le.cost || 0) + (!le.active ? x.lessor.cash : 0);
        inc += x.lessor.inc || 0;
        if (le.term) gain += le.term.gain || 0;
        if (le.remeasure) gain += le.remeasure.gain || 0;
        if (le.commence && le.commence.idc) idcExp += le.commence.idc;
        if (le.commence && le.commence.retroAcc) transRE += le.commence.L0 - (le.commence.C0 - le.commence.retroAcc);
        if (pol['POL-07'] === 'capitalize') {
          idcKeep += le.idcDep || 0;
          if (le.term && sched.meta.idc) idcKeep += sched.meta.idc - le.term.idcAcc;
        }
      }
      const plEffect = expL - inc - gain - (pol['POL-07'] === 'capitalize' ? idcKeep : idcExp) + transRE;
      const es = eFromSchedule(sched, period.end, pol);
      const bs = (es[c.lesseeCo] || 0) + (es[c.lessorCo] || 0);
      const E = (r.E.close[c.lesseeCo] || 0) + (r.E.close[c.lessorCo] || 0);
      if (plEffect !== E || bs !== E) idt.push({ contract: c.id, message: `損益の累計 ${fmt(plEffect)}、残高の差 ${fmt(bs)}、仕訳の純資産修正額 ${fmt(E)} が一致しません` });
      else idt.push({ contract: c.id, message: `一致：Σ借手費用 ${fmt(expL)} − Σ貸手収益 ${fmt(inc)} − 解約・条件変更損益 ${fmt(gain)}${pol['POL-07'] !== 'capitalize' && idcExp ? ` − 初期直接費用 ${fmt(idcExp)}` : ''}${transRE ? ` ＋ 適用時の累積的影響額 ${fmt(transRE)}` : ''} ＝ 残高の差 ＝ ${fmt(E)}`, ok: true });
    }
    const ng = idt.filter((x) => !x.ok);
    return item('CHK-03', '消去差額の恒等式（損益の累計＝残高の差＝仕訳の純資産修正額）とロールフォワード', ng.length ? NG : OK, ng.length ? `${ng.length}件の不一致` : '全契約で3つの計算経路が一致', idt, 'スケジュールの損益・残高と仕訳の比較');
  });

  safe('CHK-18', '仕訳・返済スケジュールの手修正', () => {
    const rows = [];
    for (const j of gen.journals.filter((x) => x.override)) {
      const diff = overrideDiff({ lines: j.lines, orig: j.origLines });
      const sug = overrideSuggestions(diff).map((s) => s.label).slice(0, 4).join('、');
      rows.push({ contract: j.contractId, message: `${j.tpl}${j.src ? `・${j.src}` : ''} ${j.title}：手修正（理由：${j.override.reason}）。差額 ${diff.map((d) => `${ACCOUNTS[d.acc]?.name || d.acc}（${d.co}）${fmt(d.amt)}`).join('、')}${j.override.stale ? '。手修正後に元の計算が変わりました。手修正を見直してください' : ''}${sug ? `。契約情報等の修正候補：${sug}` : ''}`, warn: true });
    }
    for (const j of gen.journals.filter((x) => x.carriedOverride)) rows.push({ contract: j.contractId, message: `${j.title}：前期以前の手修正の差額を開始仕訳で引き継いでいます`, warn: true });
    for (const [a, b] of overlappingOverrides(data.overrides?.journals || []).filter(([a]) => a.contractId && data.contracts.some((x) => x.id === a.contractId))) {
      rows.push({ contract: a.contractId, message: `${a.tpl}${a.src ? `・${a.src}` : ''}：期間が重なる手修正があります（${a.periodStart}〜${a.periodEnd} と ${b.periodStart}〜${b.periodEnd}）。翌期以降の開始仕訳には、期末が遅いほうだけを引き継ぎます`, warn: true });
    }
    for (const o of gen.overrideMissing || []) rows.push({ contract: o.contractId, message: `${o.tpl}${o.src ? `・${o.src}` : ''}：手修正の対象の仕訳がありません（契約・会計方針・繰越設定の変更で仕訳がなくなった可能性）。手修正を見直してください`, warn: true });
    for (const c of data.contracts) for (const p of c.paymentOverrides || []) {
      const m = ymToIndex(p.ym);
      if (m >= period.start - 0 && m <= period.end) rows.push({ contract: c.id, message: `返済スケジュールの手修正：${p.ym} の支払額を ${fmt(p.amount)} に修正（理由：${p.reason || '—'}）`, warn: true });
    }
    return item('CHK-18', '仕訳・返済スケジュールの手修正', rows.length ? WARN : OK, rows.length ? `${rows.length}件の手修正があります（契約情報の修正で解消できるか確認してください）` : '手修正はありません', rows, '手修正の記録');
  });

  safe('CHK-04', '消去の完全性（連結後のグループ内残高・取引が0）', () => {
    const ws = worksheet(gen, data.companies, pol, names, period);
    const zero = new Set(MUST_BE_ZERO);
    if (pol['POL-04'] === 'reclass') { zero.add('RENTAL_ASSET'); zero.add('RENTAL_ACC'); }
    if (pol['POL-05'] === 'by_lessee_dept') zero.add('RENTAL_DEP');
    const nz = ws.filter((r) => zero.has(r.acc) && r.consol !== 0).map((r) => ({ message: `${r.label}：連結後 ${fmt(r.consol)}` }));
    // 残高が手修正だけによるもの（修正前の計算値では0）なら、NG ではなく確認事項にする
    if (nz.length && gen.journals.some((j) => j.origLines || j.carriedOverride)) {
      const gen0 = { ...gen, journals: gen.journals.filter((j) => !j.carriedOverride).map((j) => (j.origLines ? { ...j, lines: j.origLines } : j)) };
      const ws0 = worksheet(gen0, data.companies, pol, names, period);
      if (!ws0.some((r) => zero.has(r.acc) && r.consol !== 0)) return item('CHK-04', '消去の完全性（連結後のグループ内残高・取引が0）', WARN, `${nz.length}科目で残高が残っています（仕訳の手修正によるもの。修正前の計算値では0）`, nz.map((x) => ({ ...x, warn: true })), 'アプリ計算の個別残高に対する検査');
    }
    return item('CHK-04', '消去の完全性（連結後のグループ内残高・取引が0）', nz.length ? NG : OK, nz.length ? `${nz.length}科目で残高が残っています` : '使用権資産・リース負債・受取リース料・リース負債に係る利息費用等はすべて0（個別欄はアプリの計算値。帳簿との一致は CHK-10）', nz, 'アプリ計算の個別残高に対する検査');
  });

  safe('CHK-05', '消去額の独立組立（期末残高・当期損益から期待値を作り仕訳と比較）', () => {
    const d5 = [];
    for (const r of gen.results) {
      const act = netOf(gen.journals, FLOW_TPLS, r.contract.id);
      for (const d of diffMaps(expectedFlowNet(r, pol, period), act)) d5.push({ contract: r.contract.id, message: `${accName(d.key)}：期待値 ${fmt(d.a)} ≠ 仕訳 ${fmt(d.b)}` });
    }
    return item('CHK-05', '消去額の独立組立（期末残高・当期損益から期待値を作り仕訳と比較）', d5.length ? NG : OK, d5.length ? `${d5.length}件の差異` : '期末残高・当期の損益・前期末残高から独立に組み立てた消去額と、仕訳（月次の取消の集計）が科目・会社別に一致', d5, '別経路で組立');
  });

  safe('CHK-06', '期間の連続性（期首額＝前期末の残高・税率・持分比率から独立に計算した額）', () => {
    const cont = [];
    for (const r of gen.results) {
      const { sched, contract: c } = r;
      const prev = period.start - 1;
      const eo = eFromSchedule(sched, prev, pol);
      for (const k of [c.lesseeCo, c.lessorCo]) {
        const C = co[k];
        const ek = eo[k] || 0;
        const dt = pol['POL-02'] === 'reverse' && C?.taxEffect !== false ? R(ek * rateIndep(C, prev, 'taxRate') * (ek > 0 ? (C.dtaRatio ?? 1) : 1)) : 0;
        if ((r.E.open[k] || 0) !== ek) cont.push({ contract: c.id, message: `${C?.name || k}：期首の純資産修正額 ${fmt(r.E.open[k])} ≠ 前期末残高から求めた額 ${fmt(ek)}` });
        if ((r.DT.open[k] || 0) !== dt) cont.push({ contract: c.id, message: `${C?.name || k}：期首税効果 ${fmt(r.DT.open[k])} ≠ ${fmt(dt)}` });
      }
      const n = nciExpected(sched, co, pol, prev, R);
      if ((r.NCI.open[c.lesseeCo] || 0) !== n.N) cont.push({ contract: c.id, message: `期首非支配株主持分 ${fmt(r.NCI.open[c.lesseeCo])} ≠ 独立計算 ${fmt(n.N)}` });
      if ((r.cap?.open || 0) !== n.cap) cont.push({ contract: c.id, message: `期首の持分変動累計（資本剰余金）${fmt(r.cap?.open)} ≠ 独立計算 ${fmt(n.cap)}` });
      // 開始仕訳に資本剰余金（持分変動の累計）が引き継がれているか
      if (pol['POL-03'] !== 'balance') {
        const capLine = gen.journals.filter((j) => j.contractId === c.id && j.tpl === 'C-01N' && !j.carriedOverride).flatMap((j) => j.origLines || j.lines).filter((l) => l.acc === 'CAP_SURPLUS').reduce((a, l) => a + l.amt, 0);
        if (capLine !== n.cap) cont.push({ contract: c.id, message: `開始仕訳の資本剰余金 ${fmt(capLine)} ≠ 前期末までの持分変動累計 ${fmt(n.cap)}` });
      }
    }
    return item('CHK-06', '期間の連続性（期首額＝前期末の残高・税率・持分比率から独立に計算した額）', cont.length ? NG : OK, cont.length ? `${cont.length}件の不一致` : '開始仕訳・期首税効果・期首非支配株主持分・資本剰余金（持分変動）の引継ぎが独立計算と一致', cont, '別経路で計算');
  });

  safe('CHK-07', 'スケジュールの完結性と現在価値・償却累計額の独立再計算', () => {
    const sc = [];
    for (const r of gen.results) {
      const { sched, contract: c } = r;
      const m = sched.meta;
      if (m.model === 'offbalance') continue;
      if (Math.abs(m.finalResidual || 0) > m.K) sc.push({ contract: c.id, message: `最終回の端数調整額 ${fmt(m.finalResidual)} が支払回数 ${m.K} を超えています（切捨て・切上げや高い利率では生じ得ます。借手の帳簿の端数処理と一致しているか確認してください）`, warn: true });
      for (const ph of m.phases) {
        const rem = ph.rem;
        const regular = rem.length && rem.every((p) => p.amount === rem[0].amount) && (rem[0].t - ph.start) % m.f === 0;
        const override = ph.idx === 0 && m.measSource === 'none' && c.lessee.liabilityOverride !== null && c.lessee.liabilityOverride !== undefined;
        if (regular && ph.rp > 0) {
          const k0 = (rem[0].t - ph.start) / m.f;
          const L0calc = R(rem[0].amount * (1 - Math.pow(1 + ph.rp, -rem.length)) / ph.rp * Math.pow(1 + ph.rp, 1 - k0));
          const label = ph.idx === 0 ? '当初リース負債' : `条件変更後（${indexToJp(ph.start)}）の再測定額`;
          if (!override && Math.abs(L0calc - ph.L0) > 1) sc.push({ contract: c.id, message: `${label}：年金現価の公式 ${fmt(L0calc)} ≠ スケジュール ${fmt(ph.L0)}` });
          if (override && L0calc !== ph.L0) sc.push({ contract: c.id, message: `取込値（借手の帳簿）${fmt(ph.L0)} と再計算値 ${fmt(L0calc)} に差異 ${fmt(ph.L0 - L0calc)}。割引率・支払条件を確認してください`, warn: true });
        }
      }
      if (m.model === 'jgaap' && !m.modifications.length) {
        const endRec = sched.byIndex(Math.min(period.end, m.lastIdx));
        if (endRec && period.end >= m.measStart && period.end <= m.lastIdx && !endRec.lessee.term) {
          const s0 = ymToIndex(c.commencement);
          const from = m.retro ? s0 : m.measStart;
          const months = m.retro ? c.termMonths : c.lessee.depMonths || (s0 + c.termMonths - m.measStart);
          const expAcc = R((m.C0 * Math.min(period.end - from + 1, months)) / months);
          if (expAcc !== endRec.lessee.acc_end) sc.push({ contract: c.id, message: `減価償却累計額：取得原価 ${fmt(m.C0)} × 経過月数 ÷ 償却月数 ${months} ＝ ${fmt(expAcc)} ≠ スケジュール ${fmt(endRec.lessee.acc_end)}` });
        }
      }
      if (!c.terminationYm && !m.modifications.length) {
        const remTotal = m.phases[0].rem.reduce((a, p) => a + p.amount, 0);
        if (m.totalInterest !== remTotal - m.L0) sc.push({ contract: c.id, message: `利息総額 ${fmt(m.totalInterest)} ≠ 支払総額 ${fmt(remTotal)} − 当初負債 ${fmt(m.L0)}` });
      }
    }
    const ng = sc.filter((x) => !x.warn);
    return item('CHK-07', 'スケジュールの完結性と現在価値・償却累計額の独立再計算', ng.length ? NG : sc.length ? WARN : OK, ng.length ? `${ng.length}件の不一致` : sc.length ? `${sc.length}件の確認事項` : '当初・条件変更後のリース負債が年金現価の公式と一致、償却累計額・利息総額も一致', sc, '公式による再計算');
  });

  safe('CHK-08', '貸手資産の按分比率（二重計上の防止）', () => {
    const over = [];
    const byAsset = new Map();
    for (const r of gen.results) {
      const c = r.contract, a = c.lessor || {};
      if (!(a.assetCost > 0) || !a.assetId) continue;
      (byAsset.get(a.assetId) || byAsset.set(a.assetId, []).get(a.assetId)).push({ c, start: r.sched.meta.start, end: r.sched.meta.lastIdx, ratio: a.ratio ?? 1, cost: a.assetCost });
    }
    for (const [id, list] of byAsset) {
      if (new Set(list.map((x) => x.cost)).size > 1) over.push({ message: `貸手資産 ${id}：契約によって取得原価が異なります（${list.map((x) => `${x.c.id}=${fmt(x.cost)}`).join('、')}）` });
      // 選択中の期間の各月で、同時に有効な契約の按分比率の合計を確認
      for (let m = period.start; m <= period.end; m++) {
        const sum = list.filter((x) => x.start <= m && m <= x.end).reduce((a, x) => a + x.ratio, 0);
        if (sum > 1 + 1e-9) { over.push({ message: `貸手資産 ${id}：${indexToJp(m)} に同時に有効な契約の按分比率合計 ${(sum * 100).toFixed(1)}%（100%超）` }); break; }
      }
    }
    return item('CHK-08', '貸手資産の按分比率（二重計上の防止）', over.length ? NG : OK, over.length ? '按分比率・取得原価に問題のある資産があります' : '同時に有効な契約の按分比率合計はすべて100%以下、取得原価も一致', over, '入力の検査');
  });

  safe('CHK-09', '決算日の差異による不一致（POL-08）', () => {
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
          const ev = r.sched.months.filter((x) => x.m >= gapStart && x.m <= period.end && (x.lessee.commence || x.lessee.term || x.lessee.remeasure));
          fy.push({ contract: c.id, message: `${who}（${co[code]?.name}）は${fe}月決算。差異期間（${indexToJp(gapStart)}〜${indexToJp(period.end)}）${ev.length ? `に${ev.map((x) => (x.lessee.commence ? '開始' : x.lessee.remeasure ? '条件変更' : '終了')).join('・')}があり、重要な不一致の調整を検討してください` : 'に新規・解約・条件変更はありません'}`, warn: ev.length > 0 });
        }
      }
    }
    const w = fy.filter((x) => x.warn);
    return item('CHK-09', '決算日の差異による不一致（POL-08）', w.length ? WARN : OK, pol['POL-08'] === 'provisional' ? '方針「仮決算」：全社を連結決算日で計算しています' : w.length ? `${w.length}件の調整候補` : fy.length ? '決算日の異なる会社はありますが、差異期間に新規・解約・条件変更はありません' : '決算日の異なる会社はありません', fy, '差異期間のイベント検出');
  });

  safe('CHK-10', '個別の帳簿残高（実績）との突合', () => {
    const act = [];
    const key = indexToYm(period.end);
    const fullYear = period.end - period.start === 11;
    let missing = 0;
    for (const r of gen.results) {
      const c = r.contract;
      const a2 = (c.actuals || {})[key];
      if (!a2) { if (r.ps.activeMonths > 0) { missing++; act.push({ contract: c.id, message: `${key} 末の実績が未入力です（未突合）`, warn: true }); } continue; }
      const cl = r.ps.close;
      const cmp = [['リース負債', a2.L, cl.L], ['使用権資産簿価', a2.rouNet, cl.cost - cl.acc], ['リース負債のうち流動', a2.cur, r.cur], ['貸手の未収リース料', a2.R, cl.R]];
      if (fullYear) cmp.push(['受取リース料（年度）', a2.inc, r.ps.inc]);
      else if (period.fyEnd === period.end) cmp.push(['受取リース料（年度）', a2.inc, periodSummary(r.sched, period.end - 11, period.end).inc]);
      for (const [nm, book, app] of cmp) {
        if (book === undefined || book === null || book === '') continue;
        if (Number(book) !== app) act.push({ contract: c.id, message: `${nm}：個別帳簿 ${fmt(Number(book))} ／ アプリ計算 ${fmt(app)} ／ 差異 ${fmt(Number(book) - app)}` });
        else act.push({ contract: c.id, message: `${nm}：一致（${fmt(app)}）`, ok: true });
      }
    }
    const ng = act.filter((x) => !x.ok && !x.warn);
    return item('CHK-10', '個別の帳簿残高（実績）との突合', ng.length ? NG : missing ? WARN : OK, ng.length ? `${ng.length}件の差異。原因を調査し個社修正を検討してください` : missing ? `${missing}契約が未突合（実績未入力）。入力済みの契約は一致` : '有効な全契約で実績と一致', act, '外部（個別帳簿）との突合');
  });

  safe('CHK-11', '税効果・非支配株主持分・資本剰余金の期末残高検証', () => {
    const tx = [];
    for (const r of gen.results) {
      const { sched, contract: c } = r;
      const es = eFromSchedule(sched, period.end, pol);
      const dtaNet = netOf(gen.journals, TAX_TPLS, c.id);
      const nciNet = netOf(gen.journals, NCI_TPLS, c.id);
      for (const k of [c.lesseeCo, c.lessorCo]) {
        const C = co[k];
        const ek = es[k] || 0;
        const t = pol['POL-02'] === 'reverse' && C?.taxEffect !== false ? rateIndep(C, period.end, 'taxRate') : 0;
        const expDT = R(ek * t * (ek > 0 ? (C?.dtaRatio ?? 1) : 1));
        const gotDT = -(dtaNet.get(`DTA|${k}`) || 0);
        if (expDT !== gotDT) tx.push({ contract: c.id, message: `${C?.name || k}：期末の税効果取消額 期待値 ${fmt(expDT)}（残高 ${fmt(ek)}×${(t * 100).toFixed(2)}%）≠ 仕訳累計 ${fmt(gotDT)}` });
      }
      const n = nciExpected(sched, co, pol, period.end, R);
      const gotN = -(nciNet.get(`NCI|${c.lesseeCo}`) || 0);
      const gotCap = nciNet.get(`CAP_SURPLUS|${c.lesseeCo}`) || 0;
      if (n.N !== gotN) tx.push({ contract: c.id, message: `期末の非支配株主持分 期待値 ${fmt(n.N)}（基礎＝借手・貸手の税効果後修正額の合計 × 借手の比率）≠ 仕訳累計 ${fmt(gotN)}` });
      if (n.cap !== gotCap) tx.push({ contract: c.id, message: `持分変動（資本剰余金）の累計 期待値 ${fmt(n.cap)} ≠ 仕訳累計 ${fmt(gotCap)}` });
      if (pol['POL-14'] === 'capital' && r.cap?.ref) tx.push({ contract: c.id, message: `資本連結への連携額：持分変動による非支配株主持分の按分替え ${fmt(r.cap.ref)}（累計）を資本連結側で計上してください（本アプリでは計上していません）`, warn: true });
      if (pol['POL-01'] === 'allocate' && (co[c.lessorCo]?.nciRatio || 0) > 0) tx.push({ contract: c.id, message: `貸手（${co[c.lessorCo]?.name}）にも非支配株主がいます。本アプリは借手の比率でのみ按分するため、貸手側の扱いを会計監査人と確認してください`, warn: true });
    }
    const ng11 = tx.filter((x) => !x.warn);
    return item('CHK-11', '税効果・非支配株主持分・資本剰余金の期末残高検証', ng11.length ? NG : tx.length ? WARN : OK, ng11.length ? `${ng11.length}件の不一致` : tx.length ? `${tx.length}件の確認事項（資本連結への連携額・貸手の非支配株主）` : '開始仕訳＋当期仕訳の累計が、期末残高・期末税率・持分比率の推移から独立に計算した額と一致', tx, '別経路で計算');
  });

  safe('CHK-14', 'リース負債の流動部分の独立計算（決算日後1年以内）', () => {
    const cp = [];
    for (const r of gen.results) {
      const { sched, contract: c } = r;
      if (sched.meta.model === 'offbalance') continue;
      const endRec = sched.byIndex(period.end);
      if (!endRec || !endRec.lessee.active || endRec.lessee.term) continue;
      // 決算日時点で有効な契約条件（それ以降の条件変更は未知）で判定
      const known = { ...c, terminationYm: null, modifications: sortedMods(c).filter((x) => ymToIndex(x.ym) <= period.end) };
      const pays = paymentsFromTerms(known, true);
      let last = null;
      for (let mm = period.end + 1; mm <= period.end + 12; mm++) if (pays.has(mm)) last = mm;
      if (last !== null && (last > sched.meta.lastIdx || (c.terminationYm && last >= sched.meta.lastIdx))) continue;
      if (last !== null && sortedMods(c).some((x) => { const t = ymToIndex(x.ym); return t > period.end && t <= last; })) continue; // 1年以内に条件変更があると月次残高が変わるため対象外
      let expCur = 0;
      if (last !== null) {
        const after = c.timing === 'advance' ? (sched.byIndex(last - 1)?.lessee.L_end || 0) - pays.get(last) : sched.byIndex(last)?.lessee.L_end || 0;
        expCur = endRec.lessee.L_end - after;
      }
      const c10 = gen.journals.filter((j) => (j.src || j.tpl) === 'C-10' && j.contractId === c.id && !j.carriedOverride).flatMap((j) => j.origLines || j.lines).filter((l) => l.acc === 'LL_C').reduce((a, l) => a + l.amt, 0);
      if (c10 !== expCur) cp.push({ contract: c.id, message: `流動部分：月次残高から ${fmt(expCur)}（${last !== null ? `${indexToJp(last)}の支払直後の残高との差` : '1年以内の支払なし'}）≠ 仕訳 ${fmt(c10)}` });
    }
    return item('CHK-14', 'リース負債の流動部分の独立計算（決算日後1年以内）', cp.length ? NG : OK, cp.length ? `${cp.length}契約で不一致` : '月次の残高推移から独立に求めた流動部分と C-10 の金額が一致', cp, '別経路で計算');
  });

  safe('CHK-15', '償却・定額費用の独立計算（貸手資産・初期直接費用・ASC842/簡便法の費用）', () => {
    const rows = [];
    for (const r of gen.results) {
      const { sched, contract: c } = r;
      const m = sched.meta;
      const a = c.lessor || {};
      const endRec = sched.byIndex(Math.min(period.end, m.lastIdx));
      if (endRec && period.end <= m.lastIdx) {
        if (a.assetCost > 0 && c.assetClass !== 'land' && a.assetLifeMonths > 0) {
          const k = Math.min(Math.max(period.end - ymToIndex(a.assetStart) + 1, 0), a.assetLifeMonths);
          const exp = R((a.assetCost * k) / a.assetLifeMonths);
          if (exp !== endRec.lessor.assetAcc_end) rows.push({ contract: c.id, message: `貸手資産の償却累計額：${fmt(a.assetCost)}×${k}/${a.assetLifeMonths} ＝ ${fmt(exp)} ≠ スケジュール ${fmt(endRec.lessor.assetAcc_end)}` });
        }
        if (m.idc && endRec.lessee.active && !endRec.lessee.term && !m.modifications.length) {
          const k = Math.min(period.end - m.measStart + 1, m.depMonths);
          const exp = R((m.idc * k) / m.depMonths);
          if (exp !== endRec.lessee.idcAcc_end) rows.push({ contract: c.id, message: `初期直接費用の償却累計額：${fmt(exp)} ≠ スケジュール ${fmt(endRec.lessee.idcAcc_end)}` });
        }
      }
      if ((m.model === 'asc842ol' || m.model === 'offbalance') && !m.modifications.length && !c.terminationYm) {
        const s0 = ymToIndex(c.commencement);
        const total = [...paymentsFromTerms(c)].reduce((x, [, v]) => x + v, 0);
        const cum = (idx) => (idx < s0 ? 0 : R((total * Math.min(idx - s0 + 1, c.termMonths)) / c.termMonths));
        const exp = cum(period.end) - cum(period.start - 1);
        if (exp !== r.ps.cost) rows.push({ contract: c.id, message: `定額のリース費用：総額 ${fmt(total)} × 経過月数 ÷ ${c.termMonths} による当期額 ${fmt(exp)} ≠ スケジュール ${fmt(r.ps.cost)}` });
      }
    }
    return item('CHK-15', '償却・定額費用の独立計算（貸手資産・初期直接費用・ASC842/簡便法の費用）', rows.length ? NG : OK, rows.length ? `${rows.length}件の不一致` : '契約条件から別に計算した償却累計額・定額費用と一致', rows, '別実装で再計算');
  });

  safe('CHK-16', '連結CF消去額の検証（支払＝受取、元本＋利息＝支払）', () => {
    const rows = [];
    const cf = cashFlowEliminations(gen, pol, period);
    let pays = 0;
    for (const r of gen.results) for (const [m, a] of paymentsFromTerms(r.contract)) if (m >= period.start && m <= period.end) pays += a;
    const t = cf.totals;
    if (t.receipts !== pays) rows.push({ message: `貸手の受取 ${fmt(t.receipts)} ≠ 契約条件の支払 ${fmt(pays)}` });
    if (t.repay + t.interestPaid + t.opLease !== pays) rows.push({ message: `借手の元本返済 ${fmt(t.repay)}＋利息 ${fmt(t.interestPaid)}＋その他 ${fmt(t.opLease)} ≠ 支払 ${fmt(pays)}` });
    // 利息の支払額：契約条件の支払を、繰り越した未払利息に先に充当して独立に計算（フリーレント・少額の支払でも成立）
    let expInt = 0;
    for (const r of gen.results) {
      const { sched, contract: c } = r;
      if (sched.meta.model !== 'jgaap') continue;
      const p = paymentsFromTerms(c);
      let unpaid = 0;
      for (let m = sched.meta.measStart; m <= Math.min(period.end, sched.meta.lastIdx); m++) {
        const x = sched.byIndex(m);
        if (!x) continue;
        const pay = p.get(m) || 0;
        let paidInt = 0;
        if (c.timing === 'advance') { paidInt = Math.min(unpaid, pay); unpaid -= paidInt; unpaid += x.lessee.int || 0; }
        else { unpaid += x.lessee.int || 0; paidInt = Math.min(unpaid, pay); unpaid -= paidInt; }
        if (x.lessee.term) unpaid = 0;
        if (m >= period.start) expInt += paidInt;
      }
    }
    if (expInt !== t.interestPaid) rows.push({ message: `利息の支払額：契約条件の支払を未払利息に充当して求めた額 ${fmt(expInt)} ≠ CF消去額 ${fmt(t.interestPaid)}` });
    return item('CHK-16', '連結CF消去額の検証（支払＝受取、元本＋利息＝支払）', rows.length ? NG : OK, rows.length ? `${rows.length}件の不一致` : '借手の支払・貸手の受取が契約条件の支払と一致し、利息の支払額も契約条件の支払と未払利息の繰越から独立に計算した額と一致', rows, '別経路で計算');
  });

  safe('CHK-17', '条件変更・範囲縮小・遡及測定の独立再計算', () => {
    const rows = [];
    const nominal = pol['POL-10'] !== 'effective';
    for (const r of gen.results) {
      const { sched, contract: c } = r;
      const m = sched.meta;
      if (m.model === 'offbalance') continue;
      const s0 = ymToIndex(c.commencement);
      const mods = sortedMods(c);
      const lesseeCo = co[c.lesseeCo];
      // 割引率：契約入力から直接（適用開始前の条件変更の率は使わない）
      let rate = m.measSource === 'contract' ? c.lessee.transition.rate : m.measSource === 'company' ? (c.lessee.transitionRate ?? c.lessee.rate) : c.lessee.rate;
      const rpOf = (x) => (nominal ? (x * c.frequencyMonths) / 12 : Math.pow(1 + x, c.frequencyMonths / 12) - 1);
      const pvAt = (start, pays, x) => {
        const rp = rpOf(x);
        let pv = 0;
        for (const [mm, a] of pays) {
          if (mm < start) continue;
          const t = c.timing === 'advance' ? mm : mm + 1;
          if ((t - start) % c.frequencyMonths !== 0) return null; // 期間の途中で始まる場合は対象外
          pv += a / Math.pow(1 + rp, (t - start) / c.frequencyMonths);
        }
        return R(pv);
      };
      const endOf = (known) => { let N = c.termMonths; for (const x of known) N = x.termMonths ?? N; return s0 + N - 1; };
      for (const ph of m.phases) {
        const known = mods.filter((x) => ymToIndex(x.ym) <= ph.start);
        for (const x of known) if (ymToIndex(x.ym) > m.measStart && ymToIndex(x.ym) <= ph.start && x.rate !== null && x.rate !== undefined) rate = x.rate;
        if (Math.abs(rate - ph.rate) > 1e-12) rows.push({ contract: c.id, message: `${indexToJp(ph.start)}からの割引率：契約入力 ${(rate * 100).toFixed(3)}% ≠ スケジュール ${(ph.rate * 100).toFixed(3)}%` });
        const override = ph.idx === 0 && m.measSource === 'none' && c.lessee.liabilityOverride !== null && c.lessee.liabilityOverride !== undefined;
        const pays = paymentsFromTerms({ ...c, terminationYm: null, modifications: known }, true);
        const pv = pvAt(ph.start, pays, rate);
        if (pv !== null && !override && Math.abs(pv - ph.L0) > 1) rows.push({ contract: c.id, message: `${indexToJp(ph.start)}のリース負債（${ph.idx === 0 ? '当初' : '再測定'}）：契約入力からの現在価値 ${fmt(pv)} ≠ スケジュール ${fmt(ph.L0)}` });
        if (ph.idx > 0 && m.model === 'jgaap') {
          const M = ph.start;
          const prev = sched.byIndex(M - 1), cur = sched.byIndex(M);
          const oldEnd = endOf(mods.filter((x) => ymToIndex(x.ym) < M)), newEnd = endOf(known);
          const keep = newEnd < oldEnd ? (newEnd - M + 1) / (oldEnd - M + 1) : 1;
          const costOut = R(prev.lessee.cost_end * (1 - keep)), accOut = R(prev.lessee.acc_end * (1 - keep)), Lpart = R(prev.lessee.L_end * (1 - keep));
          const rm = cur.lessee.remeasure || {};
          if ((rm.costOut || 0) !== costOut || (rm.accOut || 0) !== accOut || (rm.Lpart || 0) !== Lpart) rows.push({ contract: c.id, message: `${indexToJp(M)}の範囲縮小：取崩（取得原価 ${fmt(costOut)}・累計額 ${fmt(accOut)}・負債 ${fmt(Lpart)}）≠ スケジュール（${fmt(rm.costOut || 0)}・${fmt(rm.accOut || 0)}・${fmt(rm.Lpart || 0)}）` });
          // 変更後の償却累計額：変更時の簿価を残存期間で定額償却
          const accStart = prev.lessee.acc_end - accOut;
          const costStart = prev.lessee.cost_end - costOut + (ph.L0 - (prev.lessee.L_end - Lpart));
          const at = Math.min(period.end, ph.next - 1, m.lastIdx);
          const rec = sched.byIndex(at);
          if (at >= M && rec && !rec.lessee.term) {
            const exp = accStart + R(((costStart - accStart) * Math.min(at - M + 1, newEnd - M + 1)) / (newEnd - M + 1));
            if (exp !== rec.lessee.acc_end) rows.push({ contract: c.id, message: `${indexToJp(at)}末の償却累計額（条件変更後）：変更時の簿価を残存 ${newEnd - M + 1}か月で償却 ${fmt(exp)} ≠ スケジュール ${fmt(rec.lessee.acc_end)}` });
          }
        }
      }
      if (m.retro) {
        const plan0 = paymentsFromTerms({ ...c, terminationYm: null, modifications: mods.filter((x) => ymToIndex(x.ym) <= m.measStart) }, true);
        const c0 = pvAt(s0, plan0, c.lessee.transitionRate ?? c.lessee.rate);
        if (c0 !== null && c0 !== m.C0) rows.push({ contract: c.id, message: `遡及測定の使用権資産（リース開始時の現在価値、適用時の割引率）：${fmt(c0)} ≠ スケジュール ${fmt(m.C0)}` });
      }
      // 満了時の不変条件
      const exp = sched.months.find((x) => x.lessee.term && x.lessee.term.kind === 'expiry');
      if (exp && exp.m <= period.end) {
        if (m.model === 'jgaap' && exp.lessee.term.gain !== 0) rows.push({ contract: c.id, message: `満了時に借手の取崩損益 ${fmt(exp.lessee.term.gain)} が発生しています（償却・負債の計算に誤りの可能性）` });
        if (m.model === 'asc842ol') {
          const totalCost = sched.months.reduce((a, x) => a + (x.lessee.cost || 0), 0);
          const totalPay = sched.months.reduce((a, x) => a + (x.lessee.pay || 0), 0);
          if (totalCost !== totalPay) rows.push({ contract: c.id, message: `ASC842の単一リース費用の総額 ${fmt(totalCost)} ≠ 支払総額 ${fmt(totalPay)}` });
        }
      }
    }
    return item('CHK-17', '条件変更・範囲縮小・遡及測定の独立再計算', rows.length ? NG : OK, rows.length ? `${rows.length}件の不一致` : '各区間の割引率・リース負債、範囲縮小の取崩額、変更後の償却累計額、遡及測定の使用権資産が契約入力からの再計算と一致し、満了時の不変条件も成立', rows, '別経路で計算');
  });

  safe('CHK-12', '棚卸資産に含まれる償却費（POL-12）', () => {
    const note12 = (data.checkNotes || {})['CHK-12'];
    const mfg = data.contracts.filter((c) => c.lessee?.dept === 'mfg').map((c) => ({ contract: c.id, message: `${c.name}：借手は製造部門で使用。期末在庫に含まれる償却費の重要性を確認してください`, warn: !note12 }));
    return item('CHK-12', '棚卸資産に含まれる償却費（POL-12）', mfg.length && !note12 ? WARN : OK, mfg.length ? (note12 ? `判断を記録済み：${note12}` : `${mfg.length}契約が製造部門で使用（方針：${pol['POL-12'] === 'manual' ? '手入力で調整' : '調整しない'}）。重要性の判断を記録してください`) : '製造部門で使用する契約はありません', mfg, '判断の記録');
  });

  safe('CHK-13', '確定済み期間の再現性（確定時のスナップショットと現在の再計算の一致）', () => {
    const lk = [];
    const cache = opts.lockCache;
    for (const l of opts.skipLocks ? [] : data.locks || []) {
      const p = { start: ymToIndex(l.periodStart), end: ymToIndex(l.periodEnd), label: l.label };
      const key = `${l.periodStart}|${l.periodEnd}`;
      let nets = cache?.get(key);
      if (!nets) {
        nets = snapshotNets(generateAll(data, p, pol, { schedCache: opts.schedCache }), pol, names);
        cache?.set(key, nets);
      }
      for (const cid of new Set([...Object.keys(l.snapshot), ...Object.keys(nets)])) {
        const a = new Map(Object.entries(l.snapshot[cid]?.nets || {}));
        const b = new Map(Object.entries(nets[cid]?.nets || {}));
        for (const d of diffMaps(a, b)) lk.push({ contract: cid, message: `${l.label}：${d.key} 確定時 ${fmt(d.a)} → 現在 ${fmt(d.b)}` });
      }
      if (l.snapHash && chainHash('', JSON.stringify(l.snapshot)) !== l.snapHash) lk.push({ contract: '—', message: `${l.label}：確定スナップショットのハッシュが確定時の値と一致しません（スナップショットが編集された可能性）` });
      if (l.imported) lk.push({ contract: '—', message: `${l.label}：取込ファイルの確定スナップショットです（この端末で確定したものではないため未検証）`, warn: true });
      if (l.policies) {
        const changed = Object.keys(l.policies).filter((k) => l.policies[k] !== pol[k]);
        if (changed.length) lk.push({ contract: '—', message: `${l.label}：確定時から会計方針が変更されています（${changed.join('、')}）`, warn: true });
      }
    }
    const ng = lk.filter((x) => !x.warn);
    return item('CHK-13', '確定済み期間の再現性（確定時のスナップショットと現在の再計算の一致）', ng.length ? NG : lk.length ? WARN : OK, ng.length ? `確定済み期間の数値・表示科目が ${ng.length}件変わっています。変更を取り消すか、理由を記録して確定を解除してください` : lk.length ? '数値は一致していますが、確定時から会計方針が変更されています' : (data.locks || []).length ? `確定済み ${(data.locks || []).length} 期間すべてで再計算結果が確定時と一致` : '確定済みの期間はありません', lk, '確定値との比較');
  });

  const order = ['CHK-00', 'CHK-18', 'CHK-01', 'CHK-02', 'CHK-03', 'CHK-04', 'CHK-05', 'CHK-06', 'CHK-07', 'CHK-17', 'CHK-08', 'CHK-09', 'CHK-10', 'CHK-11', 'CHK-14', 'CHK-15', 'CHK-16', 'CHK-12', 'CHK-13'];
  return out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** 期間確定用：契約別・「表示科目名|会社」別の仕訳純額（手入力仕訳は仕訳ID単位） */
export function snapshotNets(gen, pol = {}, names = {}) {
  const out = Object.create(null);
  for (const j of gen.journals) {
    const cid = j.manual ? `手入力:${j.id}` : j.contractId || '—';
    if (!out[cid]) out[cid] = { nets: Object.create(null) };
    for (const l of j.lines) {
      const k = `${j.kind === 'IND' ? '[個社]' : ''}${accountLabel(l, pol, names)}|${l.co}`;
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
