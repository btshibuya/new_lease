// 注記（新リース会計基準）：注記項目の定義、グループ内リース分の計算、各社からの収集表（CSV）と連結の注記額。
// 画面に依存しない純粋な関数。会計方針に関する情報（適用指針第97項）は文章の注記のため対象外。
//
// 連結の注記額 ＝ 各社の個別の注記額の合計 − うちグループ内リース分
// グループ内リース分は、アプリで計算できる項目（calc）は契約から計算し、計算できない項目（input）は各社が収集表に記入する。
import { round, ymToIndex } from './util.js';
import { toCsv, validCode } from './data.js';
import { parseCsv } from './contractCsv.js';
import { maturity } from './reports.js';
import { lessorDepBetween } from './schedule.js';
import { writeXlsx, readXlsx, STYLE, colName } from './xlsx.js';

export const ASSET_CLASS_LABELS = { building: '建物', machine: '機械装置', vehicle: '車両運搬具', tool: '工具器具備品', land: '土地', other: 'その他' };
export const BUCKETS = [
  { key: 'y1', label: '1年以内', from: 1, to: 12 }, { key: 'y2', label: '1年超2年以内', from: 13, to: 24 }, { key: 'y3', label: '2年超3年以内', from: 25, to: 36 },
  { key: 'y4', label: '3年超4年以内', from: 37, to: 48 }, { key: 'y5', label: '4年超5年以内', from: 49, to: 60 }, { key: 'over', label: '5年超', from: 61, to: 1e9 },
];

/** 情報の区分（見出し）。ref は企業会計基準適用指針第33号の項 */
export const NOTE_SECTIONS = [
  { id: 'L-P', side: '借手', title: '表示に関する注記（使用権資産・リース負債を区分表示しない場合）', ref: '会計基準第49項〜第51項' },
  { id: 'L-A', side: '借手', title: 'リース特有の取引に関する情報', ref: '適用指針第99項〜第101項' },
  { id: 'L-B', side: '借手', title: '当期及び翌期以降のリースの金額を理解するための情報', ref: '適用指針第102項' },
  { id: 'R-A', side: '貸手', title: 'リース特有の取引に関する情報', ref: '適用指針第103項〜第105項' },
  { id: 'R-B', side: '貸手', title: '当期及び翌期以降のリースの金額を理解するための情報', ref: '適用指針第106項〜第109項' },
  { id: 'O', side: '借手・貸手', title: '該当する取引がある場合の注記（セール・アンド・リースバック、サブリース）', ref: '適用指針（項番号は原文で確認）' },
  { id: 'X', side: '関連', title: '関連する他の注記・附属明細表（参考）', ref: 'リースの注記以外' },
];

/**
 * 注記項目。kind：calc＝グループ内分をアプリで計算、input＝グループ内分を各社が記入、na＝グループ内分はない、text＝文章で記載
 * byClass：原資産の表示科目ごと、byBucket：決算日後の期間ごと
 */
export const NOTE_ITEMS = [
  { id: 'L-LIAB', sec: 'L-P', title: 'リース負債が含まれる科目と金額', when: '期末', kind: 'calc', byList: [['cur', '流動（1年以内）'], ['nc', '固定（1年超）']],
    desc: '貸借対照表でリース負債を区分して表示しない場合に、リース負債が含まれる科目（流動負債の「その他」、固定負債の「その他」など）と金額を注記します。使用権資産を区分して表示しない場合は、上の「科目ごとの使用権資産の帳簿価額」で含まれる科目と金額を示します。グループ内の分は、借手の個別の期末のリース負債（流動・固定。会社マスタで「流動区分なし」の会社は全額を固定）です。' },
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
  { id: 'R-INV', sec: 'R-A', title: 'リース債権及びリース投資資産の内訳', when: '期末', kind: 'calc', byList: [['pay', 'リース料債権部分（将来のリース料）'], ['res', '見積残存価額部分'], ['unearned', '受取利息相当額（控除）']],
    desc: 'ファイナンス・リースの貸手が計上するリース投資資産（所有権移転外）・リース債権（所有権移転）について、将来のリース料を収受する権利に係る部分、見積残存価額部分、受取利息相当額を記載します（3つの合計＝期末のリース投資資産）。グループ内の分は、貸手が「所有権移転外ファイナンス・リース」とした契約の期末のリース投資資産の内訳です（オペレーティング・リースの契約は対象外）。' },
  { id: 'R-INT', sec: 'R-A', title: '受取利息相当額', when: '当期', kind: 'calc',
    desc: 'ファイナンス・リースの貸手が当期に計上した受取利息相当額（リース投資資産に係る受取利息）です。グループ内の分は、貸手が「所有権移転外ファイナンス・リース」とした契約の当期の利息相当額です。' },
  { id: 'R-VAR', sec: 'R-A', title: '変動する使用料に係る収益', when: '当期', kind: 'input',
    desc: '貸手のリース料に含めていない、将来の業績・使用量等により変動する使用料の当期の収益です。アプリは計算しないため、グループ会社とのリースに係る分を収集表の「うちグループ会社とのリース分」に記入します。' },
  { id: 'R-CHG', sec: 'R-B', title: 'リース債権及びリース投資資産の残高の重要な変動', when: '当期', kind: 'text',
    desc: 'リース債権・リース投資資産の残高に重要な変動があった場合に、その内容を文章で記載します。グループ内の分はありません。収集表では「備考」に記入します。' },
  { id: 'R-FMAT', sec: 'R-B', title: 'リース投資資産に係るリース料債権部分の回収予定額（決算日後5年以内は1年ごと、5年超）', when: '期末', kind: 'calc', byBucket: true,
    desc: 'ファイナンス・リースの貸手について、リース債権・リース投資資産に係るリース料債権部分（割引前の将来のリース料）を、決算日後5年以内は1年ごと、5年超はまとめて記載します。グループ内の分は、貸手が「所有権移転外ファイナンス・リース」とした契約の将来のリース料です。' },
  { id: 'R-MAT', sec: 'R-B', title: 'リース料の回収予定額（決算日後5年以内は1年ごと、5年超）', when: '期末', kind: 'calc', byBucket: true,
    desc: '決算日後に回収（受取）する予定のリース料（割引前）を、5年以内は1年ごと、5年超はまとめて記載します（オペレーティング・リースの将来の受取リース料）。グループ内の分は、貸手がオペレーティング・リースとした契約の将来の受取リース料です。ファイナンス・リースは上の「リース投資資産に係るリース料債権部分の回収予定額」に記載します。' },
  { id: 'O-SLB', sec: 'O', title: 'セール・アンド・リースバック取引', when: '当期', kind: 'input',
    desc: '資産を売却し、同じ資産をリースバックする取引について、取引の内容や売却損益などを注記します（該当する場合）。グループ会社との間で行った取引は連結上消去するため、各社の注記額のうちグループ会社との取引の分を「うちグループ会社とのリース分」に記入します。注記の要否・項番号は基準の原文で確認してください。' },
  { id: 'O-SUB', sec: 'O', title: 'サブリース取引（転リース）', when: '当期', kind: 'input',
    desc: '借手が原資産をさらに第三者にリースするサブリース取引について、その内容や収益などを注記します（該当する場合）。グループ外から借りた資産をグループ会社に転貸している場合など、グループ会社とのサブリースの分を「うちグループ会社とのリース分」に記入します。注記の要否・項番号は基準の原文で確認してください。' },
  { id: 'X-INT', sec: 'X', title: 'リース負債に係る利息費用', when: '当期', kind: 'calc',
    desc: '借手がリース負債について計上した利息費用（損益計算書の支払利息等に含まれる額）です。リースが経営成績に与える影響を説明する資料に使います。グループ内の分は、借手が計上したリース負債に係る利息費用（日本基準・IFRS第16号の契約）です。' },
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
    else if (it.byList) for (const [k, l] of it.byList) rows.push({ key: `${it.id}.${k}`, item: it, sub: l });
    else rows.push({ key: it.id, item: it, sub: '' });
  }
  return rows;
}

/**
 * グループ内リース分（アプリで計算する項目）を契約別に求める。
 * @returns {Map<string, {amount:number, rows:{contract,name,co,amt,note}[]}>} key＝行のキー
 */
export function groupNoteAmounts(gen, period, pol, companies = []) {
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
      if (alive) {
        // 個別の注記額と同じ基準：流動区分をしない会社（会社マスタの「流動区分なし」）は全額を固定に含める
        const split = companies.find((x) => x.code === c.lesseeCo)?.splitsCurrent !== false;
        const cur = split ? r.cur || 0 : 0;
        push('L-LIAB.cur', c, c.lesseeCo, cur);
        push('L-LIAB.nc', c, c.lesseeCo, ps.close.L - cur, split ? '' : '流動区分なしの会社のため全額を固定に含める');
      }
      if (model === 'jgaap') push('X-INT', c, c.lesseeCo, (ps.int || 0) + (ps.accr || 0));
    } else if ((c.lessee.offKind || 'short') === 'short') push('L-SHORT', c, c.lesseeCo, ps.cost);
    const pen = inP.reduce((a, x) => a + (x.lessee.penalty || 0), 0);
    push('L-CASH', c, c.lesseeCo, inP.reduce((a, x) => a + (x.lessor.cash || 0), 0) + pen, pen ? `解約違約金 ${pen} を含む` : '');
    const isFL = sched.meta.lessorModel === 'finance';
    // 貸手：将来の受取リース料（決算日後）。ファイナンス・リースはリース投資資産のリース料債権部分の回収予定額
    if (alive) {
      for (const x of sched.months) {
        if (x.m <= period.end || !x.lessor.cash) continue;
        const b = BUCKETS.find((y) => x.m - period.end >= y.from && x.m - period.end <= y.to);
        if (b) push(`${isFL ? 'R-FMAT' : 'R-MAT'}.${b.key}`, c, c.lessorCo, x.lessor.cash);
      }
    }
    if (isFL) {
      // リース投資資産の内訳（期末）と受取利息相当額（当期）
      push('R-INT', c, c.lessorCo, ps.inc);
      const started = period.end >= ymToIndex(c.commencement);
      if (alive && started && period.end < sched.meta.lastIdx) {
        const fut = sched.months.filter((x) => x.m > period.end).reduce((a, x) => a + (x.lessor.cash || 0), 0);
        const NI = endRec.lessor.NI_end || 0, res = sched.meta.flResidual;
        push('R-INV.pay', c, c.lessorCo, fut);
        push('R-INV.res', c, c.lessorCo, res);
        push('R-INV.unearned', c, c.lessorCo, NI - fut - res, '将来のリース料＋見積残存価額−リース投資資産');
      }
    }
    const lr = c.lessor || {};
    if (!isFL && lr.assetCost > 0 && ['building', 'land'].includes(c.assetClass)) {
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
/** 収集表の行（会社×注記項目）。CSV・Excel で共通 */
function collectionRows(companies, period, group, inputs) {
  const out = [];
  for (const co of companies) {
    for (const r of noteRows()) {
      const it = r.item, sec = NOTE_SECTIONS.find((s) => s.id === it.sec);
      const g = group.get(r.key);
      const own = g ? g.rows.filter((x) => x.co === co.code).reduce((a, x) => a + x.amt, 0) : 0;
      out.push({ co, r, it, sec, own, prev: inputs[co.code]?.[r.key] || {} });
    }
  }
  return out;
}

export function noteCollectionCsv(companies, period, group, inputs = {}) {
  const pk = periodKey(period);
  const rows = [HEAD];
  for (const { co, r, it, sec, own, prev } of collectionRows(companies, period, group, inputs)) {
    rows.push([pk, period.label, co.code, co.name, r.key, sec.side, `${sec.title}（${sec.ref}）`, it.title, r.sub, it.when, it.desc,
      prev.total ?? '', it.kind === 'input' ? prev.group ?? '' : it.kind === 'calc' ? '（アプリで計算）' : '（該当なし）',
      it.kind === 'calc' ? own : '', prev.memo ?? '']);
  }
  return toCsv(rows);
}

// 収集用 Excel の列（読込は見出しの名前で照合するため、並べ替えても読み込める）
const XL_COLS = [
  ['会社コード', 9], ['会社名', 18], ['区分', 6], ['注記項目', 30], ['内訳', 16], ['時点', 6],
  ['各社の注記額（記入）', 15], ['うちグループ会社とのリース分（記入）', 15], ['グループ内リース分（アプリ計算値・参考）', 15], ['連結の注記額（参考・自動計算）', 15],
  ['備考（文章の注記など）', 30], ['どのような情報か', 60], ['情報の種類（根拠）', 34], ['項目キー', 12], ['決算期末', 9], ['期間', 14],
];
const XL_SHEET1 = '注記の収集表';
const XL_SHEET2 = '記入方法・チェック';
const XL_HEAD_ROW = 5; // 見出しの行（1始まり）

/**
 * 各社に配る注記の収集用 Excel（シート2枚）。
 * 1枚目「注記の収集表」：黄色のセルだけ入力できる（シート保護・パスワードなし）。数値の入力規則、見出しの固定、フィルター、
 *   連結の注記額（参考）の自動計算つき。2枚目「記入方法・チェック」：記入の手順・色の凡例・会社別の記入状況（数式で自動集計）。
 * @returns {Uint8Array} .xlsx のバイト列
 */
export function noteCollectionXlsx(companies, period, group, inputs = {}) {
  const pk = periodKey(period);
  const C = Object.fromEntries(XL_COLS.map(([n], i) => [n, i]));
  const L = (name) => colName(C[name]);
  const rows = [];
  const cell = (v, s) => ({ v, s });
  const blank = () => Array(XL_COLS.length).fill(null);
  const t1 = blank(); t1[0] = cell(`新リース会計基準 注記の収集表（${period.label}・決算期末 ${pk}）`, STYLE.title); rows.push(t1);
  const t2 = blank(); t2[0] = cell(`対象：${companies.map((c) => `${c.code} ${c.name}`).join('、')}`, STYLE.bold); rows.push(t2);
  const t3 = blank(); t3[0] = cell('黄色のセルに記入してください（灰色・緑色のセルは変更できません。シートは保護されていますがパスワードはありません）。金額の単位はアプリと同じです。負の値は「-」または「△」で入力できます。記入方法と記入状況は「記入方法・チェック」シートを見てください。', STYLE.note); rows.push(t3);
  rows.push(blank());
  rows.push(XL_COLS.map(([n]) => cell(n, STYLE.header)));
  const totalRefs = [], groupRefs = [];
  let lastCo = null, lastSec = null;
  for (const { co, r, it, sec, own, prev } of collectionRows(companies, period, group, inputs)) {
    // 会社・区分が変わる行に見出しを入れる（項目キーが空の行は読込で読み飛ばす）
    if (co.code !== lastCo || sec.id !== lastSec) {
      const h = blank();
      h[0] = cell(co.code, STYLE.section); h[1] = cell(co.name, STYLE.section);
      h[2] = cell(sec.side, STYLE.section); h[3] = cell(`${sec.title}（${sec.ref}）`, STYLE.section);
      for (let i = 4; i < XL_COLS.length; i++) h[i] = cell('', STYLE.section);
      rows.push(h);
      lastCo = co.code; lastSec = sec.id;
    }
    const rn = rows.length + 1;
    const row = blank();
    const isText = it.kind === 'text';
    row[C['会社コード']] = cell(co.code, STYLE.text);
    row[C['会社名']] = cell(co.name, STYLE.text);
    row[C['区分']] = cell(sec.side, STYLE.text);
    row[C['注記項目']] = cell(it.title, STYLE.text);
    row[C['内訳']] = cell(r.sub, STYLE.text);
    row[C['時点']] = cell(it.when, STYLE.text);
    if (isText) row[C['各社の注記額（記入）']] = cell('（文章：備考に記入）', STYLE.lockedNote);
    else { row[C['各社の注記額（記入）']] = cell(prev.total ?? null, STYLE.inNum); totalRefs.push(`${L('各社の注記額（記入）')}${rn}`); }
    if (it.kind === 'input') { row[C['うちグループ会社とのリース分（記入）']] = cell(prev.group ?? null, STYLE.inNum); groupRefs.push(`${L('うちグループ会社とのリース分（記入）')}${rn}`); }
    else row[C['うちグループ会社とのリース分（記入）']] = cell(it.kind === 'calc' ? '（アプリで計算）' : '（該当なし）', STYLE.lockedNote);
    row[C['グループ内リース分（アプリ計算値・参考）']] = it.kind === 'calc' ? cell(own, STYLE.num) : cell('', STYLE.num);
    const G = `${L('各社の注記額（記入）')}${rn}`, H = `${L('うちグループ会社とのリース分（記入）')}${rn}`, I = `${L('グループ内リース分（アプリ計算値・参考）')}${rn}`;
    row[C['連結の注記額（参考・自動計算）']] = isText ? cell('', STYLE.calc) : { f: `IF(${G}="","",${G}-IF(ISNUMBER(${H}),${H},IF(ISNUMBER(${I}),${I},0)))`, s: STYLE.calc };
    row[C['備考（文章の注記など）']] = cell(prev.memo ?? '', STYLE.inText);
    row[C['どのような情報か']] = cell(it.desc, STYLE.lockedNote);
    row[C['情報の種類（根拠）']] = cell(`${sec.title}（${sec.ref}）`, STYLE.lockedNote);
    row[C['項目キー']] = cell(r.key, STYLE.lockedNote);
    row[C['決算期末']] = cell(pk, STYLE.lockedNote);
    row[C['期間']] = cell(period.label, STYLE.lockedNote);
    rows.push(row);
  }
  const last = rows.length;
  const sheet1 = {
    name: XL_SHEET1, rows, cols: XL_COLS.map(([, w]) => w), freeze: { row: XL_HEAD_ROW, col: 4 }, protect: true, tabSelected: true,
    autoFilter: `A${XL_HEAD_ROW}:${colName(XL_COLS.length - 1)}${last}`, merges: [`A1:${colName(10)}1`, `A3:${colName(10)}3`], heights: { 3: 42, [XL_HEAD_ROW]: 48 },
    validations: [
      ...(totalRefs.length ? [{ sqref: totalRefs.join(' '), title: '各社の注記額', prompt: 'グループ会社とのリースも含めた、この会社の個別の注記額を数値で入力します。', error: '数値を入力してください（文章は備考に）' }] : []),
      ...(groupRefs.length ? [{ sqref: groupRefs.join(' '), title: 'うちグループ会社とのリース分', prompt: '上の注記額のうち、グループ会社とのリースに係る分を数値で入力します。', error: '数値を入力してください' }] : []),
    ],
  };
  // 2枚目：記入方法と記入状況のチェック
  const r2 = [];
  const b2 = () => Array(7).fill(null);
  const line = (text, s = STYLE.plain) => { const x = b2(); x[0] = cell(text, s); r2.push(x); };
  line(`記入方法・チェック（${period.label}）`, STYLE.title);
  r2.push(b2());
  line('記入の手順', STYLE.bold);
  for (const t of [
    '1. 「注記の収集表」シートの黄色のセルに記入します。会社ごと・注記項目ごとに1行です。',
    '2. 「各社の注記額（記入）」には、グループ会社とのリースも含めた、この会社の個別財務諸表上の注記額を入力します。',
    '3. 「うちグループ会社とのリース分（記入）」は、アプリで計算できない項目（変動リース料など）だけ黄色になっています。グループ会社とのリースに係る分を入力します。',
    '4. 「グループ内リース分（アプリ計算値・参考）」は、契約からアプリが計算した額です。「連結の注記額（参考・自動計算）」は、各社の注記額−グループ内リース分の参考値です。',
    '5. 文章で記載する注記（重要な変動など）は「備考（文章の注記など）」に記入します。',
    '6. 記入後、下の「記入状況」で未記入の行がないか確かめ、ファイルを保存して提出します（アプリの「記入済みの収集表を読み込む」で取り込みます）。',
    '※ 「項目キー」「決算期末」の列は読込に使います。変更しないでください（シートは保護しています。パスワードはありません）。',
  ]) line(t, STYLE.note);
  r2.push(b2());
  line('色の意味', STYLE.bold);
  for (const [text, s] of [['記入するセル', STYLE.inText], ['アプリが計算・設定した値（変更不可）', STYLE.text], ['自動計算（数式）', STYLE.calc], ['区分の見出し', STYLE.section]]) { const x = b2(); x[0] = cell('', s); x[1] = cell(text, STYLE.plain); r2.push(x); }
  r2.push(b2());
  line('記入状況（会社別・自動集計）：記入が必要な行＝グループ内リース分のある行（個別の注記額にグループ内の分が含まれるため、各社の注記額の記入が必要）', STYLE.bold);
  r2.push(['会社コード', '会社名', '記入が必要な行', '記入済み', '未記入', '記入した行（全体）', '状態'].map((n) => cell(n, STYLE.header)));
  const S1 = `'${XL_SHEET1}'`;
  const rng = (name) => `${S1}!$${L(name)}$${XL_HEAD_ROW + 1}:$${L(name)}$${last}`;
  for (const co of companies) {
    const rn = r2.length + 1;
    const A = `$A${rn}`;
    const need = `COUNTIFS(${rng('会社コード')},${A},${rng('グループ内リース分（アプリ計算値・参考）')},"<>0",${rng('グループ内リース分（アプリ計算値・参考）')},"<>")`;
    const done = `COUNTIFS(${rng('会社コード')},${A},${rng('グループ内リース分（アプリ計算値・参考）')},"<>0",${rng('グループ内リース分（アプリ計算値・参考）')},"<>",${rng('各社の注記額（記入）')},">-9.9E+307")`; // 数値だけを数える（「（文章：備考に記入）」の文字は数えない）
    r2.push([cell(co.code, STYLE.text), cell(co.name, STYLE.text), { f: need, s: STYLE.num }, { f: done, s: STYLE.num }, { f: `C${rn}-D${rn}`, s: STYLE.calc },
      { f: `COUNTIFS(${rng('会社コード')},${A},${rng('各社の注記額（記入）')},">-9.9E+307")+COUNTIFS(${rng('会社コード')},${A},${rng('備考（文章の注記など）')},"<>")`, s: STYLE.num },
      { f: `IF(F${rn}=0,"未記入",IF(E${rn}>0,"一部記入（未記入 "&E${rn}&" 行）","記入済み"))`, s: STYLE.calc }]);
  }
  const sheet2 = { name: XL_SHEET2, rows: r2, cols: [12, 26, 16, 12, 12, 18, 24], protect: true, merges: r2.map((x, i) => (x[0] && !x[1] && i < r2.length - companies.length - 1 ? `A${i + 1}:G${i + 1}` : null)).filter(Boolean), heights: Object.fromEntries(r2.map((x, i) => [i + 1, x[0]?.s === STYLE.note ? 30 : 0]).filter(([, v]) => v)) };
  return writeXlsx([sheet1, sheet2]);
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
  const all = parseCsv(text);
  return importNoteRows(all.map((r, i) => ({ r, line: i + 1 })).filter((x) => x.r.some((v) => String(v).trim() !== '')), companies, period);
}

/** 記入済みの収集用 Excel（.xlsx）を読み込む。1枚目（または見出しのあるシート）の見出し行から下を読む */
export async function importNoteCollectionXlsx(bytes, companies, period) {
  let sheets;
  try { sheets = await readXlsx(bytes); } catch (e) { return { inputs: {}, errors: [e.message], count: 0 }; }
  const isHead = (r) => r.includes('項目キー') && r.includes('会社コード');
  const sh = sheets.find((x) => x.name === XL_SHEET1 && x.rows.some(isHead)) || sheets.find((x) => x.rows.some(isHead));
  if (!sh) return { inputs: {}, errors: ['「注記の収集表」シートに見出し行（会社コード・項目キーなど）がありません。アプリで書き出した Excel を使ってください'], count: 0 };
  const h = sh.rows.findIndex(isHead);
  const rows = sh.rows.slice(h).map((r, i) => ({ r: r.map((v) => String(v ?? '')), line: h + i + 1 })).filter((x) => x.r.some((v) => v.trim() !== ''));
  const res = importNoteRows(rows, companies, period, `「${sh.name}」シートの`);
  return res;
}

/** 行（見出し行が先頭）から収集値を読む。rows：[{ r: セルの配列, line: 元の行番号 }] */
function importNoteRows(lines, companies, period, where0 = '') {
  const rows = lines.map((x) => x.r);
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
    const line = lines[i + 1].line;
    const where = `${where0}${line}行目`;
    const p = String(r[idx('決算期末')] ?? '').trim();
    const co = String(r[idx('会社コード')] ?? '').trim();
    const key = String(r[idx('項目キー')] ?? '').trim();
    if (!key && !p) return; // 区分の見出し行・空行
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
      if (!validCode(co) || !byKey || typeof byKey !== 'object') continue;
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
