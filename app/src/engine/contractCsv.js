// 契約の一括取込（CSV）と取込用テンプレート。
// 画面に依存しない純粋な関数。取込値は sanitizeContract で無害化し、validateContract で検証する。
import { sanitizeContract, toCsv } from './data.js';
import { validateContract } from './schedule.js';
import { ASSET_CLASSES, LESSEE_DEPT } from './accounts.js';

const MAX_ROWS = 2000;

/** 全角の数字・記号を半角に、前後の空白を除く */
function norm(v) {
  return String(v ?? '')
    .replace(/[０-９．－：，％／]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[　]/g, ' ')
    .trim();
}

/** 数値：桁区切り・円記号を除く。空欄は null */
function toNum(v, errs, label) {
  const t = norm(v).replace(/[,¥￥円\s]/g, '');
  if (t === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) { errs.push(`${label}「${v}」が数値ではありません`); return null; }
  return Number(t);
}

/** ％の値（例：2.5 または 2.5%）→ 小数（0.025）。空欄は null */
function toPct(v, errs, label) {
  const t = norm(v).replace(/%$/, '');
  const n = toNum(t, errs, label);
  // 百分率→小数。2.8 / 100 ＝ 0.027999… のような浮動小数点の誤差を残さない（書き出し→取込で値が変わらないように）
  return n === null ? null : Math.round((n / 100) * 1e10) / 1e10;
}

/** 年月：2027-04、2027/4、2027/4/1、2027年4月 などを YYYY-MM に。空欄は null */
function toYm(v, errs, label) {
  const t = norm(v);
  if (t === '') return null;
  const m = t.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2})?\s*日?)?\s*月?$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) { errs.push(`${label}「${v}」は年月として読めません（例：2027-04）`); return null; }
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** 選択肢：表示名・キーのどちらでも受け付ける */
function toChoice(v, map, errs, label) {
  const t = norm(v);
  if (t === '') return null;
  for (const [k, names] of Object.entries(map)) if (k === t || names.includes(t)) return k;
  errs.push(`${label}「${v}」は選択肢にありません（${Object.values(map).map((n) => n[0]).join('／')}）`);
  return null;
}

function toBool(v, errs, label) {
  const t = norm(v);
  if (t === '') return null;
  if (['はい', '該当', '○', '1', 'TRUE', 'true', 'yes', 'Y'].includes(t)) return true;
  if (['いいえ', '非該当', '×', '0', 'FALSE', 'false', 'no', 'N', '-'].includes(t)) return false;
  errs.push(`${label}「${v}」は「はい」または「いいえ」で入力してください`);
  return null;
}

const MODEL = { jgaap: ['日本基準', '日本基準（IFRS第16号も同じ）', 'IFRS'], asc842ol: ['ASC842', 'ASC842オペ', 'ASC第842号'], offbalance: ['短期・少額', '短期少額', 'オフバランス'] };
const OFFK = { short: ['短期リース', '短期'], low: ['少額リース', '少額'] };
const TIMING = { arrears: ['後払'], advance: ['前払'] };
const DEPT = Object.fromEntries(Object.entries(LESSEE_DEPT).map(([k, v]) => [k, [k === 'sga' ? '販管費' : '製造原価', v]]));
const ASSET = Object.fromEntries(Object.entries(ASSET_CLASSES).map(([k, v]) => [k, [v]]));
const ROU_TR = { eq_liability: ['リース負債と同額'], retrospective: ['遡及', 'リース開始時から'] };
const INC = { sales: ['売上高'], nonop: ['営業外収益'] };
const DEPC = { cogs: ['売上原価'], nonop: ['営業外費用'] };
const first = (map, k) => map[k]?.[0] ?? '';

/**
 * 列の定義。貸手と借手は別々の列にする（1つの列に結合しない）。
 * get：契約 → セルの値、set：セルの値 → 契約（取込用の素の値）
 */
export const CONTRACT_COLUMNS = [
  { label: '契約番号', help: '必須。英数字など30文字以内。既存と同じ番号は上書き', get: (c) => c.id, set: (o, v) => { o.id = norm(v); } },
  { label: '契約名', help: '100文字以内', get: (c) => c.name, set: (o, v) => { o.name = String(v ?? '').trim(); } },
  { label: '貸手会社コード', help: '必須。会社マスタの会社コード', get: (c) => c.lessorCo, set: (o, v) => { o.lessorCo = norm(v); } },
  { label: '借手会社コード', help: '必須。会社マスタの会社コード（貸手と別の会社）', get: (c) => c.lesseeCo, set: (o, v) => { o.lesseeCo = norm(v); } },
  { label: '資産区分', help: Object.values(ASSET_CLASSES).join('／'), get: (c) => ASSET_CLASSES[c.assetClass], set: (o, v, e, l) => { o.assetClass = toChoice(v, ASSET, e, l) ?? 'other'; } },
  { label: 'リース開始年月', help: '必須。例：2027-04', get: (c) => c.commencement, set: (o, v, e, l) => { o.commencement = toYm(v, e, l); if (!o.commencement) e.push(`${l}は必須です`); } },
  { label: 'リース期間（月数）', help: '必須。延長・解約オプションを反映した月数', get: (c) => c.termMonths, set: (o, v, e, l) => { o.termMonths = toNum(v, e, l); } },
  { label: '支払間隔（月数）', help: '1／3／6／12', get: (c) => c.frequencyMonths, set: (o, v, e, l) => { o.frequencyMonths = toNum(v, e, l) ?? 1; } },
  { label: '支払時期', help: '後払／前払', get: (c) => first(TIMING, c.timing), set: (o, v, e, l) => { o.timing = toChoice(v, TIMING, e, l) ?? 'arrears'; } },
  { label: '1回あたりリース料', help: '消費税・非リース構成部分を除く', get: (c) => c.payment, set: (o, v, e, l) => { o.payment = toNum(v, e, l) ?? 0; } },
  { label: 'フリーレント（無償の支払回数）', help: '空欄＝0', get: (c) => c.freePayments || '', set: (o, v, e, l) => { o.freePayments = toNum(v, e, l) ?? 0; } },
  { label: '段階賃料（支払回:金額）', help: '例：25:55;37:60（25回目から55、37回目から60）', get: (c) => (c.steps || []).map((s) => `${s.fromPayment}:${s.amount}`).join(';'), set: (o, v, e, l) => {
    const t = norm(v).replace(/[、,]/g, ';');
    o.steps = [];
    for (const part of t.split(';').map((x) => x.trim()).filter(Boolean)) {
      const m = part.match(/^(\d+)\s*:\s*(\d+(\.\d+)?)$/);
      if (!m) { e.push(`${l}「${part}」は「回:金額」の形式で入力してください`); continue; }
      o.steps.push({ fromPayment: Number(m[1]), amount: Number(m[2]) });
    }
  } },
  { label: '中途解約年月', help: '任意。例：2029-03', get: (c) => c.terminationYm || '', set: (o, v, e, l) => { o.terminationYm = toYm(v, e, l); } },
  { label: '解約違約金', help: '任意（借手→貸手）', get: (c) => c.terminationPenalty || '', set: (o, v, e, l) => { o.terminationPenalty = toNum(v, e, l) ?? 0; } },
  { label: '借手：会計モデル', help: '日本基準／ASC842／短期・少額', get: (c) => first(MODEL, c.lessee.model), set: (o, v, e, l) => { o.lessee.model = toChoice(v, MODEL, e, l) ?? 'jgaap'; } },
  { label: '借手：簡便的な取扱いの種類', help: '短期リース／少額リース（会計モデルが短期・少額の場合）', get: (c) => first(OFFK, c.lessee.offKind || 'short'), set: (o, v, e, l) => { o.lessee.offKind = toChoice(v, OFFK, e, l) ?? 'short'; } },
  { label: '借手：割引率（年％）', help: '例：2.5（＝2.5％）', get: (c) => +(c.lessee.rate * 100).toFixed(6), set: (o, v, e, l) => { o.lessee.rate = toPct(v, e, l) ?? 0; } },
  { label: '借手：初期直接費用', help: '任意。グループ外への支出', get: (c) => c.lessee.idc || '', set: (o, v, e, l) => { o.lessee.idc = toNum(v, e, l) ?? 0; } },
  { label: '借手：使用部門', help: '販管費／製造原価', get: (c) => first(DEPT, c.lessee.dept), set: (o, v, e, l) => { o.lessee.dept = toChoice(v, DEPT, e, l) ?? 'sga'; } },
  { label: '借手：償却月数', help: '任意。空欄＝リース期間', get: (c) => c.lessee.depMonths ?? '', set: (o, v, e, l) => { o.lessee.depMonths = toNum(v, e, l); } },
  { label: '借手：当初リース負債の取込値', help: '任意。空欄＝アプリで計算', get: (c) => c.lessee.liabilityOverride ?? '', set: (o, v, e, l) => { o.lessee.liabilityOverride = toNum(v, e, l); } },
  { label: '借手：適用開始前の契約の使用権資産', help: 'リース負債と同額／遡及', get: (c) => first(ROU_TR, c.lessee.rouTransition), set: (o, v, e, l) => { o.lessee.rouTransition = toChoice(v, ROU_TR, e, l) ?? 'eq_liability'; } },
  { label: '借手：適用開始時の割引率（年％）', help: '任意。空欄＝上の割引率', get: (c) => (c.lessee.transitionRate === null || c.lessee.transitionRate === undefined ? '' : +(c.lessee.transitionRate * 100).toFixed(6)), set: (o, v, e, l) => { o.lessee.transitionRate = toPct(v, e, l); } },
  { label: '借手：法人税法上のリース取引', help: 'はい／いいえ', get: (c) => (c.lessee.taxLease ? 'はい' : 'いいえ'), set: (o, v, e, l) => { o.lessee.taxLease = toBool(v, e, l) ?? false; } },
  { label: '貸手：資産ID', help: '同じ資産を複数契約で使う場合は同じID', get: (c) => c.lessor.assetId, set: (o, v) => { o.lessor.assetId = norm(v); } },
  { label: '貸手：対象資産の取得原価', help: '', get: (c) => c.lessor.assetCost || '', set: (o, v, e, l) => { o.lessor.assetCost = toNum(v, e, l) ?? 0; } },
  { label: '貸手：耐用年数（月数）', help: '', get: (c) => c.lessor.assetLifeMonths || '', set: (o, v, e, l) => { o.lessor.assetLifeMonths = toNum(v, e, l) ?? 0; } },
  { label: '貸手：取得年月', help: '例：2015-04', get: (c) => c.lessor.assetStart || '', set: (o, v, e, l) => { o.lessor.assetStart = toYm(v, e, l); } },
  { label: '貸手：按分比率（％）', help: '空欄＝100', get: (c) => +(c.lessor.ratio * 100).toFixed(6), set: (o, v, e, l) => { o.lessor.ratio = toPct(v, e, l) ?? 1; } },
  { label: '貸手：受取リース料の計上区分', help: '売上高／営業外収益', get: (c) => first(INC, c.lessor.incClass), set: (o, v, e, l) => { o.lessor.incClass = toChoice(v, INC, e, l) ?? 'sales'; } },
  { label: '貸手：減価償却費の計上区分', help: '売上原価／営業外費用', get: (c) => first(DEPC, c.lessor.depClass), set: (o, v, e, l) => { o.lessor.depClass = toChoice(v, DEPC, e, l) ?? 'cogs'; } },
  { label: '貸手：リース期間（月数）', help: '任意。空欄＝借手と同じ', get: (c) => c.lessor.termMonths ?? '', set: (o, v, e, l) => { o.lessor.termMonths = toNum(v, e, l); } },
];

/** 取込用テンプレート（見出し行・説明行・記入例）。説明行は # で始まり、取込時は読み飛ばす */
export function contractTemplateCsv(examples = []) {
  const head = CONTRACT_COLUMNS.map((c) => c.label);
  const help = CONTRACT_COLUMNS.map((c, i) => (i === 0 ? `#説明（この行は取り込みません）：${c.help}` : c.help));
  return toCsv([head, help, ...examples.map((c) => CONTRACT_COLUMNS.map((col) => col.get(sanitizeContract(c))))]);
}

/** 登録済みの契約を同じ形式で書き出す（編集して取り込み直せる） */
export function contractsToCsv(contracts) {
  return toCsv([CONTRACT_COLUMNS.map((c) => c.label), ...contracts.map((c) => CONTRACT_COLUMNS.map((col) => col.get(c)))]);
}

/** CSV の文字列を行×列の配列にする（ダブルクォート・改行を含むセルに対応） */
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * CSV から契約を読み込む。
 * @returns {{ contracts: object[], errors: {row:number,id:string,messages:string[]}[], added: string[], replaced: string[] }}
 *   errors が1件でもあれば、画面では取り込まない（ファイルを直して再度取り込む）。
 */
export function importContractsCsv(text, data) {
  const rows = parseCsv(text).filter((r) => r.some((x) => String(x).trim() !== ''));
  const errors = [];
  if (!rows.length) return { contracts: [], errors: [{ row: 0, id: '', messages: ['ファイルが空です'] }], added: [], replaced: [] };
  const header = rows[0].map((x) => norm(x).replace(/^'/, ''));
  // 見出しは全角・半角の違いを無視して照合する（例：「借手：」と「借手:」）
  const colIdx = CONTRACT_COLUMNS.map((c) => header.indexOf(norm(c.label)));
  const missing = CONTRACT_COLUMNS.filter((c, i) => colIdx[i] < 0 && ['契約番号', '貸手会社コード', '借手会社コード', 'リース開始年月', 'リース期間（月数）'].includes(c.label));
  if (missing.length) return { contracts: [], errors: [{ row: 1, id: '', messages: [`見出し行に必須の列がありません：${missing.map((c) => c.label).join('、')}（アプリのテンプレートを使ってください）`] }], added: [], replaced: [] };
  const body = rows.slice(1).map((r, i) => ({ r, line: i + 2 })).filter((x) => !String(x.r[0] ?? '').trim().startsWith('#'));
  if (body.length > MAX_ROWS) return { contracts: [], errors: [{ row: 0, id: '', messages: [`一度に取り込めるのは${MAX_ROWS}件までです`] }], added: [], replaced: [] };
  const contracts = [], added = [], replaced = [], seen = new Map();
  for (const { r, line } of body) {
    const errs = [];
    const raw = { lessee: {}, lessor: {} };
    CONTRACT_COLUMNS.forEach((col, i) => { if (colIdx[i] >= 0) col.set(raw, r[colIdx[i]] ?? '', errs, col.label); });
    const existing = data.contracts.find((x) => x.id === raw.id);
    // 既存の契約を上書きする場合、CSV にない項目（条件変更・実績）は引き継ぐ
    const merged = existing ? { ...raw, modifications: existing.modifications, actuals: existing.actuals, paymentOverrides: existing.paymentOverrides, lessee: { ...existing.lessee, ...raw.lessee }, lessor: { ...existing.lessor, ...raw.lessor } } : raw;
    const c = sanitizeContract(merged);
    if (seen.has(c.id)) errs.push(`契約番号「${c.id}」がファイル内で重複しています（${seen.get(c.id)}行目）`);
    if (raw.lessee.rate !== null && raw.lessee.rate > 0 && raw.lessee.rate < 0.001) errs.push('借手：割引率が0.1％未満です。％の数値（例：2.5）で入力してください');
    errs.push(...validateContract(merged, data.companies).filter((m) => !errs.includes(m)));
    seen.set(c.id, line);
    if (errs.length) { errors.push({ row: line, id: raw.id || '', messages: [...new Set(errs)] }); continue; }
    contracts.push(c);
    (existing ? replaced : added).push(c.id);
  }
  return { contracts, errors, added, replaced };
}
