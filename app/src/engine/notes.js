// 注記（新リース会計基準）：注記項目の定義、グループ内リース分の計算、各社からの収集表（CSV）と連結の注記額。
// 画面に依存しない純粋な関数。会計方針に関する情報（適用指針第97項）は文章の注記のため対象外。
//
// 連結の注記額 ＝ 各社の個別の注記額の合計 − うちグループ内リース分
// グループ内リース分は、アプリで計算できる項目（calc）は契約から計算し、計算できない項目（input）は各社が収集表に記入する。
import { round } from './util.js';
import { toCsv, validCode } from './data.js';
import { parseCsv } from './contractCsv.js';
import { maturity } from './reports.js';
import { lessorDepBetween } from './schedule.js';

export const ASSET_CLASS_LABELS = { building: '建物', machine: '機械装置', vehicle: '車両運搬具', tool: '工具器具備品', land: '土地', other: 'その他' };
export const BUCKETS = [
  { key: 'y1', label: '1年以内', from: 1, to: 12 }, { key: 'y2', label: '1年超2年以内', from: 13, to: 24 }, { key: 'y3', label: '2年超3年以内', from: 25, to: 36 },
  { key: 'y4', label: '3年超4年以内', from: 37, to: 48 }, { key: 'y5', label: '4年超5年以内', from: 49, to: 60 }, { key: 'over', label: '5年超', from: 61, to: 1e9 },
];

/** 情報の区分（見出し）。ref は企業会計基準適用指針第33号の項 */
export const NOTE_SECTIONS = [
  { id: 'L-A', side: '借手', title: 'リース特有の取引に関する情報', ref: '適用指針第99項〜第101項' },
  { id: 'L-B', side: '借手', title: '当期及び翌期以降のリースの金額を理解するための情報', ref: '適用指針第102項' },
  { id: 'R-A', side: '貸手', title: 'リース特有の取引に関する情報', ref: '適用指針第103項〜第105項' },
  { id: 'R-B', side: '貸手', title: '当期及び翌期以降のリースの金額を理解するための情報', ref: '適用指針第106項〜第109項' },
  { id: 'X', side: '関連', title: '関連する他の注記・附属明細表（参考）', ref: 'リースの注記以外' },
];

/**
 * 注記項目。kind：calc＝グループ内分をアプリで計算、input＝グループ内分を各社が記入、na＝グループ内分はない、text＝文章で記載
 * byClass：原資産の表示科目ごと、byBucket：決算日後の期間ごと
 */
export const NOTE_ITEMS = [
  { id: 'L-NBV', sec: 'L-A', title: '科目ごとの使用権資産の帳簿価額', when: '期末', kind: 'calc', byClass: true,
    desc: '期末の使用権資産の帳簿価額（取得原価−減価償却累計額）を、対応する原資産を自ら所有していたと仮定した場合に表示する科目（建物、機械装置など）ごとに記載します。' },
  { id: 'L-SHORT', sec: 'L-A', title: '短期リースに係る費用', when: '当期', kind: 'calc',
    desc: '短期リース（リース開始日において借手のリース期間が12か月以内であり、購入オプションを含まないリース）について、使用権資産・リース負債を計上せず、借手のリース料を費用として処理した額です（簡便的な取扱い：適用指針第20項）。少額リース（適用指針第22項）の費用は含めません。グループ内の分は、契約で「借手の会計モデル：短期・少額リース等」かつ「簡便的な取扱いの種類：短期リース」とした契約の費用です。' },
  { id: 'L-VAR', sec: 'L-A', title: '変動リース料に係る費用', when: '当期', kind: 'input',
    desc: 'リース負債の測定に含めていない借手の変動リース料（売上高や使用量に連動して変わる支払など）の当期の費用です。アプリは変動リース料を計算しないため、グループ会社とのリースに係る分を収集表の「うちグループ会社とのリース分」に記入します。' },
  { id: 'L-CASH', sec: 'L-B', title: 'リースに係るキャッシュ・アウトフローの合計額', when: '当期', kind: 'calc',
    desc: '当期に借手が支払ったリース料の合計額です。リース負債の返済額・利息の支払額のほか、短期リース・少額リース・変動リース料の支払も含めます。グループ内の分は、契約のリース料の支払額（解約違約金を含む）です。' },
  { id: 'L-ADD', sec: 'L-B', title: '使用権資産の増加額', when: '当期', kind: 'calc',
    desc: '当期に新たに計上した使用権資産の額と、条件変更（リース負債の再測定）による増加額です。適用初年度に経過措置で計上した額は含めていません（扱いは会計監査人と確認してください）。' },
  { id: 'L-DEP', sec: 'L-B', title: '科目ごとの使用権資産の減価償却費', when: '当期', kind: 'calc', byClass: true,
    desc: '当期の使用権資産の減価償却費を、対応する原資産を自ら所有していたと仮定した場合に表示する科目ごとに記載します。' },
  { id: 'R-INV', sec: 'R-A', title: 'リース債権及びリース投資資産の内訳', when: '期末', kind: 'na',
    desc: 'ファイナンス・リースの貸手が計上するリース債権・リース投資資産の内訳（将来のリース料、見積残存価額、受取利息相当額など）です。グループ内リースはオペレーティング・リースとして扱うため、グループ内の分はありません。グループ外のファイナンス・リースがある会社だけ記入します。' },
  { id: 'R-INT', sec: 'R-A', title: '受取利息相当額', when: '当期', kind: 'na',
    desc: 'ファイナンス・リースの貸手が当期に計上した受取利息相当額です。グループ内の分はありません（オペレーティング・リースのため）。' },
  { id: 'R-VAR', sec: 'R-A', title: '変動する使用料に係る収益', when: '当期', kind: 'input',
    desc: '貸手のリース料に含めていない、将来の業績・使用量等により変動する使用料の当期の収益です。アプリは計算しないため、グループ会社とのリースに係る分を収集表の「うちグループ会社とのリース分」に記入します。' },
  { id: 'R-CHG', sec: 'R-B', title: 'リース債権及びリース投資資産の残高の重要な変動', when: '当期', kind: 'text',
    desc: 'リース債権・リース投資資産の残高に重要な変動があった場合に、その内容を文章で記載します。グループ内の分はありません。収集表では「備考」に記入します。' },
  { id: 'R-MAT', sec: 'R-B', title: 'リース料の回収予定額（決算日後5年以内は1年ごと、5年超）', when: '期末', kind: 'calc', byBucket: true,
    desc: '決算日後に回収（受取）する予定のリース料（割引前）を、5年以内は1年ごと、5年超はまとめて記載します。オペレーティング・リースは将来の受取リース料、ファイナンス・リースはリース債権・リース投資資産に係るリース料です。グループ内の分は、オペレーティング・リースの将来の受取リース料です。' },
  { id: 'X-LL', sec: 'X', title: 'リース負債の返済予定額（割引前）', when: '期末', kind: 'calc', byBucket: true,
    desc: '借手のリース負債について、決算日後の支払予定額（割引前）です。金融商品の時価等に関する注記の返済予定額に使います。' },
  { id: 'X-LLP', sec: 'X', title: 'リース負債の返済予定額（元本）', when: '期末', kind: 'calc', byBucket: true,
    desc: '借手のリース負債の元本の返済予定額です。連結附属明細表（借入金等明細表）に使います。' },
  { id: 'X-RE', sec: 'X', title: '賃貸等不動産の期末簿価（グループ会社への賃貸分）', when: '期末', kind: 'calc',
    desc: '貸手が個別で賃貸等不動産として注記している建物・土地のうち、グループ会社に賃貸している部分の期末簿価です。連結上は自己使用の資産となるため、連結の賃貸等不動産の注記から除きます。' },
  { id: 'X-REINC', sec: 'X', title: '賃貸等不動産の賃貸損益（グループ会社への賃貸分）', when: '当期', kind: 'calc',
    desc: 'グループ会社への賃貸に係る賃貸収益から減価償却費を差し引いた額です。連結の賃貸等不動産の注記から除きます。' },
];

/** 注記の行（原資産の科目別・期間別に展開）。key は収集表の「項目キー」 */
export function noteRows() {
  const rows = [];
  for (const it of NOTE_ITEMS) {
    if (it.byClass) for (const [k, l] of Object.entries(ASSET_CLASS_LABELS)) rows.push({ key: `${it.id}.${k}`, item: it, sub: l });
    else if (it.byBucket) for (const b of BUCKETS) rows.push({ key: `${it.id}.${b.key}`, item: it, sub: b.label });
    else rows.push({ key: it.id, item: it, sub: '' });
  }
  return rows;
}

/**
 * グループ内リース分（アプリで計算する項目）を契約別に求める。
 * @returns {Map<string, {amount:number, rows:{contract,name,co,amt,note}[]}>} key＝行のキー
 */
export function groupNoteAmounts(gen, period, pol) {
  const R = (v) => round(v, pol['POL-11'] || 'half_up');
  const out = new Map(noteRows().map((r) => [r.key, { amount: 0, rows: [] }]));
  const push = (key, c, co, amt, note = '') => {
    if (!amt) return;
    const o = out.get(key);
    const ex = o.rows.find((x) => x.contract === c.id && x.co === co);
    if (ex) ex.amt += amt; else o.rows.push({ contract: c.id, name: c.name, co, amt, note });
    o.amount += amt;
  };
  for (const r of gen.results) {
    const { contract: c, ps, sched } = r;
    const model = sched.meta.model;
    const cls = ASSET_CLASS_LABELS[c.assetClass] ? c.assetClass : 'other';
    const endRec = sched.byIndex(period.end);
    const alive = endRec && !endRec.lessee.term;
    const inP = sched.months.filter((x) => x.m >= period.start && x.m <= period.end);
    if (model !== 'offbalance') {
      if (alive) push(`L-NBV.${cls}`, c, c.lesseeCo, ps.close.cost - ps.close.acc);
      const cm = ps.commence && sched.meta.measSource === 'none' ? (model === 'asc842ol' ? ps.commence.L0 : ps.commence.C0) : 0;
      const rm = inP.reduce((a, x) => a + (x.lessee.remeasure ? Math.max(0, x.lessee.remeasure.dL) : 0), 0);
      push('L-ADD', c, c.lesseeCo, cm + rm, rm ? `条件変更による増加 ${rm} を含む` : '');
      push(`L-DEP.${cls}`, c, c.lesseeCo, ps.dep);
    } else if ((c.lessee.offKind || 'short') === 'short') push('L-SHORT', c, c.lesseeCo, ps.cost);
    const pen = inP.reduce((a, x) => a + (x.lessee.penalty || 0), 0);
    push('L-CASH', c, c.lesseeCo, inP.reduce((a, x) => a + (x.lessor.cash || 0), 0) + pen, pen ? `解約違約金 ${pen} を含む` : '');
    // 貸手：将来の受取リース料（決算日後）
    if (alive) {
      for (const x of sched.months) {
        if (x.m <= period.end || !x.lessor.cash) continue;
        const b = BUCKETS.find((y) => x.m - period.end >= y.from && x.m - period.end <= y.to);
        if (b) push(`R-MAT.${b.key}`, c, c.lessorCo, x.lessor.cash);
      }
    }
    const lr = c.lessor || {};
    if (lr.assetCost > 0 && ['building', 'land'].includes(c.assetClass)) {
      const ratio = lr.ratio ?? 1;
      if (alive) push('X-RE', c, c.lessorCo, R(lr.assetCost * ratio) - R((endRec.lessor.assetAcc_end || 0) * ratio));
      const dep = lessorDepBetween(sched, period.start, period.end, ratio, R);
      push('X-REINC', c, c.lessorCo, ps.inc - dep, `賃貸収益 ${ps.inc} − 減価償却費 ${dep}`);
    }
  }
  // 借手：リース負債の満期分析（既存の計算と同じ）。契約別の内訳は契約ごとに計算する
  for (const r of gen.results) {
    const m = maturity({ results: [r] }, period);
    BUCKETS.forEach((b, i) => { push(`X-LL.${b.key}`, r.contract, r.contract.lesseeCo, m[i].amount); push(`X-LLP.${b.key}`, r.contract, r.contract.lesseeCo, m[i].principal); });
  }
  return out;
}

const periodKey = (period) => {
  const y = Math.floor(period.end / 12), m = (period.end % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
};
export { periodKey as notePeriodKey };

const HEAD = ['決算期末', '期間', '会社コード', '会社名', '項目キー', '区分', '情報の種類（根拠）', '注記項目', '内訳', '時点', 'どのような情報か', '各社の注記額（記入）', 'うちグループ会社とのリース分（記入）', 'グループ内リース分（アプリ計算値・参考）', '備考（文章の注記など）'];

/**
 * 各社から注記の金額を集める収集表（CSV、表計算ソフトで開ける）。
 * 会社ごと・注記の行ごとに1行。アプリで計算する項目は、グループ内リース分を参考として出力する。
 */
export function noteCollectionCsv(companies, period, group, inputs = {}) {
  const pk = periodKey(period);
  const rows = [HEAD];
  for (const co of companies) {
    for (const r of noteRows()) {
      const it = r.item, sec = NOTE_SECTIONS.find((s) => s.id === it.sec);
      const g = group.get(r.key);
      const own = g ? g.rows.filter((x) => x.co === co.code).reduce((a, x) => a + x.amt, 0) : 0;
      const prev = inputs[co.code]?.[r.key] || {};
      rows.push([pk, period.label, co.code, co.name, r.key, sec.side, `${sec.title}（${sec.ref}）`, it.title, r.sub, it.when, it.desc,
        prev.total ?? '', it.kind === 'input' ? prev.group ?? '' : it.kind === 'calc' ? '（アプリで計算）' : '（該当なし）',
        it.kind === 'calc' ? own : '', prev.memo ?? '']);
    }
  }
  return toCsv(rows);
}

const numOrNull = (v, errs, where) => {
  const t = String(v ?? '').replace(/[０-９．－]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/[,¥￥円\s]/g, '').replace(/^△/, '-').replace(/^▲/, '-');
  if (t === '' || t.startsWith('（')) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) { errs.push(`${where}：「${v}」が数値ではありません`); return null; }
  return Number(t);
};

/**
 * 記入済みの収集表を読み込む。
 * @returns {{ inputs: object, errors: string[], count: number }} inputs＝{ 会社コード: { 行キー: { total, group, memo } } }
 */
export function importNoteCollection(text, companies, period) {
  const rows = parseCsv(text).filter((r) => r.some((x) => String(x).trim() !== ''));
  const errors = [];
  if (!rows.length) return { inputs: {}, errors: ['ファイルが空です'], count: 0 };
  const head = rows[0].map((x) => String(x).trim());
  const idx = (l) => head.indexOf(l);
  const need = ['決算期末', '会社コード', '項目キー', '各社の注記額（記入）'];
  const miss = need.filter((l) => idx(l) < 0);
  if (miss.length) return { inputs: {}, errors: [`見出し行に必須の列がありません：${miss.join('、')}（アプリの収集表を使ってください）`], count: 0 };
  const keys = new Map(noteRows().map((r) => [r.key, r]));
  const codes = new Set(companies.map((c) => c.code));
  const pk = periodKey(period);
  const inputs = {};
  let count = 0;
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const where = `${line}行目`;
    const p = String(r[idx('決算期末')] ?? '').trim();
    const co = String(r[idx('会社コード')] ?? '').trim();
    const key = String(r[idx('項目キー')] ?? '').trim();
    if (p !== pk) { errors.push(`${where}：決算期末「${p}」が表示中の期間（${pk}）と違います`); return; }
    if (!codes.has(co)) { errors.push(`${where}：会社コード「${co}」が会社マスタにありません`); return; }
    const def = keys.get(key);
    if (!def) { errors.push(`${where}：項目キー「${key}」はアプリの注記項目にありません`); return; }
    const total = numOrNull(r[idx('各社の注記額（記入）')], errors, `${where}（各社の注記額）`);
    const group = def.item.kind === 'input' && idx('うちグループ会社とのリース分（記入）') >= 0 ? numOrNull(r[idx('うちグループ会社とのリース分（記入）')], errors, `${where}（うちグループ会社とのリース分）`) : null;
    const memo = idx('備考（文章の注記など）') >= 0 ? String(r[idx('備考（文章の注記など）')] ?? '').slice(0, 1000) : '';
    if (total === null && group === null && !memo) return;
    inputs[co] = inputs[co] || {};
    if (inputs[co][key]) { errors.push(`${where}：会社「${co}」の項目「${key}」が重複しています`); return; }
    inputs[co][key] = { total, group, memo };
    count++;
  });
  return { inputs, errors, count };
}

/** 保存データの無害化（期間→会社→行キー） */
export function sanitizeNoteInputs(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const keys = new Set(noteRows().map((r) => r.key));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  for (const [pk, byCo] of Object.entries(raw).slice(0, 200)) {
    if (!/^\d{4}-\d{2}$/.test(pk) || !byCo || typeof byCo !== 'object') continue;
    for (const [co, byKey] of Object.entries(byCo).slice(0, 500)) {
      // 会社コードは会社マスタと同じ規則（__proto__・constructor 等の予約語は不可：プロトタイプ汚染の防止）
      if (!validCode(co) || !/^[A-Za-z0-9_-]{1,20}$/.test(co) || !byKey || typeof byKey !== 'object') continue;
      for (const [k, v] of Object.entries(byKey)) {
        if (!keys.has(k) || !v || typeof v !== 'object') continue;
        if (!own(out, pk)) out[pk] = {};
        if (!own(out[pk], co)) out[pk][co] = {};
        out[pk][co][k] = { total: num(v.total), group: num(v.group), memo: String(v.memo ?? '').slice(0, 1000) };
      }
    }
  }
  return out;
}

/**
 * 連結の注記額の表。行ごとに、各社の注記額の合計（収集値）、うちグループ内リース分、調整額、連結の注記額。
 * 収集値がない行は total・consolidated を null とする。
 */
export function consolidatedNotes(group, inputs = {}) {
  return noteRows().map((r) => {
    const it = r.item;
    const byCo = Object.entries(inputs).map(([co, m]) => ({ co, ...(m[r.key] || {}) })).filter((x) => x.total !== undefined && (x.total !== null || x.group !== null || x.memo));
    const totals = byCo.filter((x) => x.total !== null && x.total !== undefined);
    const total = totals.length ? totals.reduce((a, x) => a + x.total, 0) : null;
    let groupAmt = 0, groupRows = [];
    if (it.kind === 'calc') { const g = group.get(r.key); groupAmt = g.amount; groupRows = g.rows; }
    else if (it.kind === 'input') { groupRows = byCo.filter((x) => x.group).map((x) => ({ co: x.co, amt: x.group, contract: '（収集値）', name: '' })); groupAmt = groupRows.reduce((a, x) => a + x.amt, 0); }
    return { ...r, total, totalRows: totals.map((x) => ({ co: x.co, amt: x.total })), memos: byCo.filter((x) => x.memo).map((x) => ({ co: x.co, memo: x.memo })), group: groupAmt, groupRows, adj: -groupAmt, consolidated: total === null ? null : total - groupAmt };
  });
}
