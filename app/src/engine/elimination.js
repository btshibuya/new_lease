// 個社修正仕訳・連結修正仕訳の生成（共通部品）
// 方針：連結修正は「個別で計上された仕訳を取り消す（逆仕訳）」ことで作成し、
// 各明細に根拠（どの月の・どの個別仕訳の取消か、計算式）を持たせる。
import { buildSchedule, currentPortion, periodSummary } from './schedule.js';
import { ACCOUNTS, accountLabel, metaOf, rateAt } from './accounts.js';
import { eFromSchedule } from './reports.js';
import { round, indexToJp, indexToYm, ymToIndex, fmt } from './util.js';

export const TEMPLATES = {
  'IND-01': { kind: 'IND', title: '科目組替（個別の旧科目→連結科目）' },
  'IND-02': { kind: 'IND', title: 'リース負債の流動・固定区分' },
  'C-01': { kind: 'CON', title: '開始仕訳（前期末までの累計の引継）' },
  'C-01T': { kind: 'CON', title: '開始仕訳（税効果）' },
  'C-01N': { kind: 'CON', title: '開始仕訳（非支配株主持分）' },
  'C-02': { kind: 'CON', title: '新規契約（リース開始）の消去' },
  'C-03': { kind: 'CON', title: '使用権資産の減価償却費の消去' },
  'C-04': { kind: 'CON', title: 'リース料（利息・元本返済・受取リース料）の消去' },
  'C-17': { kind: 'CON', title: '解約・満了時の取崩し・違約金の消去' },
  'C-20': { kind: 'CON', title: '条件変更・再測定の消去' },
  'C-10': { kind: 'CON', title: 'リース負債の流動・固定組替（消去）' },
  'C-11': { kind: 'CON', title: '貸手資産の表示組替（連結上の自己使用資産）' },
  'C-12': { kind: 'CON', title: '貸手減価償却費の表示組替（借手の使用部門）' },
  'C-13': { kind: 'CON', title: '税効果（個別税効果の取消・当期分）' },
  'C-14': { kind: 'CON', title: '非支配株主持分への按分（当期分）' },
  'C-B': { kind: 'CON', title: '期末残高一括消去' },
  'C-BT': { kind: 'CON', title: '期末残高一括消去（税効果）' },
  'C-BN': { kind: 'CON', title: '期末残高一括消去（非支配株主持分）' },
  'M-01': { kind: 'CON', title: '手入力仕訳' },
  'M-01O': { kind: 'CON', title: '手入力仕訳（前期以前分の開始仕訳）' },
};

function ln(acc, co, amt, meta, basis) {
  return { acc, co, amt, meta, basis };
}
const pct = (v) => `${(v * 100).toFixed(2)}%`;

/**
 * 1か月分の「個別仕訳の取消」明細を作る（連結修正の最小単位）。
 * @returns {Array<{tpl:string, lines:Array, note:string}>}
 */
export function monthReversals(rec, sched, pol) {
  const c = sched.contract;
  const meta = metaOf(c);
  const le = rec.lessee;
  const lo = rec.lessor;
  const lesseeCo = c.lesseeCo;
  const lessorCo = c.lessorCo;
  const out = [];
  const when = indexToJp(rec.m);
  const model = sched.meta.model;

  if (le.commence) {
    const lines = [
      ln('LL_NC', lesseeCo, le.commence.L0, meta, `リース負債の当初測定額 ${fmt(le.commence.L0)}（リース料の現在価値）`),
      ln('ROU_COST', lesseeCo, -le.commence.L0, meta, '使用権資産のうちリース負債相当額'),
    ];
    if (le.commence.retroAcc) {
      lines.push(ln('ROU_ACC', lesseeCo, le.commence.retroAcc, meta, `適用開始時の減価償却累計額 ${fmt(le.commence.retroAcc)}（リース開始時から適用していたとみなした額）`));
      lines.push(ln('ROU_COST', lesseeCo, -(le.commence.C0 - le.commence.L0), meta, '使用権資産のうちリース負債を超える部分（遡及測定）'));
      const reEff = le.commence.C0 - le.commence.retroAcc - le.commence.L0;
      if (reEff) lines.push(ln('RE_OPEN', lesseeCo, reEff, meta, `借手が適用初年度の期首利益剰余金で処理した累積的影響額 ${fmt(reEff)} の取消`));
    }
    if (le.commence.idc > 0) {
      if (pol['POL-07'] === 'capitalize') lines.push(ln('OTHER_ASSET', lesseeCo, le.commence.idc, meta, '初期直接費用を長期前払費用へ組替（POL-07）'));
      else lines.push(ln('IDC_EXP', lesseeCo, le.commence.idc, meta, '初期直接費用を連結上は発生時の費用とする（POL-07）'));
      lines.push(ln('ROU_COST', lesseeCo, -le.commence.idc, meta, '使用権資産のうち初期直接費用'));
    }
    out.push({ tpl: 'C-02', lines, note: `${when} リース開始（借手の計上：使用権資産／リース負債）の取消` });
  }

  if (model === 'jgaap' && le.active) {
    if (le.dep) {
      const lines = [
        ln('ROU_ACC', lesseeCo, le.dep, meta, `月次償却額＝取得原価 ${fmt(sched.meta.C0)} × 経過月数 ÷ ${sched.meta.depMonths}か月（累計で端数処理）`),
        ln('DEP_ROU', lesseeCo, -le.dep, meta, '借手が計上した使用権資産の減価償却費'),
      ];
      if (pol['POL-07'] === 'capitalize' && le.idcDep) {
        lines.push(ln('DEP_OTHER', lesseeCo, le.idcDep, meta, '初期直接費用部分の償却は連結上も継続（POL-07）'));
        lines.push(ln('OTHER_ACC', lesseeCo, -le.idcDep, meta, '長期前払費用の償却累計額'));
      }
      out.push({ tpl: 'C-03', lines, note: `${when} 減価償却費の取消` });
    }
    if (le.int) {
      out.push({ tpl: 'C-04', lines: [
        ln('LL_NC', lesseeCo, le.int, meta, `利息＝支払間の期首残高 × 利率 ${pct(sched.meta.rp)}／期間（${sched.meta.nominal ? '期間内は定額按分' : '期間内は複利按分'}）`),
        ln('INT', lesseeCo, -le.int, meta, '借手が計上した支払利息'),
      ], note: `${when} 支払利息の取消` });
    }
  }
  if (model === 'asc842ol' && le.active && le.cost) {
    out.push({ tpl: 'C-04', lines: [
      ln('LL_NC', lesseeCo, le.accr, meta, 'リース負債の利息相当の増加（ASC842 オペレーティング・リース）'),
      ln('ROU_COST', lesseeCo, le.cost - le.accr, meta, '使用権資産の償却（単一リース費用−利息相当）'),
      ln('ASC_COST', lesseeCo, -le.cost, meta, `単一リース費用（定額）＝総リース料 ${fmt(sched.meta.totalPayments)} ÷ ${sched.meta.N}か月`),
    ], note: `${when} 単一リース費用の取消` });
  }
  if (model === 'offbalance' && le.active && le.cost) {
    out.push({ tpl: 'C-04', lines: [
      ln('LEASE_ACCRUED', lesseeCo, le.cost, meta, '未払リース料の計上の取消'),
      ln('SHORT_COST', lesseeCo, -le.cost, meta, `リース費用（定額）＝総リース料 ${fmt(sched.meta.totalPayments)} ÷ ${sched.meta.N}か月（短期・少額等の簡便法）`),
    ], note: `${when} リース費用の取消` });
  }

  if (le.remeasure && (model === 'jgaap' || model === 'asc842ol')) {
    const rm = le.remeasure;
    const lines = [];
    if (rm.Lpart || rm.costOut || rm.accOut) {
      lines.push(ln('LL_NC', lesseeCo, -rm.Lpart, meta, `範囲の縮小によるリース負債の減少 ${fmt(rm.Lpart)} の取消`));
      lines.push(ln('ROU_ACC', lesseeCo, -rm.accOut, meta, '範囲の縮小に伴う減価償却累計額の取崩の取消'));
      lines.push(ln('ROU_COST', lesseeCo, rm.costOut, meta, '範囲の縮小に伴う使用権資産の取崩の取消'));
      if (rm.gain) lines.push(ln('MOD_GAIN', lesseeCo, rm.gain, meta, `借手の条件変更損益 ${fmt(rm.gain)} の取消`));
    }
    lines.push(ln('LL_NC', lesseeCo, rm.dL, meta, `再測定によるリース負債の増減 ${fmt(rm.dL)}（変更後の残存リース料の現在価値 ${fmt(rm.Lnew)}、割引率 ${(rm.rate * 100).toFixed(3)}%）の取消`));
    lines.push(ln('ROU_COST', lesseeCo, -rm.dL, meta, '同額の使用権資産の調整の取消'));
    out.push({ tpl: 'C-20', lines, note: `${when} 条件変更（再測定）の取消` });
  }

  // 支払（借手）と受取（貸手）：現金は連結グループ内で相殺されるため、相手勘定どうしを消去
  if (lo.cash) {
    if (le.active && (model === 'jgaap' || model === 'asc842ol')) {
      out.push({ tpl: 'C-04', lines: [
        ln('ACCR_INC', lessorCo, lo.cash, meta, `貸手の入金 ${fmt(lo.cash)}（未収リース料の減少）の取消`),
        ln('LL_NC', lesseeCo, -lo.cash, meta, `借手の支払 ${fmt(lo.cash)}（リース負債の減少）の取消`),
      ], note: `${when} リース料の支払・受取の取消（現金は連結上相殺）` });
    } else if (le.active && model === 'offbalance') {
      out.push({ tpl: 'C-04', lines: [
        ln('ACCR_INC', lessorCo, lo.cash, meta, '貸手の入金の取消'),
        ln('LEASE_ACCRUED', lesseeCo, -lo.cash, meta, '借手の支払（未払リース料の減少）の取消'),
      ], note: `${when} リース料の支払・受取の取消` });
    } else {
      out.push({ tpl: 'C-04', lines: [
        ln('ACCR_INC', lessorCo, lo.cash, meta, '貸手の入金の取消'),
        ln('PRE_RENT', lesseeCo, -lo.cash, meta, '借手が適用開始前（旧基準）に支払時の費用とした支払リース料'),
      ], note: `${when} 適用開始前の支払リース料の取消` });
    }
  }
  if (lo.inc) {
    out.push({ tpl: 'C-04', lines: [
      ln('LEASE_INC', lessorCo, lo.inc, meta, lo.termAdj ? `受取リース料（定額）${fmt(lo.inc - lo.termAdj)}、解約に伴う未収の取崩 ${fmt(lo.termAdj)}` : `受取リース料（定額）＝総リース料 ${fmt(sched.meta.totalPayments)} ÷ ${sched.meta.N}か月`),
      ln('ACCR_INC', lessorCo, -lo.inc, meta, '貸手の収益計上（未収リース料）の取消'),
    ], note: `${when} 受取リース料の取消` });
  }

  if (le.term) {
    const t = le.term;
    const lines = [];
    if (model === 'jgaap') {
      lines.push(ln('ROU_COST', lesseeCo, t.cost, meta, `借手が取り崩した使用権資産の取得原価 ${fmt(t.cost)}`));
      lines.push(ln('ROU_ACC', lesseeCo, -t.acc, meta, `借手が取り崩した減価償却累計額 ${fmt(t.acc)}`));
      lines.push(ln('LL_NC', lesseeCo, -t.L, meta, `借手が取り崩したリース負債 ${fmt(t.L)}`));
      if (t.gain) lines.push(ln('TERM_GAIN', lesseeCo, t.gain, meta, `借手の解約損益 ${fmt(t.gain)}（リース負債−使用権資産簿価）の取消`));
      if (pol['POL-07'] === 'capitalize' && sched.meta.idc > 0) {
        const net = sched.meta.idc - t.idcAcc;
        lines.push(ln('OTHER_ACC', lesseeCo, t.idcAcc, meta, '初期直接費用（長期前払費用）の償却累計額の取崩'));
        if (net) lines.push(ln('TERM_GAIN', lesseeCo, net, meta, '初期直接費用の未償却残高の除却損（連結上）'));
        lines.push(ln('OTHER_ASSET', lesseeCo, -sched.meta.idc, meta, '初期直接費用（長期前払費用）の取崩'));
      }
    } else if (model === 'asc842ol') {
      lines.push(ln('ROU_COST', lesseeCo, t.cost, meta, '借手が取り崩した使用権資産'));
      lines.push(ln('LL_NC', lesseeCo, -t.L, meta, '借手が取り崩したリース負債'));
      if (t.gain) lines.push(ln('TERM_GAIN', lesseeCo, t.gain, meta, '借手の解約損益の取消'));
    } else if (model === 'offbalance' && t.X) {
      lines.push(ln('TERM_GAIN', lesseeCo, t.X, meta, '未払（前払）リース料の取崩の取消'));
      lines.push(ln('LEASE_ACCRUED', lesseeCo, -t.X, meta, '未払リース料'));
    }
    if (le.penalty) {
      lines.push(ln('PENALTY_INC', lessorCo, le.penalty, meta, `貸手の受取違約金 ${fmt(le.penalty)}`));
      lines.push(ln('PENALTY_EXP', lesseeCo, -le.penalty, meta, `借手の支払違約金 ${fmt(le.penalty)}（現金は連結上相殺）`));
    }
    if (lines.length) out.push({ tpl: 'C-17', lines, note: `${when} ${t.kind === 'termination' ? '中途解約' : '満了'}による取崩の取消` });
  }
  return out;
}

/** 明細を (科目・会社・表示メタ) で集約 */
export function aggregate(lines) {
  const map = new Map();
  for (const l of lines) {
    const k = `${l.acc}|${l.co}|${l.label || ''}|${l.meta?.contractId || ''}|${l.meta?.assetClass || ''}|${l.meta?.lesseeDept || ''}|${l.meta?.lessorIncClass || ''}|${l.meta?.lessorDepClass || ''}`;
    const cur = map.get(k);
    if (cur) {
      cur.amt += l.amt;
      if (l.basis && !cur.bases.includes(l.basis)) cur.bases.push(l.basis);
    } else map.set(k, { acc: l.acc, co: l.co, amt: l.amt, meta: l.meta, label: l.label, bases: l.basis ? [l.basis] : [] });
  }
  return [...map.values()].filter((x) => x.amt !== 0);
}

function isBS(acc) { return ACCOUNTS[acc]?.type === 'BS'; }
const EQUITY = new Set(['RE_OPEN', 'NCI', 'CAP_SURPLUS']);

/**
 * 非支配株主持分の時系列（POL-01・POL-14）。
 * 按分の基礎＝借手と貸手の純資産修正額の合計（借手費用−貸手の定額収益の累計）から税効果を控除した額。
 * 受払のタイミング差（定額法と現金の差）は債権債務の相殺消去と同じ性質のため、合計することで按分対象から除かれる。
 * 比率は借手会社の非支配株主持分比率。比率が変わった月の前月末の基礎額×比率の差を「持分変動」として区分する。
 */
export function nciAt(sched, coMap, pol, idx) {
  const c = sched.contract;
  if (pol['POL-01'] !== 'allocate') return { N: 0, cap: 0 };
  const R = (v) => round(v, pol['POL-11'] || 'half_up');
  const L = coMap[c.lesseeCo];
  const baseAt = (t) => {
    const e = eFromSchedule(sched, t, pol);
    let b = 0;
    for (const co of [c.lesseeCo, c.lessorCo]) b += (e[co] || 0) - taxOf(coMap[co], e[co] || 0, t, pol, R);
    return b;
  };
  const changes = (L?.history || []).map((h) => ymToIndex(h.fromYm)).filter((t) => t <= idx).sort((a, b) => a - b);
  let cap = 0;
  if (pol['POL-14'] !== 'capital') {
    for (const t of changes) {
      const n0 = rateAt(L, t - 1, 'nciRatio'), n1 = rateAt(L, t, 'nciRatio');
      if (n0 !== n1) { const b = baseAt(t - 1); cap += R(n1 * b) - R(n0 * b); }
    }
  } else {
    // 持分変動の按分替えは資本連結側で行う：アプリは持分変動分を計上しない（参考額のみ）
    let ref = 0;
    for (const t of changes) {
      const n0 = rateAt(L, t - 1, 'nciRatio'), n1 = rateAt(L, t, 'nciRatio');
      if (n0 !== n1) { const b = baseAt(t - 1); ref += R(n1 * b) - R(n0 * b); }
    }
    return { N: R(rateAt(L, idx, 'nciRatio') * baseAt(idx)) - ref, cap: 0, capRef: ref };
  }
  return { N: R(rateAt(L, idx, 'nciRatio') * baseAt(idx)), cap };
}

/** 会社別の個別税効果の取消額（純資産修正額×法定実効税率。繰延税金資産側は計上割合を反映） */
export function taxOf(C, e, t, pol, R) {
  if (pol['POL-02'] !== 'reverse' || !C || C.taxEffect === false) return 0;
  const rate = rateAt(C, t, 'taxRate');
  const share = e > 0 ? (C.dtaRatio ?? 1) : 1;
  return R(e * rate * share);
}

/**
 * 1契約・1期間の仕訳を作成
 */
export function contractJournals(c, period, ctx) {
  const { pol, companies } = ctx;
  const coMap = Object.fromEntries(companies.map((x) => [x.code, x]));
  const sched = ctx.schedCache?.get(c.id) || buildSchedule(c, pol, { lesseeCompany: coMap[c.lesseeCo] });
  const meta = metaOf(c);
  const lessee = coMap[c.lesseeCo] || { code: c.lesseeCo };
  const jr = [];
  const cumBefore = [];
  const inPeriod = [];
  const monthDetails = [];
  for (const rec of sched.months) {
    if (rec.m > period.end) break;
    const revs = monthReversals(rec, sched, pol);
    for (const r of revs) {
      for (const l of r.lines) {
        const tagged = { ...l, tpl: r.tpl, m: rec.m };
        if (rec.m < period.start) cumBefore.push(tagged);
        else inPeriod.push(tagged);
      }
      if (rec.m >= period.start) monthDetails.push({ m: rec.m, tpl: r.tpl, note: r.note, lines: r.lines });
    }
  }

  // 会社別の純資産修正額 E（BS科目の消去額の合計：借方＋＝連結純資産の増加）
  const E = (lines, co) => lines.filter((l) => l.co === co && isBS(l.acc) && !EQUITY.has(l.acc)).reduce((a, l) => a + l.amt, 0);
  const all = [...cumBefore, ...inPeriod];
  const cos = [...new Set([c.lesseeCo, c.lessorCo])];
  const R = (v) => round(v, pol['POL-11'] || 'half_up');
  const openIdx = period.start - 1;
  const closeIdx = period.end;
  const res = { Eopen: {}, Eclose: {}, DTo: {}, DTc: {}, Nopen: {}, Nclose: {}, tO: {}, tC: {}, nO: {}, nC: {} };
  for (const co of cos) {
    const C = coMap[co];
    res.Eopen[co] = E(cumBefore, co);
    res.Eclose[co] = E(all, co);
    res.tO[co] = pol['POL-02'] === 'reverse' && C?.taxEffect !== false ? rateAt(C, openIdx, 'taxRate') : 0;
    res.tC[co] = pol['POL-02'] === 'reverse' && C?.taxEffect !== false ? rateAt(C, closeIdx, 'taxRate') : 0;
    res.DTo[co] = taxOf(C, res.Eopen[co], openIdx, pol, R);
    res.DTc[co] = taxOf(C, res.Eclose[co], closeIdx, pol, R);
    res.Nopen[co] = 0; res.Nclose[co] = 0;
  }
  // 非支配株主持分は借手会社に帰属（基礎は借手・貸手の合計）
  const nO = nciAt(sched, coMap, pol, openIdx);
  const nC = nciAt(sched, coMap, pol, closeIdx);
  res.Nopen[c.lesseeCo] = nO.N;
  res.Nclose[c.lesseeCo] = nC.N;
  res.nO[c.lesseeCo] = pol['POL-01'] === 'allocate' ? rateAt(coMap[c.lesseeCo], openIdx, 'nciRatio') : 0;
  res.nC[c.lesseeCo] = pol['POL-01'] === 'allocate' ? rateAt(coMap[c.lesseeCo], closeIdx, 'nciRatio') : 0;
  const capOpen = nO.cap, capClose = nC.cap;

  const mk = (tpl, lines, extra = {}) => {
    const agg = aggregate(lines);
    if (!agg.length) return null;
    return { id: `${period.label}-${c.id}-${tpl}`, tpl, kind: TEMPLATES[tpl].kind, title: TEMPLATES[tpl].title, contractId: c.id, lessorCo: c.lessorCo, lesseeCo: c.lesseeCo, lines: agg, ...extra };
  };
  const nm = (co) => coMap[co]?.name || co;

  // ── 開始仕訳 ──
  const openBS = cumBefore.filter((l) => isBS(l.acc));
  const opening = [...openBS];
  for (const co of cos) {
    const reCo = -openBS.filter((l) => l.co === co).reduce((a, l) => a + l.amt, 0);
    if (reCo) opening.push(ln('RE_OPEN', co, reCo, meta, `前期末までの損益消去額の累計＝${nm(co)}の純資産修正額 ${fmt(res.Eopen[co])} の連結上の利益剰余金への影響`));
  }
  const openingT = [];
  const openingN = [];
  for (const co of cos) {
    if (res.DTo[co]) {
      openingT.push(ln('RE_OPEN', co, res.DTo[co], meta, `前期末の取消対象税効果＝${nm(co)}の純資産修正額 ${fmt(res.Eopen[co])} × 前期末の税率 ${pct(res.tO[co])}`));
      openingT.push(ln('DTA', co, -res.DTo[co], meta, `${nm(co)} の繰延税金資産（負債）の取消`));
    }
  }
  if (res.Nopen[c.lesseeCo] || capOpen) {
    const reN = res.Nopen[c.lesseeCo] - capOpen;
    if (reN) openingN.push(ln('RE_OPEN', c.lesseeCo, reN, meta, `前期末までに非支配株主に帰属させた損益の累計（基礎＝借手・貸手の税効果後修正額の合計 × 借手の非支配株主持分比率）`));
    if (capOpen) openingN.push(ln('CAP_SURPLUS', c.lesseeCo, capOpen, meta, `前期末までの持分変動による按分替えの累計 ${fmt(capOpen)}（資本剰余金）`));
    if (res.Nopen[c.lesseeCo]) openingN.push(ln('NCI', c.lesseeCo, -res.Nopen[c.lesseeCo], meta, `${nm(c.lesseeCo)} の非支配株主持分（前期末 ${fmt(res.Nopen[c.lesseeCo])}）`));
  }

  // ── 当期仕訳 ──
  const byTpl = {};
  for (const l of inPeriod) (byTpl[l.tpl] ||= []).push(l);
  const taxLines = [];
  const nciLines = [];
  for (const co of cos) {
    const dDT = res.DTc[co] - res.DTo[co];
    if (dDT) {
      const rateNote = res.tO[co] !== res.tC[co] ? `（税率変更 ${pct(res.tO[co])}→${pct(res.tC[co])} の影響を含む）` : '';
      taxLines.push(ln('TAX_ADJ', co, dDT, meta, `当期の増減＝期末 ${fmt(res.Eclose[co])}×${pct(res.tC[co])}＝${fmt(res.DTc[co])} − 期首 ${fmt(res.DTo[co])}${rateNote}（${nm(co)}）`));
      taxLines.push(ln('DTA', co, -dDT, meta, `${nm(co)} の繰延税金資産（負債）`));
    }
  }
  {
    const co = c.lesseeCo;
    const dN = res.Nclose[co] - res.Nopen[co];
    const capPart = capClose - capOpen;
    const plPart = dN - capPart;
    if (plPart) {
      nciLines.push(ln('NCI_PL', co, plPart, meta, `当期の非支配株主帰属額＝期末 ${fmt(res.Nclose[co])} − 期首 ${fmt(res.Nopen[co])} − 持分変動 ${fmt(capPart)}（基礎＝借手・貸手の税効果後修正額の合計、比率＝借手 ${pct(res.nO[co])}→${pct(res.nC[co])}）`));
      nciLines.push(ln('NCI', co, -plPart, meta, `${nm(co)} の非支配株主持分`));
    }
    if (capPart) {
      nciLines.push(ln('CAP_SURPLUS', co, capPart, meta, `持分比率の変動月の前月末の基礎額 × 比率の差 ＝ ${fmt(capPart)}（資本取引）`));
      nciLines.push(ln('NCI', co, -capPart, meta, `${nm(co)} の非支配株主持分（持分変動）`));
    }
  }

  // ── 組替 ──
  const endRec = sched.byIndex(period.end);
  const activeAtEnd = !!endRec && endRec.lessee.active && !endRec.lessee.term;
  const cur = activeAtEnd ? currentPortion(sched, period.end) : 0;
  const c10 = cur ? [
    ln('LL_C', c.lesseeCo, cur, meta, `借手の流動部分＝期末残高 ${fmt(endRec.lessee.L_end)} − 決算日後1年以内の最終支払直後の残高`),
    ln('LL_NC', c.lesseeCo, -cur, meta, '固定で一括消去した額のうち流動部分を振替'),
  ] : [];
  const r = c.lessor || {};
  const ratio = r.ratio ?? 1;
  const c11 = [];
  const leaseOngoingAtEnd = !!endRec && !endRec.lessee.term;
  if (pol['POL-04'] === 'reclass' && r.assetCost > 0 && leaseOngoingAtEnd) {
    const cost = R(r.assetCost * ratio);
    const acc = R(endRec.lessor.assetAcc_end * ratio);
    c11.push(ln('RECLASS_ASSET', 'CONSOL', cost, meta, `貸手資産の取得原価 ${fmt(r.assetCost)} × 按分比率 ${pct(ratio)}`));
    c11.push(ln('RENTAL_ASSET', c.lessorCo, -cost, meta, '貸手の賃貸資産'));
    if (acc) {
      c11.push(ln('RENTAL_ACC', c.lessorCo, acc, meta, `貸手の減価償却累計額 ${fmt(endRec.lessor.assetAcc_end)} × 按分比率 ${pct(ratio)}`));
      c11.push(ln('RECLASS_ACC', 'CONSOL', -acc, meta, '連結上の自己使用資産の減価償却累計額'));
    }
  }
  const c12 = [];
  if (pol['POL-05'] === 'by_lessee_dept' && r.assetCost > 0) {
    const act = sched.months.filter((x) => x.m >= period.start && x.m <= period.end && x.m >= sched.meta.start);
    const dep = R(act.reduce((a, x) => a + (x.lessor.assetDep || 0), 0) * ratio);
    if (dep) {
      c12.push(ln('DEP_RECLASS', 'CONSOL', dep, meta, `リース期間中（${act.length}か月）の貸手減価償却費 × 按分比率 ${pct(ratio)}`));
      c12.push(ln('RENTAL_DEP', c.lessorCo, -dep, meta, '貸手の減価償却費（賃貸原価等）'));
    }
  }

  if ((pol['POL-03'] || 'opening_flow') === 'balance') {
    for (const [tpl, lines] of [['C-B', [...opening, ...inPeriod]], ['C-BT', [...openingT, ...taxLines]], ['C-BN', [...openingN, ...nciLines]]]) {
      const j = mk(tpl, lines);
      if (j) jr.push(j);
    }
  } else {
    for (const [tpl, lines] of [['C-01', opening], ['C-01T', openingT], ['C-01N', openingN]]) {
      const j = mk(tpl, lines);
      if (j) jr.push(j);
    }
    for (const tpl of ['C-02', 'C-03', 'C-04', 'C-20', 'C-17']) {
      if (byTpl[tpl]) {
        const j = mk(tpl, byTpl[tpl], { details: monthDetails.filter((d) => d.tpl === tpl) });
        if (j) jr.push(j);
      }
    }
    for (const [tpl, lines] of [['C-13', taxLines], ['C-14', nciLines]]) {
      const j = mk(tpl, lines);
      if (j) jr.push(j);
    }
  }
  for (const [tpl, lines] of [['C-10', c10], ['C-11', c11], ['C-12', c12]]) {
    const j = mk(tpl, lines);
    if (j) jr.push(j);
  }

  // ── 個社修正 ──
  if (activeAtEnd && sched.meta.model !== 'offbalance') {
    const curInd = lessee.splitsCurrent === false ? 0 : cur;
    if (lessee.legacyAccounts) {
      const lines = [];
      const L = endRec.lessee.L_end, cost = endRec.lessee.cost_end, acc = endRec.lessee.acc_end;
      if (cost) { lines.push(ln('ROU_COST', c.lesseeCo, cost, meta, '個別の「リース資産」を連結科目「使用権資産」へ')); lines.push(ln('LEGACY_ASSET', c.lesseeCo, -cost, meta, '')); }
      if (acc) { lines.push(ln('LEGACY_ACC', c.lesseeCo, acc, meta, '')); lines.push(ln('ROU_ACC', c.lesseeCo, -acc, meta, '償却累計額の科目組替')); }
      if (L - curInd) { lines.push(ln('LEGACY_LIAB', c.lesseeCo, L - curInd, meta, '個別の「リース債務（固定）」を連結科目「リース負債（固定）」へ')); lines.push(ln('LL_NC', c.lesseeCo, -(L - curInd), meta, '')); }
      if (curInd) { lines.push(ln('LEGACY_LIAB_C', c.lesseeCo, curInd, meta, '個別の「リース債務（流動）」を連結科目「リース負債（流動）」へ')); lines.push(ln('LL_C', c.lesseeCo, -curInd, meta, '')); }
      const j = mk('IND-01', lines, { company: c.lesseeCo });
      if (j) jr.push(j);
    }
    if (lessee.splitsCurrent === false && cur) {
      const j = mk('IND-02', [
        ln('LL_NC', c.lesseeCo, cur, meta, '借手個別で流動区分していないため、1年以内返済額を流動へ'),
        ln('LL_C', c.lesseeCo, -cur, meta, `決算日後1年以内の元本 ${fmt(cur)}`),
      ], { company: c.lesseeCo });
      if (j) jr.push(j);
    }
  }

  const ps = periodSummary(sched, period.start, period.end);
  return {
    contract: c, sched, journals: jr, ps, cur,
    E: { open: res.Eopen, close: res.Eclose }, DT: { open: res.DTo, close: res.DTc }, NCI: { open: res.Nopen, close: res.Nclose },
    rates: { tO: res.tO, tC: res.tC, nO: res.nO, nC: res.nC }, cap: { open: capOpen, close: capClose, ref: nC.capRef || 0 },
    cumBefore, inPeriod, monthDetails, periodStart: period.start, periodEnd: period.end,
  };
}

/** 手入力仕訳を期間に合わせて取り出す（期間内に計上したもの＋「翌期以降に引き継ぐ」ものの開始仕訳） */
export function manualFor(data, period) {
  const out = [];
  const toLines = (m, openAs) => m.lines.map((l) => {
    const pl = ACCOUNTS[l.acc]?.type === 'PL';
    return { acc: openAs && pl ? 'RE_OPEN' : l.acc, label: openAs && pl ? '' : l.label, co: l.co || 'CONSOL', amt: l.amt, meta: { contractId: m.contractId }, bases: [`手入力：${m.reason}${m.evidence ? `（証憑：${m.evidence}）` : ''}${openAs ? '（前期以前の計上分。損益項目は利益剰余金期首残高へ）' : ''}`] };
  });
  for (const m of data.manualJournals || []) {
    const ms = ymToIndex(m.periodStart), me = ymToIndex(m.periodEnd);
    const base = { id: m.id, kind: m.kind === 'IND' ? 'IND' : 'CON', manual: true, contractId: m.contractId || '—', lessorCo: '', lesseeCo: '', reason: m.reason, evidence: m.evidence };
    if (ms >= period.start && me <= period.end) out.push({ ...base, tpl: 'M-01', title: m.title || '手入力仕訳', lines: toLines(m, false) });
    else if (m.carry === 'carry' && me < period.start) out.push({ ...base, id: `${m.id}-open`, tpl: 'M-01O', title: `${m.title || '手入力仕訳'}（開始仕訳）`, lines: toLines(m, true) });
  }
  return out;
}

/** 全契約の仕訳を作成 */
export function generateAll(data, period, pol, opts = {}) {
  const ctx = { pol, companies: data.companies, schedCache: opts.schedCache };
  const results = [];
  const errors = [];
  for (const c of data.contracts) {
    try {
      results.push(contractJournals(c, period, ctx));
    } catch (e) {
      errors.push({ contractId: c.id, message: e.message });
    }
  }
  const journals = results.flatMap((r) => r.journals);
  if (!opts.noManual) journals.push(...manualFor(data, period));
  return { results, journals, errors };
}

/** 仕訳群を科目（表示名）別に集計：{label: amt}（借方＋） */
export function netByAccount(journals, pol, names = {}, filter = () => true) {
  const m = new Map();
  for (const j of journals) {
    if (!filter(j)) continue;
    for (const l of j.lines) {
      const k = `${accountLabel(l, pol, names)}`;
      m.set(k, (m.get(k) || 0) + l.amt);
    }
  }
  return m;
}
