// 個社修正仕訳・連結修正仕訳の生成（共通部品）
// 方針：連結修正は「個別で計上された仕訳を取り消す（逆仕訳）」ことで作成し、
// 各明細に根拠（どの月の・どの個別仕訳の取消か、計算式）を持たせる。
import { buildSchedule, currentPortion, periodSummary, lessorDepBetween } from './schedule.js';
import { ACCOUNTS, accountLabel, metaOf, rateAt } from './accounts.js';
import { eFromSchedule } from './reports.js';
import { round, indexToJp, indexToYm, ymToIndex, fmt } from './util.js';

export const TEMPLATES = {
  'IND-01': { kind: 'IND', title: '科目組替（個別の旧科目→連結科目）' },
  'IND-02': { kind: 'IND', title: 'リース負債の流動・固定区分' },
  'C-01': { kind: 'CON', title: '開始仕訳（前期末までの累計の引継）' },
  'C-01T': { kind: 'CON', title: '開始仕訳（税効果）' },
  'C-01N': { kind: 'CON', title: '開始仕訳（非支配株主持分）' },
  'C-01R': { kind: 'CON', title: '洗替（前期末の開始仕訳の戻し）' },
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

/**
 * 連結修正仕訳の翌期への繰越方法（内容別）。
 * carry_reverse：繰越あり－洗替あり（前期末の残高を開始仕訳で引き継ぎ、当期首に洗い替えて、期末に全額を計上し直す）
 * carry：繰越あり－洗替なし（前期末の残高を開始仕訳で引き継ぎ、当期は増減だけを計上する）
 * none：繰越なし（開始仕訳を作らない。期末に当期分だけを計上する）
 * re：翌期の利益剰余金に影響するか（影響する内容を「繰越なし」にすると、翌期の利益剰余金期首が連結上正しくならない）
 */
export const CARRY_MODES = { carry_reverse: '繰越あり－洗替あり', carry: '繰越あり－洗替なし', none: '繰越なし' };
export const CARRY_DEFS = [
  { tpl: 'C-02', default: 'carry', re: true, why: 'リース開始時の取消。初期直接費用・前払リース料・適用時の累積的影響額があると、利益剰余金に影響します。' },
  { tpl: 'C-03', default: 'carry', re: true, why: '減価償却費の取消は損益に影響し、その累計は翌期の利益剰余金期首になります。' },
  { tpl: 'C-04', default: 'carry', re: true, why: 'リース負債に係る利息費用・受取リース料の取消は損益に影響し、その累計は翌期の利益剰余金期首になります。' },
  { tpl: 'C-20', default: 'carry', re: true, why: '条件変更の損益の取消は、翌期の利益剰余金期首に影響します。' },
  { tpl: 'C-17', default: 'carry', re: true, why: '解約損益・違約金の取消は、翌期の利益剰余金期首に影響します。' },
  { tpl: 'C-13', default: 'carry', re: true, why: '法人税等調整額は損益に影響し、繰延税金資産（負債）の残高を引き継ぐ必要があります。' },
  { tpl: 'C-14', default: 'carry', re: true, why: '非支配株主に帰属する損益は、翌期の利益剰余金期首・非支配株主持分に影響します。' },
  { tpl: 'C-10', default: 'none', re: false, why: '貸借対照表の科目どうしの組替のため、期末ごとに組み替え直します（利益剰余金に影響しません）。' },
  { tpl: 'C-11', default: 'none', re: false, why: '貸借対照表の科目どうしの組替のため、期末ごとに組み替え直します（利益剰余金に影響しません）。' },
  { tpl: 'C-12', default: 'none', re: false, fixed: true, why: '損益計算書の科目どうしの組替で、残高が残らないため繰り越しません（変更不可）。' },
];
/** 繰越方法の取得（設定がなければ初期値） */
export function carryModeOf(cfg, tpl) {
  const def = CARRY_DEFS.find((d) => d.tpl === tpl);
  if (!def) return 'carry';
  if (def.fixed) return def.default;
  const v = cfg && cfg[tpl];
  return CARRY_MODES[v] ? v : def.default;
}
/** 翌期の利益剰余金に影響する内容を「繰越なし」にしている設定の警告 */
export function carryWarnings(cfg) {
  return CARRY_DEFS.filter((d) => d.re && carryModeOf(cfg, d.tpl) === 'none').map((d) => `${d.tpl} ${TEMPLATES[d.tpl].title}：翌期の利益剰余金に影響する仕訳を「繰越なし」にしています。翌期の開始仕訳に引き継がれないため、翌期の連結上の利益剰余金期首・残高が正しくなりません（検算 CHK-05 等が NG になります）。`);
}

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
        ln('INT', lesseeCo, -le.int, meta, '借手が計上したリース負債に係る利息費用'),
      ], note: `${when} リース負債に係る利息費用の取消` });
    }
  }
  if (model === 'asc842ol' && le.active && le.cost) {
    out.push({ tpl: 'C-04', lines: [
      ln('LL_NC', lesseeCo, le.accr, meta, 'リース負債の利息相当の増加（ASC842 オペレーティング・リース）'),
      ln('ROU_COST', lesseeCo, le.cost - le.accr, meta, '使用権資産の償却（単一リース費用−利息相当）'),
      ln('ASC_COST', lesseeCo, -le.cost, meta, '単一リース費用（定額：区間内のリース料総額 ÷ 区間の月数。条件変更後は変更日からの残存期間で再計算）'),
    ], note: `${when} 単一リース費用の取消` });
  }
  if (model === 'offbalance' && le.active && le.cost) {
    out.push({ tpl: 'C-04', lines: [
      ln('LEASE_ACCRUED', lesseeCo, le.cost, meta, '未払リース料の計上の取消'),
      ln('SHORT_COST', lesseeCo, -le.cost, meta, 'リース費用（定額：区間内のリース料総額 ÷ 区間の月数。短期・少額等の簡便法）'),
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
      ln('LEASE_INC', lessorCo, lo.inc, meta, lo.termAdj ? `受取リース料（定額）${fmt(lo.inc - lo.termAdj)}、解約に伴う未収の取崩 ${fmt(lo.termAdj)}` : '受取リース料（定額法：収益認識区間のリース料総額 ÷ 区間の月数。区間は開始・条件変更（新たなリース）・貸手のリース期間の終了で区切る）'),
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
  const carryCfg = ctx.carry || {};
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
  // 適用初年度に借手が期首利益剰余金で処理した累積的影響額（遡及測定）：その税効果・非支配株主持分も期首利益剰余金で処理する
  const trans = inPeriod.filter((l) => l.tpl === 'C-02' && l.acc === 'RE_OPEN').reduce((a, l) => a + l.amt, 0);
  const transE = -trans; // 借手の純資産修正額のうち累積的影響額の取消分
  const transDT = transE ? taxOf(coMap[c.lesseeCo], transE, sched.meta.measStart, pol, R) : 0;
  const transN = transE && pol['POL-01'] === 'allocate' ? R((transE - transDT) * rateAt(coMap[c.lesseeCo], sched.meta.measStart, 'nciRatio')) : 0;
  for (const co of cos) {
    const dDT = res.DTc[co] - res.DTo[co];
    if (dDT) {
      const rateNote = res.tO[co] !== res.tC[co] ? `（税率変更 ${pct(res.tO[co])}→${pct(res.tC[co])} の影響を含む）` : '';
      const tr = co === c.lesseeCo ? transDT : 0;
      if (dDT - tr) taxLines.push(ln('TAX_ADJ', co, dDT - tr, meta, `当期の増減＝期末 ${fmt(res.Eclose[co])}×${pct(res.tC[co])}＝${fmt(res.DTc[co])} − 期首 ${fmt(res.DTo[co])}${tr ? ` − 適用時の累積的影響額分 ${fmt(tr)}` : ''}${rateNote}（${nm(co)}）`));
      if (tr) taxLines.push(ln('RE_OPEN', co, tr, meta, `適用時の累積的影響額 ${fmt(transE)} に係る税効果（期首利益剰余金で処理）`));
      taxLines.push(ln('DTA', co, -dDT, meta, `${nm(co)} の繰延税金資産（負債）`));
    }
  }
  {
    const co = c.lesseeCo;
    const dN = res.Nclose[co] - res.Nopen[co];
    const capPart = capClose - capOpen;
    const plPart = dN - capPart - transN;
    if (transN) {
      nciLines.push(ln('RE_OPEN', co, transN, meta, `適用時の累積的影響額（税効果後）× 借手の非支配株主持分比率（期首利益剰余金で処理）`));
      nciLines.push(ln('NCI', co, -transN, meta, `${nm(co)} の非支配株主持分（適用時）`));
    }
    if (plPart) {
      nciLines.push(ln('NCI_PL', co, plPart, meta, `当期の非支配株主帰属額＝期末 ${fmt(res.Nclose[co])} − 期首 ${fmt(res.Nopen[co])} − 持分変動 ${fmt(capPart)}（基礎＝借手・貸手の税効果後修正額の合計、比率＝借手 ${pct(res.nO[co])}→${pct(res.nC[co])}）`));
      nciLines.push(ln('NCI', co, -plPart, meta, `${nm(co)} の非支配株主持分`));
    }
    if (capPart) {
      nciLines.push(ln('CAP_SURPLUS', co, capPart, meta, `持分比率の変動月の前月末の基礎額 × 比率の差 ＝ ${fmt(capPart)}（資本取引）`));
      nciLines.push(ln('NCI', co, -capPart, meta, `${nm(co)} の非支配株主持分（持分変動）`));
    }
  }

  // ── 組替（期末残高型：任意の期末で計算できるようにし、繰越の設定に使う） ──
  const endRec = sched.byIndex(period.end);
  const activeAtEnd = !!endRec && endRec.lessee.active && !endRec.lessee.term;
  const cur = activeAtEnd ? currentPortion(sched, period.end) : 0;
  const r = c.lessor || {};
  const ratio = r.ratio ?? 1;
  const c10At = (idx) => {
    if (idx < sched.meta.firstIdx) return [];
    const er = sched.byIndex(idx);
    const act = !!er && er.lessee.active && !er.lessee.term;
    const cu = act ? currentPortion(sched, idx) : 0;
    return cu ? [
      ln('LL_C', c.lesseeCo, cu, meta, `借手の流動部分＝期末残高 ${fmt(er.lessee.L_end)} − 決算日後1年以内の最終支払直後の残高（${indexToJp(idx)}末）`),
      ln('LL_NC', c.lesseeCo, -cu, meta, '固定で一括消去した額のうち流動部分を振替'),
    ] : [];
  };
  const c11At = (idx) => {
    const out = [];
    if (idx < sched.meta.firstIdx) return out;
    const er = sched.byIndex(idx);
    if (pol['POL-04'] === 'reclass' && r.assetCost > 0 && !!er && !er.lessee.term) {
      const cost = R(r.assetCost * ratio);
      const acc = R(er.lessor.assetAcc_end * ratio);
      out.push(ln('RECLASS_ASSET', 'CONSOL', cost, meta, `貸手資産の取得原価 ${fmt(r.assetCost)} × 按分比率 ${pct(ratio)}`));
      out.push(ln('RENTAL_ASSET', c.lessorCo, -cost, meta, '貸手の賃貸資産'));
      if (acc) {
        out.push(ln('RENTAL_ACC', c.lessorCo, acc, meta, `貸手の減価償却累計額 ${fmt(er.lessor.assetAcc_end)} × 按分比率 ${pct(ratio)}（${indexToJp(idx)}末）`));
        out.push(ln('RECLASS_ACC', 'CONSOL', -acc, meta, '連結上の自己使用資産の減価償却累計額'));
      }
    }
    return out;
  };
  const c10 = c10At(period.end);
  const c11 = c11At(period.end);
  const c12 = [];
  if (pol['POL-05'] === 'by_lessee_dept' && r.assetCost > 0) {
    const act = sched.months.filter((x) => x.m >= period.start && x.m <= period.end && x.m >= sched.meta.start);
    const dep = lessorDepBetween(sched, period.start, period.end, ratio, R); // 累計を丸めた差（区切りによらず合計が一致）
    if (dep) {
      c12.push(ln('DEP_RECLASS', 'CONSOL', dep, meta, `リース期間中（${act.length}か月）の貸手減価償却費（按分後）＝ 期末の償却累計額×按分比率 ${pct(ratio)} − 期首の償却累計額×按分比率（それぞれ端数処理。区切りによらず合計が一致）`));
      c12.push(ln('RENTAL_DEP', c.lessorCo, -dep, meta, '貸手の減価償却費（賃貸原価等）'));
    }
  }
  const neg = (lines, why) => lines.map((l) => ({ ...l, amt: -l.amt, basis: why || `洗替：${l.basis || ''}` }));
  // 開始仕訳（内容別）：前期末までの累計の貸借対照表科目＋会社別の利益剰余金期首
  const openingOf = (lines, src) => {
    const bs = lines.filter((l) => isBS(l.acc));
    const out = [...bs];
    for (const co of [...new Set(bs.map((l) => l.co))]) {
      const re = -bs.filter((l) => l.co === co).reduce((a, l) => a + l.amt, 0);
      if (re) out.push(ln('RE_OPEN', co, re, meta, `${TEMPLATES[src].title}の前期末までの損益の累計（${nm(co)}）＝利益剰余金期首`));
    }
    return out;
  };

  if ((pol['POL-03'] || 'opening_flow') === 'balance') {
    for (const [tpl, lines] of [['C-B', [...opening, ...inPeriod]], ['C-BT', [...openingT, ...taxLines]], ['C-BN', [...openingN, ...nciLines]]]) {
      const j = mk(tpl, lines);
      if (j) jr.push(j);
    }
  } else {
    // 内容別に、繰越の設定に従って「開始仕訳」「洗替」「当期の仕訳」を作る
    const push = (j) => { if (j) jr.push(j); };
    // 前期以前に手修正した仕訳の差額（手修正後−修正前）は、繰越ありの内容なら開始仕訳で引き継ぐ
    const priorOv = carriedOverrides((ctx.overrides || []).filter((o) => o.contractId === c.id && ymToIndex(o.periodEnd) < period.start));
    for (const K of [...new Set(priorOv.map((o) => o.src || o.tpl))]) {
      if (!TEMPLATES[K] || TEMPLATES[K].kind !== 'CON' || K === 'C-12' || carryModeOf(carryCfg, K) === 'none') continue;
      const adj = priorOv.filter((o) => (o.src || o.tpl) === K).flatMap((o) => overrideDiff(o).map((d) => ({ ...ln(d.acc, d.co, d.amt, meta, `手修正の引継（${o.periodStart}〜${o.periodEnd}：${o.reason}）`), tpl: K })));
      const lines = ['C-10', 'C-11'].includes(K) ? adj.filter((l) => isBS(l.acc)) : openingOf(adj, K);
      push(mk('C-01', lines, { src: K, id: `${period.label}-${c.id}-C-01-${K}-ADJ`, title: `開始仕訳：${TEMPLATES[K].title}（前期以前の手修正の引継）`, carriedOverride: true }));
    }
    const openMk = (tpl, src, lines) => mk(tpl, lines, { src, id: `${period.label}-${c.id}-${tpl}-${src}`, title: `開始仕訳：${TEMPLATES[src].title}` });
    const revMk = (src, lines) => mk('C-01R', lines, { src, id: `${period.label}-${c.id}-C-01R-${src}`, title: `洗替：${TEMPLATES[src].title}（前期末の開始仕訳の戻し）` });
    for (const tpl of ['C-02', 'C-03', 'C-04', 'C-20', 'C-17']) {
      const P = cumBefore.filter((l) => l.tpl === tpl);
      const Q = byTpl[tpl] || [];
      const mode = carryModeOf(carryCfg, tpl);
      const det = { details: monthDetails.filter((d) => d.tpl === tpl) };
      if (mode === 'none') { push(mk(tpl, Q, det)); continue; }
      push(openMk('C-01', tpl, openingOf(P, tpl)));
      if (mode === 'carry_reverse') { push(revMk(tpl, neg(P))); push(mk(tpl, [...P, ...Q], { ...det, full: true })); } else push(mk(tpl, Q, det));
    }
    // 税効果：前期末の残高（会社別の繰延税金資産（負債）の取消額）
    const Ptax = cos.flatMap((co) => (res.DTo[co] ? [ln('DTA', co, -res.DTo[co], meta, `前期末の繰延税金資産（負債）の取消（${nm(co)}）`), ln('TAX_ADJ', co, res.DTo[co], meta, `前期末までの法人税等調整額の累計（${nm(co)}）`)] : []));
    {
      const mode = carryModeOf(carryCfg, 'C-13');
      if (mode !== 'none') push(openMk('C-01T', 'C-13', openingT));
      if (mode === 'carry_reverse') { push(revMk('C-13', neg(Ptax))); push(mk('C-13', [...Ptax, ...taxLines], { full: true })); } else push(mk('C-13', taxLines));
    }
    // 非支配株主持分：前期末の残高
    const L0 = c.lesseeCo;
    const Pnci = res.Nopen[L0] || capOpen ? [ln('NCI', L0, -(res.Nopen[L0] || 0), meta, `前期末の非支配株主持分（${nm(L0)}）`), ln('NCI_PL', L0, (res.Nopen[L0] || 0) - capOpen, meta, '前期末までの非支配株主に帰属する損益の累計'), ...(capOpen ? [ln('CAP_SURPLUS', L0, capOpen, meta, '前期末までの持分変動の累計')] : [])] : [];
    {
      const mode = carryModeOf(carryCfg, 'C-14');
      if (mode !== 'none') push(openMk('C-01N', 'C-14', openingN));
      if (mode === 'carry_reverse') { push(revMk('C-14', neg(Pnci))); push(mk('C-14', [...Pnci, ...nciLines], { full: true })); } else push(mk('C-14', nciLines));
    }
    // 期末残高型の組替（C-10・C-11）：前期末の組替額を引き継ぐ場合は、開始仕訳（貸借対照表科目のみ）を作る
    for (const [tpl, full, prev] of [['C-10', c10, c10At(period.start - 1)], ['C-11', c11, c11At(period.start - 1)]]) {
      const mode = carryModeOf(carryCfg, tpl);
      if (mode === 'none' || !prev.length) { push(mk(tpl, full)); continue; }
      push(openMk('C-01', tpl, prev));
      if (mode === 'carry_reverse') { push(revMk(tpl, neg(prev))); push(mk(tpl, full, { full: true })); } else push(mk(tpl, [...full, ...neg(prev, '前期末の組替額（開始仕訳で引継済み）を差し引く')]));
    }
    push(mk('C-12', c12));
  }
  if ((pol['POL-03'] || 'opening_flow') === 'balance') {
    for (const [tpl, lines] of [['C-10', c10], ['C-11', c11], ['C-12', c12]]) {
      const j = mk(tpl, lines);
      if (j) jr.push(j);
    }
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
  const ctx = { pol, companies: data.companies, schedCache: opts.schedCache, carry: data.config?.carry || {}, overrides: data.overrides?.journals || [] };
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
  const missing = applyOverrides(journals, data.overrides?.journals || [], period, data.contracts);
  return { results, journals, errors, overrideMissing: missing };
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

/**
 * 開始仕訳の年度別トレース：開始仕訳（内容別）の金額が、前期以前のどの年度の仕訳から生じたかを年度別に分解する。
 * 年度別の金額の合計は、開始仕訳の金額と一致する（自動テストで確認）。
 * @param r 開始仕訳を含む期間の契約別の計算結果（generateAll の results の要素）
 * @param j 開始仕訳（tpl が C-01／C-01T／C-01N、src が元の内容）
 * @returns {{year:string, co:string, acc:string, amt:number, note:string}[]}
 */
export function openingTrace(r, j, yearPeriods, pol, companies) {
  const coMap = Object.fromEntries(companies.map((x) => [x.code, x]));
  const R = (v) => round(v, pol['POL-11'] || 'half_up');
  const start = r.periodStart;
  const yearOf = (m) => yearPeriods.find((p) => m >= p.start && m <= p.end);
  const ys = yearPeriods.filter((p) => p.start < start);
  const out = [];
  const add = (year, co, acc, amt, note) => { if (amt) out.push({ year, co, acc, amt, note }); };
  const src = j.src;
  const meta = metaOf(r.contract);
  if (['C-02', 'C-03', 'C-04', 'C-20', 'C-17'].includes(src)) {
    const lines = r.cumBefore.filter((l) => l.tpl === src && isBS(l.acc));
    const groups = new Map();
    for (const l of lines) { const y = yearOf(l.m)?.label || '（表示期間より前）'; (groups.get(y) || groups.set(y, []).get(y)).push(l); }
    for (const [y, ls] of groups) {
      const agg = new Map();
      for (const l of ls) agg.set(`${l.acc}|${l.co}`, (agg.get(`${l.acc}|${l.co}`) || 0) + l.amt);
      for (const [k, v] of agg) { const [acc, co] = k.split('|'); add(y, co, acc, v, `${y}の ${src} ${TEMPLATES[src].title}`); }
      for (const co of [...new Set(ls.map((l) => l.co))]) add(y, co, 'RE_OPEN', -ls.filter((l) => l.co === co).reduce((a, l) => a + l.amt, 0), `${y}の ${src} の損益（利益剰余金へ）`);
    }
  } else if (src === 'C-13') {
    const cos = [...new Set([r.contract.lesseeCo, r.contract.lessorCo])];
    const E = (co, idx) => r.cumBefore.filter((l) => l.m <= idx && l.co === co && isBS(l.acc) && !EQUITY.has(l.acc)).reduce((a, l) => a + l.amt, 0);
    for (const co of cos) {
      let prev = 0;
      for (const y of ys) {
        const idx = Math.min(y.end, start - 1);
        const dt = taxOf(coMap[co], E(co, idx), idx, pol, R);
        add(y.label, co, 'DTA', -(dt - prev), `${y.label}の C-13 税効果（期末の取消額 ${fmt(dt)} − 前年度末 ${fmt(prev)}）`);
        add(y.label, co, 'RE_OPEN', dt - prev, `${y.label}の法人税等調整額（利益剰余金へ）`);
        prev = dt;
      }
    }
  } else if (src === 'C-14') {
    const L = r.contract.lesseeCo;
    let pN = 0, pC = 0;
    for (const y of ys) {
      const idx = Math.min(y.end, start - 1);
      const n = nciAt(r.sched, coMap, pol, idx);
      add(y.label, L, 'NCI', -(n.N - pN), `${y.label}の C-14 非支配株主持分の増減`);
      add(y.label, L, 'CAP_SURPLUS', n.cap - pC, `${y.label}の持分変動（資本剰余金）`);
      add(y.label, L, 'RE_OPEN', (n.N - pN) - (n.cap - pC), `${y.label}の非支配株主に帰属する損益（利益剰余金へ）`);
      pN = n.N; pC = n.cap;
    }
  } else {
    // 期末残高型の組替（C-10・C-11）：前期末の組替額をそのまま引き継ぐ
    const y = yearOf(start - 1)?.label || '前期末';
    for (const l of j.lines) add(y, l.co, l.acc, l.amt, `${y}末の ${src} ${TEMPLATES[src].title}`);
  }
  void meta;
  return out;
}

/** 手修正の差額（手修正後−修正前）。科目・会社別 */
export function overrideDiff(o) {
  const m = new Map();
  for (const l of o.lines || []) m.set(`${l.acc}|${l.co}`, (m.get(`${l.acc}|${l.co}`) || 0) + l.amt);
  for (const l of o.orig || []) m.set(`${l.acc}|${l.co}`, (m.get(`${l.acc}|${l.co}`) || 0) - l.amt);
  return [...m].filter(([, v]) => v).map(([k, amt]) => { const [acc, co] = k.split('|'); return { acc, co, amt }; });
}

/** 手修正のキー（期間・契約・内容） */
export const overrideKey = (period, j) => `${indexToYm(period.start)}|${indexToYm(period.end)}|${j.contractId}|${j.tpl}|${j.src || ''}`;

/**
 * 手修正を仕訳に反映する。元の行は origLines に残す（検算はアプリの計算値で行い、手修正は別に警告する）。
 * @returns 対象の仕訳が見つからなかった手修正（契約や設定の変更で内容がなくなった等）
 */
export function applyOverrides(journals, overrides, period, contracts = []) {
  const missing = [];
  const ps = indexToYm(period.start), pe = indexToYm(period.end);
  for (const o of overrides) {
    if (o.periodStart !== ps || o.periodEnd !== pe) continue;
    const j = journals.find((x) => !x.manual && !x.carriedOverride && x.contractId === o.contractId && x.tpl === o.tpl && (x.src || '') === (o.src || ''));
    if (!j) { missing.push(o); continue; }
    const c = contracts.find((x) => x.id === o.contractId);
    const meta = c ? metaOf(c) : {};
    const same = (a, b) => { const k = (ls) => ls.map((l) => `${l.acc}|${l.co}|${l.amt}`).sort().join(','); return k(a) === k(b); };
    j.origLines = j.lines;
    j.override = { key: o.key, reason: o.reason, at: o.at, stale: !same(j.lines, o.orig || []) };
    j.lines = o.lines.filter((l) => l.amt).map((l) => ({ acc: l.acc, co: l.co, amt: l.amt, label: l.label, meta, bases: [`手修正：${o.reason}（${o.at || ''}）`, ...((j.origLines.find((x) => x.acc === l.acc && x.co === l.co)?.bases) || [])] }));
  }
  return missing;
}

/**
 * 手修正した科目から、契約情報・会社マスタのどこを直すべきかの候補を返す。
 * label は編集画面の項目名（ジャンプ先の特定に使う）、page は移動先の画面。
 */
export function overrideSuggestions(diff) {
  const C = (label, why) => ({ page: 'contracts', label, why });
  const M = (label, why) => ({ page: 'companies', label, why });
  const S = (why) => ({ page: 'contracts', label: '返済スケジュール（支払額）の手修正', why, target: 'payment-schedule' });
  const map = {
    LL_C: [S('流動部分は決算日後1年以内の支払予定で決まります'), C('支払間隔', '支払の時期'), C('支払時期', '前払・後払')],
    LL_NC: [C('割引率（年％）', 'リース負債の現在価値'), C('1回あたりリース料', 'リース負債の現在価値'), C('リース期間（月数）', 'リース負債の現在価値'), C('当初リース負債の取込値（空欄＝再計算）', '借手の帳簿値と合わせる'), S('個々の支払額')],
    ROU_COST: [C('当初リース負債の取込値（空欄＝再計算）', '使用権資産＝リース負債＋初期直接費用等'), C('初期直接費用', '使用権資産に含めた額'), C('割引率（年％）', 'リース負債の現在価値')],
    ROU_ACC: [C('償却月数（空欄＝リース期間）', '減価償却の期間'), C('リース開始年月', '償却の開始月')],
    DEP_ROU: [C('償却月数（空欄＝リース期間）', '減価償却の期間'), C('初期直接費用', '償却の基礎')],
    INT: [C('割引率（年％）', '利息の計算'), C('支払時期', '前払・後払で利息が変わります'), S('個々の支払額')],
    LEASE_INC: [C('1回あたりリース料', '貸手の受取額'), C('フリーレント（無償の支払回数）', '定額法の総額'), C('段階賃料（支払回:金額）', '定額法の総額'), C('貸手のリース期間（月数、空欄＝借手と同じ）', '定額法の期間')],
    ACCR_INC: [C('フリーレント（無償の支払回数）', '未収の発生'), C('段階賃料（支払回:金額）', '未収の発生'), C('貸手のリース期間（月数、空欄＝借手と同じ）', '定額法の期間')],
    LEASE_ACCRUED: [C('支払時期', '未払の発生'), S('個々の支払額')],
    RENTAL_ASSET: [C('対象資産の取得原価', '貸手資産'), C('按分比率（％）', '貸手資産の按分')],
    RENTAL_ACC: [C('耐用年数（月数）', '貸手の減価償却'), C('取得年月', '貸手の減価償却')],
    RECLASS_ASSET: [C('対象資産の取得原価', '貸手資産'), C('按分比率（％）', '貸手資産の按分')],
    RECLASS_ACC: [C('耐用年数（月数）', '貸手の減価償却'), C('取得年月', '貸手の減価償却')],
    RENTAL_DEP: [C('耐用年数（月数）', '貸手の減価償却'), C('按分比率（％）', '貸手資産の按分')],
    DEP_RECLASS: [C('使用部門', '組替先の区分')],
    DTA: [M('法定実効税率（％）', '税効果'), M('繰延税金資産の計上割合（％）', '回収可能性'), M('個別で税効果を計上', '取消の要否')],
    TAX_ADJ: [M('法定実効税率（％）', '税効果'), M('繰延税金資産の計上割合（％）', '回収可能性')],
    NCI: [M('非支配株主持分比率（％）', '按分の比率')],
    NCI_PL: [M('非支配株主持分比率（％）', '按分の比率')],
    TERM_GAIN: [C('中途解約年月（任意）', '解約の時期'), C('解約違約金（借手→貸手）', '違約金')],
    PENALTY_EXP: [C('解約違約金（借手→貸手）', '違約金')],
    PENALTY_INC: [C('解約違約金（借手→貸手）', '違約金')],
    MOD_GAIN: [{ page: 'contracts', label: '条件変更・再測定（変更月の月初から適用）', why: '条件変更の内容', target: 'modifications' }],
  };
  const out = [];
  for (const d of diff) for (const x of map[d.acc] || []) if (!out.some((y) => y.label === x.label && y.page === x.page)) out.push({ ...x, acc: d.acc });
  return out;
}

/**
 * 引き継ぐ手修正を選ぶ：同じ契約・内容で期間が重なる手修正（累計の期間どうし、年度と月次など）は、
 * 期末が最も遅いもの（同じなら期間が長いもの）だけを使う（同じ修正が重複して引き継がれるのを防ぐ）。
 */
export function carriedOverrides(list) {
  const out = [];
  const sorted = [...list].sort((a, b) => ymToIndex(b.periodEnd) - ymToIndex(a.periodEnd) || ymToIndex(a.periodStart) - ymToIndex(b.periodStart));
  for (const o of sorted) {
    const s = ymToIndex(o.periodStart), e = ymToIndex(o.periodEnd);
    const overlap = out.some((x) => x.contractId === o.contractId && x.tpl === o.tpl && (x.src || '') === (o.src || '') && s <= ymToIndex(x.periodEnd) && ymToIndex(x.periodStart) <= e);
    if (!overlap) out.push(o);
  }
  return out;
}

/** 期間が重なる手修正（同じ契約・内容）の組 */
export function overlappingOverrides(list) {
  const pairs = [];
  for (let i = 0; i < list.length; i++) for (let k = i + 1; k < list.length; k++) {
    const a = list[i], b = list[k];
    if (a.contractId !== b.contractId || a.tpl !== b.tpl || (a.src || '') !== (b.src || '')) continue;
    if (ymToIndex(a.periodStart) <= ymToIndex(b.periodEnd) && ymToIndex(b.periodStart) <= ymToIndex(a.periodEnd)) pairs.push([a, b]);
  }
  return pairs;
}
