// 自動検算（共通部品）。各検算は独立した計算経路で結果を確かめる。
import { generateAll, aggregate } from './elimination.js';
import { worksheet, MUST_BE_ZERO, cashFlowEliminations } from './reports.js';
import { validateContract } from './schedule.js';
import { round, fmt, ymToIndex, indexToJp, fiscalYearOf } from './util.js';
import { ACCOUNTS } from './accounts.js';

const OK = 'ok', WARN = 'warn', NG = 'ng';

function item(id, title, status, detail, rows = []) {
  return { id, title, status, detail, rows };
}

/**
 * @returns {Array<{id,title,status,detail,rows}>}
 */
export function runChecks(data, period, pol, gen, names = {}) {
  const out = [];
  const tol = 0;

  // CHK-00 入力検証
  const inv = [];
  for (const c of data.contracts) {
    const errs = validateContract(c, data.companies);
    for (const e of errs) inv.push({ contract: c.id, message: e });
  }
  for (const e of gen.errors) inv.push({ contract: e.contractId, message: `計算エラー：${e.message}` });
  out.push(item('CHK-00', '契約データの入力検証', inv.length ? NG : OK, inv.length ? `${inv.length}件の入力エラーがあります` : 'すべての契約が入力ルールを満たしています', inv));

  // CHK-01 貸借一致
  const unbal = gen.journals.filter((j) => j.lines.reduce((a, l) => a + l.amt, 0) !== 0).map((j) => ({ contract: j.contractId, message: `${j.tpl} ${j.title}：差額 ${fmt(j.lines.reduce((a, l) => a + l.amt, 0))}` }));
  out.push(item('CHK-01', '仕訳の貸借一致', unbal.length ? NG : OK, unbal.length ? `${unbal.length}本の仕訳で貸借が一致しません` : `${gen.journals.length}本すべて貸借一致`, unbal));

  // CHK-02 ロールフォワード（リース負債・使用権資産）
  const rf = [];
  for (const r of gen.results) {
    const { ps, sched } = r;
    if (sched.meta.model === 'offbalance') continue;
    const newL = ps.commence ? ps.commence.L0 : 0;
    const newC = ps.commence ? ps.commence.C0 : 0;
    const tL = ps.term ? ps.term.L : 0;
    const tC = ps.term ? ps.term.cost : 0;
    const tA = ps.term ? ps.term.acc : 0;
    const Lcalc = ps.open.L + newL + ps.int + ps.accr - ps.pay - tL;
    if (Lcalc !== ps.close.L) rf.push({ contract: r.contract.id, message: `リース負債：期首 ${fmt(ps.open.L)} ＋新規 ${fmt(newL)} ＋利息 ${fmt(ps.int + ps.accr)} −支払 ${fmt(ps.pay)} −取崩 ${fmt(tL)} ＝ ${fmt(Lcalc)} ≠ 期末 ${fmt(ps.close.L)}` });
    if (sched.meta.model === 'jgaap') {
      const Ccalc = ps.open.cost + newC - tC;
      if (Ccalc !== ps.close.cost) rf.push({ contract: r.contract.id, message: `使用権資産（取得原価）：${fmt(Ccalc)} ≠ 期末 ${fmt(ps.close.cost)}` });
      const Acalc = ps.open.acc + ps.dep - tA;
      if (Acalc !== ps.close.acc) rf.push({ contract: r.contract.id, message: `減価償却累計額：${fmt(Acalc)} ≠ 期末 ${fmt(ps.close.acc)}` });
    }
  }
  out.push(item('CHK-02', 'ロールフォワード（期首＋増加−減少＝期末）', rf.length ? NG : OK, rf.length ? `${rf.length}件の不一致` : 'リース負債・使用権資産・減価償却累計額のすべてで成立', rf));

  // CHK-03 消去差額の恒等式（スケジュールから独立に計算した値と、仕訳から求めた純資産修正額の一致）
  const idt = [];
  for (const r of gen.results) {
    const { sched, contract: c } = r;
    const through = sched.months.filter((x) => x.m <= period.end);
    let expL = 0, inc = 0, gain = 0, idcExp = 0, idcDepKeep = 0, idcWriteOff = 0;
    for (const x of through) {
      const le = x.lessee;
      expL += (le.dep || 0) + (le.int || 0) + (le.cost || 0) + (!le.active ? x.lessor.cash : 0);
      inc += x.lessor.inc || 0;
      if (le.term) gain += le.term.gain || 0;
      if (le.commence && le.commence.idc) idcExp += le.commence.idc;
      if (pol['POL-07'] === 'capitalize') {
        idcDepKeep += le.idcDep || 0;
        if (le.term && sched.meta.idc) idcWriteOff += sched.meta.idc - le.term.idcAcc;
      }
    }
    // 連結上の損益影響（税引前）＝ 消去した借手費用 − 消去した貸手収益 + 消去した解約益(△) − 連結上残す費用
    const plEffect = pol['POL-07'] === 'capitalize'
      ? expL - inc - gain - idcDepKeep - idcWriteOff
      : expL - inc - gain - idcExp;
    const E = (r.E.close[c.lesseeCo] || 0) + (r.E.close[c.lessorCo] || 0);
    const last = through[through.length - 1];
    const bsDirect = last ? (last.lessee.L_end || 0) + (last.lessee.X_end || 0) - ((last.lessee.cost_end || 0) - (last.lessee.acc_end || 0)) - (last.lessor.R_end || 0) + (pol['POL-07'] === 'capitalize' && last.lessee.active && !last.lessee.term ? sched.meta.idc - (last.lessee.idcAcc_end || 0) : 0) : 0;
    if (plEffect !== E || bsDirect !== E) {
      idt.push({ contract: c.id, message: `損益からの計算 ${fmt(plEffect)}、残高からの計算 ${fmt(bsDirect)}、仕訳の純資産修正額 ${fmt(E)} が一致しません` });
    } else {
      idt.push({ contract: c.id, message: `一致：Σ借手費用 ${fmt(expL)} − Σ貸手収益 ${fmt(inc)} − 解約益 ${fmt(gain)}${idcExp && pol['POL-07'] !== 'capitalize' ? ` − 初期直接費用 ${fmt(idcExp)}` : ''} ＝ (リース負債 − 使用権資産簿価 ± 未払/未収) ＝ ${fmt(E)}`, ok: true });
    }
  }
  const idtNg = idt.filter((x) => !x.ok);
  out.push(item('CHK-03', '消去差額の恒等式（損益の累計＝残高の差＝仕訳の純資産修正額）', idtNg.length ? NG : OK, idtNg.length ? `${idtNg.length}契約で不一致` : '全契約で3つの計算経路が一致', idt));

  // CHK-04 消去の完全性（連結後のグループ内残高・取引高が0）
  const ws = worksheet(gen, data.companies, pol, names, period);
  const nz = ws.filter((r) => MUST_BE_ZERO.includes(r.acc) && r.consol !== 0).map((r) => ({ message: `${r.label}：連結後 ${fmt(r.consol)}` }));
  out.push(item('CHK-04', '消去の完全性（連結後のグループ内残高・取引が0）', nz.length ? NG : OK, nz.length ? `${nz.length}科目で残高が残っています` : '使用権資産・リース負債・受取リース料・支払利息等はすべて0', nz));

  // CHK-05 作成方式の一致（開始＋当期方式と期末残高一括方式）
  const other = pol['POL-03'] === 'balance' ? 'opening_flow' : 'balance';
  const gen2 = generateAll(data, period, { ...pol, 'POL-03': other });
  const net = (g) => {
    const m = new Map();
    for (const j of g.journals) for (const l of j.lines) {
      const k = `${l.acc}|${l.co}|${l.meta?.contractId}`;
      m.set(k, (m.get(k) || 0) + l.amt);
    }
    return m;
  };
  const a = net(gen), b = net(gen2);
  const diff = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(k) || 0) !== (b.get(k) || 0)) diff.push({ message: `${k}：${fmt(a.get(k) || 0)} ≠ ${fmt(b.get(k) || 0)}` });
  }
  out.push(item('CHK-05', '仕訳作成方式による結果の一致（開始仕訳＋当期 ＝ 期末残高一括）', diff.length ? NG : OK, diff.length ? `${diff.length}件の差異` : '両方式で科目別の消去額が完全に一致', diff));

  // CHK-06 期間の連続性（開始仕訳＝前期末の個別残高の消去）
  const cont = [];
  for (const r of gen.results) {
    const { ps, sched, contract: c } = r;
    if (sched.meta.model === 'offbalance') continue;
    const op = aggregate(r.cumBefore.filter((l) => ACCOUNTS[l.acc]?.type === 'BS'));
    const g = (acc) => op.filter((l) => l.acc === acc && l.co === c.lesseeCo).reduce((s, l) => s + l.amt, 0);
    const exp = { LL_NC: ps.open.L, ROU_COST: -ps.open.cost + (pol['POL-07'] === 'capitalize' ? 0 : 0), ROU_ACC: ps.open.acc };
    if (g('LL_NC') !== exp.LL_NC) cont.push({ contract: c.id, message: `開始仕訳のリース負債 ${fmt(g('LL_NC'))} ≠ 前期末の借手残高 ${fmt(exp.LL_NC)}` });
    if (g('ROU_ACC') !== exp.ROU_ACC) cont.push({ contract: c.id, message: `開始仕訳の減価償却累計額 ${fmt(g('ROU_ACC'))} ≠ 前期末の借手残高 ${fmt(exp.ROU_ACC)}` });
  }
  out.push(item('CHK-06', '期間の連続性（開始仕訳＝前期末の個別残高の消去）', cont.length ? NG : OK, cont.length ? `${cont.length}件の不一致` : '開始仕訳は前期末の借手残高と一致', cont));

  // CHK-07 スケジュールの完結性（最終回で残高0、満了時に償却完了）・独立再計算
  const sc = [];
  for (const r of gen.results) {
    const { sched, contract: c } = r;
    const m = sched.meta;
    if (m.model === 'offbalance') continue;
    if (Math.abs(m.finalResidual || 0) > m.K) sc.push({ contract: c.id, message: `最終回の端数調整額 ${fmt(m.finalResidual)} が大きすぎます（支払回数 ${m.K}）` });
    // 独立再計算：現在価値をホーナー法（逆順）で計算し、L0と比較
    const rem = m.payments.filter((p) => p.month >= m.measStart);
    const rmon = Math.pow(1 + m.rp, 1 / m.f) - 1;
    let pv = 0;
    for (let i = rem.length - 1; i >= 0; i--) {
      const p = rem[i];
      const nextT = i + 1 < rem.length ? rem[i + 1].t : p.t;
      pv = (pv / Math.pow(1 + rmon, nextT - p.t)) + p.amount;
    }
    if (rem.length) pv = pv / Math.pow(1 + rmon, rem[0].t - m.measStart);
    const L0calc = round(pv, pol['POL-11'] || 'half_up');
    const override = c.lessee.liabilityOverride !== null && c.lessee.liabilityOverride !== undefined && !(c.lessee.transition?.method === 'cumulative');
    if (!override && Math.abs(L0calc - m.L0) > 1) sc.push({ contract: c.id, message: `リース負債の当初測定額：再計算 ${fmt(L0calc)} ≠ スケジュール ${fmt(m.L0)}` });
    if (override && L0calc !== m.L0) sc.push({ contract: c.id, message: `取込値（借手の帳簿）${fmt(m.L0)} と再計算値 ${fmt(L0calc)} に差異 ${fmt(m.L0 - L0calc)}。割引率・支払条件を確認してください`, warn: true });
    const totInt = m.segments.reduce((s2, x) => s2 + x.interest, 0);
    const remTotal = rem.reduce((s2, p) => s2 + p.amount, 0);
    if (!c.terminationYm && totInt !== remTotal - m.L0) sc.push({ contract: c.id, message: `利息総額 ${fmt(totInt)} ≠ 支払総額 ${fmt(remTotal)} − 当初負債 ${fmt(m.L0)}` });
    if (m.transferLike) sc.push({ contract: c.id, message: '償却期間がリース期間を超えています（所有権移転等）。満了時の自動取崩は行いません。購入オプション行使等の処理を確認してください', warn: true });
  }
  const scNg = sc.filter((x) => !x.warn);
  out.push(item('CHK-07', 'スケジュールの完結性と独立再計算（現在価値・利息総額）', scNg.length ? NG : sc.length ? WARN : OK, scNg.length ? `${scNg.length}件の不一致` : sc.length ? `${sc.length}件の確認事項` : '現在価値の再計算値・利息総額・最終残高が一致', sc));

  // CHK-08 貸手資産の按分比率
  const ratio = new Map();
  for (const c of data.contracts) {
    const r = c.lessor || {};
    if (!(r.assetCost > 0) || !r.assetId) continue;
    ratio.set(r.assetId, (ratio.get(r.assetId) || 0) + (r.ratio ?? 1));
  }
  const over = [...ratio.entries()].filter(([, v]) => v > 1 + 1e-9).map(([k, v]) => ({ message: `貸手資産 ${k}：按分比率合計 ${(v * 100).toFixed(1)}%（100%超）` }));
  out.push(item('CHK-08', '貸手資産の按分比率（二重計上の防止）', over.length ? NG : OK, over.length ? '按分比率の合計が100%を超える資産があります' : 'すべての貸手資産で按分比率合計が100%以下', over));

  // CHK-09 決算日の差異（POL-08）
  const co = Object.fromEntries(data.companies.map((x) => [x.code, x]));
  const fy = [];
  if (pol['POL-08'] === 'adjust_material') {
    for (const r of gen.results) {
      const c = r.contract;
      const a = co[c.lesseeCo]?.fyeMonth, b = co[c.lessorCo]?.fyeMonth;
      const parent = data.companies.find((x) => x.isParent)?.fyeMonth || 3;
      for (const [who, fe] of [['借手', a], ['貸手', b]]) {
        if (!fe || fe === parent) continue;
        // 子会社決算日〜連結決算日の間に発生したイベント
        const gapStart = period.end - ((parent - fe + 12) % 12) + 1;
        const ev = r.sched.months.filter((x) => x.m >= gapStart && x.m <= period.end && (x.lessee.commence || x.lessee.term));
        fy.push({ contract: c.id, message: `${who}（${co[who === '借手' ? c.lesseeCo : c.lessorCo]?.name}）は${fe}月決算。差異期間（${indexToJp(gapStart)}〜${indexToJp(period.end)}）${ev.length ? `に${ev.map((x) => (x.lessee.commence ? '開始' : '終了')).join('・')}があり重要な不一致の調整を検討してください` : 'の新規・解約はありません'}`, warn: ev.length > 0 });
      }
    }
  }
  const fyWarn = fy.filter((x) => x.warn);
  out.push(item('CHK-09', '決算日の差異による不一致（POL-08）', fyWarn.length ? WARN : OK, pol['POL-08'] !== 'adjust_material' ? `方針「${pol['POL-08'] === 'provisional' ? '仮決算' : '調整しない'}」のため検査対象外` : fyWarn.length ? `${fyWarn.length}件の調整候補` : fy.length ? '決算日の異なる会社はありますが、差異期間に新規・解約はありません' : '決算日の異なる会社はありません', fy));

  // CHK-10 個別の帳簿残高（実績）との突合
  const act = [];
  for (const r of gen.results) {
    const c = r.contract;
    const key = `${String(Math.floor(period.end / 12))}-${String((period.end % 12) + 1).padStart(2, '0')}`;
    const a2 = (c.actuals || {})[key];
    if (!a2) continue;
    const cl = r.ps.close;
    const fullYear = period.end - period.start === 11;
    const cmp = [['リース負債', a2.L, cl.L], ['使用権資産簿価', a2.rouNet, cl.cost - cl.acc]];
    if (fullYear) cmp.push(['受取リース料（当期）', a2.inc, r.ps.inc]);
    for (const [nm, book, app] of cmp) {
      if (book === undefined || book === null || book === '') continue;
      if (Number(book) !== app) act.push({ contract: c.id, message: `${nm}：個別帳簿 ${fmt(Number(book))} ／ アプリ計算 ${fmt(app)} ／ 差異 ${fmt(Number(book) - app)}` });
      else act.push({ contract: c.id, message: `${nm}：一致（${fmt(app)}）`, ok: true });
    }
  }
  const actNg = act.filter((x) => !x.ok);
  out.push(item('CHK-10', '個別の帳簿残高（実績）との突合', actNg.length ? NG : act.length ? OK : WARN, actNg.length ? `${actNg.length}件の差異。原因を調査し個社修正を検討してください` : act.length ? '入力された実績とすべて一致' : '実績が未入力のため突合していません（契約画面で入力できます）', act));

  // CHK-11 CF消去の整合
  const cf = cashFlowEliminations(gen, pol, period);
  out.push(item('CHK-11', '連結CF消去額の整合（借手の支払＝貸手の受取）', cf.check === 0 ? OK : NG, cf.check === 0 ? '借手の支払合計と貸手の受取合計が一致' : `差額 ${fmt(cf.check)}`, []));

  // CHK-12 棚卸資産等への原価算入（POL-12）
  const mfg = data.contracts.filter((c) => c.lessee?.dept === 'mfg').map((c) => ({ contract: c.id, message: `${c.name}：借手は製造部門で使用。期末在庫に含まれる償却費の重要性を確認し、判断を記録してください`, warn: true }));
  out.push(item('CHK-12', '棚卸資産に含まれる償却費（POL-12）', mfg.length ? WARN : OK, mfg.length ? `${mfg.length}契約が製造部門で使用（方針：${pol['POL-12'] === 'manual' ? '手入力で調整' : '調整しない'}）` : '製造部門で使用する契約はありません', mfg));

  return out;
}

export function overallStatus(checks) {
  if (checks.some((c) => c.status === NG)) return NG;
  if (checks.some((c) => c.status === WARN)) return WARN;
  return OK;
}
