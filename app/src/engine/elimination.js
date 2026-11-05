// 個社修正仕訳・連結修正仕訳の生成（共通部品）
// 方針：連結修正は「個別で計上された仕訳を取り消す（逆仕訳）」ことで作成し、
// 各明細に根拠（どの月の・どの個別仕訳の取消か、計算式）を持たせる。
import { buildSchedule, currentPortion, periodSummary } from './schedule.js';
import { ACCOUNTS, accountLabel, metaOf, rateAt } from './accounts.js';
import { round, indexToJp, indexToYm, fmt } from './util.js';

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
  'C-10': { kind: 'CON', title: 'リース負債の流動・固定組替（消去）' },
  'C-11': { kind: 'CON', title: '貸手資産の表示組替（連結上の自己使用資産）' },
  'C-12': { kind: 'CON', title: '貸手減価償却費の表示組替（借手の使用部門）' },
  'C-13': { kind: 'CON', title: '税効果（個別税効果の取消・当期分）' },
  'C-14': { kind: 'CON', title: '非支配株主持分への按分（当期分）' },
  'C-B': { kind: 'CON', title: '期末残高一括消去' },
  'C-BT': { kind: 'CON', title: '期末残高一括消去（税効果）' },
  'C-BN': { kind: 'CON', title: '期末残高一括消去（非支配株主持分）' },
  'M-01': { kind: 'CON', title: '手入力仕訳' },
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

/**
 * 1契約・1期間の仕訳を作成
 */
export function contractJournals(c, period, ctx) {
  const { pol, companies } = ctx;
  const sched = ctx.schedCache?.get(c.id) || buildSchedule(c, pol);
  const meta = metaOf(c);
  const coMap = Object.fromEntries(companies.map((x) => [x.code, x]));
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
  const E = (lines, co) => lines.filter((l) => l.co === co && isBS(l.acc)).reduce((a, l) => a + l.amt, 0);
  const all = [...cumBefore, ...inPeriod];
  const cos = [...new Set([c.lesseeCo, c.lessorCo])];
  const R = (v) => round(v, pol['POL-11'] || 'half_up');
  const openIdx = period.start - 1;
  const closeIdx = period.end;
  const res = { Eopen: {}, Eclose: {}, DTo: {}, DTc: {}, Nopen: {}, Nclose: {}, tO: {}, tC: {}, nO: {}, nC: {} };
  for (const co of cos) {
    const C = coMap[co];
    const taxOn = pol['POL-02'] === 'reverse' && C?.taxEffect !== false;
    res.Eopen[co] = E(cumBefore, co);
    res.Eclose[co] = E(all, co);
    res.tO[co] = taxOn ? rateAt(C, openIdx, 'taxRate') : 0;
    res.tC[co] = taxOn ? rateAt(C, closeIdx, 'taxRate') : 0;
    res.DTo[co] = R(res.Eopen[co] * res.tO[co]);
    res.DTc[co] = R(res.Eclose[co] * res.tC[co]);
    const nciOn = pol['POL-01'] === 'allocate';
    res.nO[co] = nciOn ? rateAt(C, openIdx, 'nciRatio') : 0;
    res.nC[co] = nciOn ? rateAt(C, closeIdx, 'nciRatio') : 0;
    res.Nopen[co] = R((res.Eopen[co] - res.DTo[co]) * res.nO[co]);
    res.Nclose[co] = R((res.Eclose[co] - res.DTc[co]) * res.nC[co]);
  }

  const mk = (tpl, lines, extra = {}) => {
    const agg = aggregate(lines);
    if (!agg.length) return null;
    return { id: `${period.label}-${c.id}-${tpl}`, tpl, kind: TEMPLATES[tpl].kind, title: TEMPLATES[tpl].title, contractId: c.id, lessorCo: c.lessorCo, lesseeCo: c.lesseeCo, lines: agg, ...extra };
  };
  const nm = (co) => coMap[co]?.name || co;

  // ── 開始仕訳 ──
  const openBS = cumBefore.filter((l) => isBS(l.acc));
  const reOpen = -openBS.reduce((a, l) => a + l.amt, 0);
  const opening = [...openBS];
  if (reOpen) opening.push(ln('RE_OPEN', 'CONSOL', reOpen, meta, '前期末までの損益消去額の累計＝連結上の利益剰余金への影響（会社別の純資産修正額の合計）'));
  const openingT = [];
  const openingN = [];
  for (const co of cos) {
    if (res.DTo[co]) {
      openingT.push(ln('RE_OPEN', 'CONSOL', res.DTo[co], meta, `前期末の取消対象税効果＝${nm(co)}の純資産修正額 ${fmt(res.Eopen[co])} × 前期末の税率 ${pct(res.tO[co])}`));
      openingT.push(ln('DTA', co, -res.DTo[co], meta, `${nm(co)} の繰延税金資産（負債）の取消`));
    }
    if (res.Nopen[co]) {
      openingN.push(ln('RE_OPEN', 'CONSOL', res.Nopen[co], meta, `前期末の非支配株主負担＝(${fmt(res.Eopen[co])} − ${fmt(res.DTo[co])}) × 前期末の非支配株主持分比率 ${pct(res.nO[co])}`));
      openingN.push(ln('NCI', co, -res.Nopen[co], meta, `${nm(co)} の非支配株主持分`));
    }
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
      taxLines.push(ln('TAX_ADJ', 'CONSOL', dDT, meta, `当期の増減＝期末 ${fmt(res.Eclose[co])}×${pct(res.tC[co])}＝${fmt(res.DTc[co])} − 期首 ${fmt(res.DTo[co])}${rateNote}（${nm(co)}）`));
      taxLines.push(ln('DTA', co, -dDT, meta, `${nm(co)} の繰延税金資産（負債）`));
    }
    const dN = res.Nclose[co] - res.Nopen[co];
    if (dN) {
      // 当期損益に対応する部分は期末の比率、比率変動による部分は資本剰余金（資本取引）
      const plPart = R(((res.Eclose[co] - res.DTc[co]) - (res.Eopen[co] - res.DTo[co])) * res.nC[co]);
      const capPart = dN - plPart;
      if (plPart) {
        nciLines.push(ln('NCI_PL', 'CONSOL', plPart, meta, `当期の税効果後の修正額 ${fmt((res.Eclose[co] - res.DTc[co]) - (res.Eopen[co] - res.DTo[co]))} × 期末の非支配株主持分比率 ${pct(res.nC[co])}（${nm(co)}）`));
        nciLines.push(ln('NCI', co, -plPart, meta, `${nm(co)} の非支配株主持分`));
      }
      if (capPart) {
        nciLines.push(ln('CAP_SURPLUS', 'CONSOL', capPart, meta, `持分比率の変動 ${pct(res.nO[co])}→${pct(res.nC[co])} × 期首の税効果後修正額 ${fmt(res.Eopen[co] - res.DTo[co])}（資本取引）`));
        nciLines.push(ln('NCI', co, -capPart, meta, `${nm(co)} の非支配株主持分（持分変動）`));
      }
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
    for (const tpl of ['C-02', 'C-03', 'C-04', 'C-17']) {
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
    rates: { tO: res.tO, tC: res.tC, nO: res.nO, nC: res.nC },
    cumBefore, inPeriod, monthDetails, periodStart: period.start, periodEnd: period.end,
  };
}

/** 手入力仕訳を期間に合わせて取り出す */
export function manualFor(data, period) {
  const s = indexToYm(period.start), e = indexToYm(period.end);
  return (data.manualJournals || []).filter((m) => m.periodStart === s && m.periodEnd === e).map((m) => ({
    id: m.id, tpl: 'M-01', kind: 'CON', manual: true, title: m.title || '手入力仕訳', contractId: m.contractId || '—', lessorCo: '', lesseeCo: '',
    reason: m.reason, evidence: m.evidence,
    lines: m.lines.map((l) => ({ acc: l.acc, label: l.label, co: l.co || 'CONSOL', amt: l.amt, meta: { contractId: m.contractId }, bases: [`手入力：${m.reason}${m.evidence ? `（証憑：${m.evidence}）` : ''}`] })),
  }));
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
