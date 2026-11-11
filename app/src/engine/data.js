// 取込データの検証・無害化（共通部品）
// 外部から読み込んだ JSON は許可リストの項目だけを取り出して再構成する（未知の項目は破棄）。

const MAX_STR = 200;
const MAX_CONTRACTS = 5000;
const MAX_COMPANIES = 500;

function str(v, max = MAX_STR, def = '') {
  if (v === null || v === undefined) return def;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '');
  return s.slice(0, max);
}
function num(v, def = 0, { min = -1e15, max = 1e15 } = {}) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}
function int(v, def = 0, opts) {
  return Math.round(num(v, def, opts));
}
function bool(v, def = false) {
  return typeof v === 'boolean' ? v : def;
}
function oneOf(v, list, def) {
  return list.includes(v) ? v : def;
}
function ym(v) {
  const s = str(v, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null;
}

import { sanitizeNoteInputs } from './notes.js';
import { RESERVED_IDS } from './schedule.js';
import { ACCOUNTS } from './accounts.js';

const CODE_RE = /^[^\u0000-\u001f\u007f|]{1,20}$/;
const RESERVED = RESERVED_IDS;
/** 会社コード：制御文字・区切り文字「|」を含まない1〜20文字で、予約語でないこと */
export function validCode(code) {
  return typeof code === 'string' && CODE_RE.test(code) && !RESERVED.has(code);
}

/** 税率・非支配株主持分比率の履歴（適用開始年月つき） */
function sanitizeHistory(h, base) {
  if (!Array.isArray(h)) return [];
  // 片方の率だけを変更する行は、もう一方を直前の率から引き継ぐ（未入力を0とみなさない）
  const rows = h.slice(0, 100).filter((x) => x && typeof x === 'object' && ym(x.fromYm)).sort((a, b) => (ym(a.fromYm) < ym(b.fromYm) ? -1 : 1));
  let prevT = base.taxRate, prevN = base.nciRatio;
  const seen = new Set();
  const out = [];
  for (const x of rows) {
    const f = ym(x.fromYm);
    if (seen.has(f)) continue;
    seen.add(f);
    const t = x.taxRate === undefined || x.taxRate === null || x.taxRate === '' ? prevT : num(x.taxRate, prevT, { min: 0, max: 0.99 });
    const n = x.nciRatio === undefined || x.nciRatio === null || x.nciRatio === '' ? prevN : num(x.nciRatio, prevN, { min: 0, max: 1 });
    out.push({ fromYm: f, taxRate: t, nciRatio: n });
    prevT = t; prevN = n;
  }
  return out;
}

export function sanitizeCompany(c) {
  const taxRate = num(c.taxRate, 0, { min: 0, max: 0.99 });
  const nciRatio = num(c.nciRatio, 0, { min: 0, max: 1 });
  const ad = c.adoption && typeof c.adoption === 'object' ? c.adoption : {};
  return {
    code: str(c.code, 20),
    name: str(c.name, 100),
    isParent: bool(c.isParent),
    fyeMonth: int(c.fyeMonth, 3, { min: 1, max: 12 }),
    taxRate,
    nciRatio,
    taxEffect: c.taxEffect === false ? false : true,
    legacyAccounts: bool(c.legacyAccounts),
    splitsCurrent: c.splitsCurrent === false ? false : true,
    currency: str(c.currency || 'JPY', 3),
    dtaRatio: num(c.dtaRatio ?? 1, 1, { min: 0, max: 1 }),
    // 適用初年度の設定がない旧版のデータは、旧版と同じ結果になる「リース開始時から測定」（完全遡及）で読み込む
    adoption: { method: oneOf(ad.method, ['cumulative', 'retrospective', 'applied'], c.adoption ? 'cumulative' : 'retrospective'), ym: ym(ad.ym) || '2027-04' },
    history: sanitizeHistory(c.history, { taxRate, nciRatio }),
  };
}

export function sanitizeContract(c) {
  const l = c.lessee && typeof c.lessee === 'object' ? c.lessee : {};
  const r = c.lessor && typeof c.lessor === 'object' ? c.lessor : {};
  const t = l.transition && typeof l.transition === 'object' ? l.transition : {};
  const actuals = {};
  if (c.actuals && typeof c.actuals === 'object') {
    for (const [k, v] of Object.entries(c.actuals).slice(0, 200)) {
      if (!ym(k) || !v || typeof v !== 'object') continue;
      const a = {};
      for (const f of ['L', 'rouNet', 'inc', 'cur', 'R']) if (v[f] !== undefined && v[f] !== null && v[f] !== '') a[f] = num(v[f], 0);
      actuals[k] = a;
    }
  }
  return {
    id: str(c.id, 30),
    name: str(c.name, 100),
    lessorCo: str(c.lessorCo, 20),
    lesseeCo: str(c.lesseeCo, 20),
    assetClass: oneOf(c.assetClass, ['building', 'machine', 'vehicle', 'tool', 'land', 'other'], 'other'),
    commencement: ym(c.commencement) || '2027-04',
    termMonths: int(c.termMonths, 12, { min: 1, max: 1200 }),
    frequencyMonths: oneOf(Number(c.frequencyMonths), [1, 3, 6, 12], 1),
    timing: oneOf(c.timing, ['arrears', 'advance'], 'arrears'),
    payment: num(c.payment, 0, { min: 0 }),
    freePayments: int(c.freePayments, 0, { min: 0, max: 1200 }),
    steps: Array.isArray(c.steps) ? c.steps.slice(0, 50).map((s) => ({ fromPayment: int(s?.fromPayment, 1, { min: 1, max: 1200 }), amount: num(s?.amount, 0, { min: 0 }) })) : [],
    terminationYm: ym(c.terminationYm),
    terminationPenalty: num(c.terminationPenalty, 0, { min: 0 }),
    modifications: Array.isArray(c.modifications) ? c.modifications.slice(0, 50).filter((m) => m && typeof m === 'object' && ym(m.ym)).map((m) => ({
      ym: ym(m.ym),
      payment: m.payment === null || m.payment === undefined || m.payment === '' ? null : num(m.payment, 0, { min: 0 }),
      termMonths: m.termMonths === null || m.termMonths === undefined || m.termMonths === '' ? null : int(m.termMonths, 12, { min: 1, max: 1200 }),
      rate: m.rate === null || m.rate === undefined || m.rate === '' ? null : num(m.rate, 0, { min: 0, max: 0.99 }),
      note: str(m.note, 200),
    })) : [],
    lessee: {
      model: oneOf(l.model, ['jgaap', 'asc842ol', 'offbalance'], 'jgaap'),
      offKind: oneOf(l.offKind, ['short', 'low'], 'short'), // 簡便的な取扱いの種類（短期リース／少額リース）。注記の「短期リースに係る費用」に使う
      rate: num(l.rate, 0, { min: 0, max: 0.99 }),
      idc: num(l.idc, 0, { min: 0 }),
      dept: oneOf(l.dept, ['sga', 'mfg'], 'sga'),
      liabilityOverride: l.liabilityOverride === null || l.liabilityOverride === undefined || l.liabilityOverride === '' ? null : num(l.liabilityOverride, 0, { min: 0 }),
      depMonths: l.depMonths === null || l.depMonths === undefined || l.depMonths === '' ? null : int(l.depMonths, 12, { min: 1, max: 1200 }),
      transition: t.method === 'cumulative' ? { method: 'cumulative', ym: ym(t.ym), rate: num(t.rate, 0, { min: 0, max: 0.99 }) } : { method: 'none' },
      rouTransition: oneOf(l.rouTransition, ['eq_liability', 'retrospective'], 'eq_liability'),
      transitionRate: l.transitionRate === null || l.transitionRate === undefined || l.transitionRate === '' ? null : num(l.transitionRate, 0, { min: 0, max: 0.99 }),
      taxLease: bool(l.taxLease),
    },
    lessor: {
      assetId: str(r.assetId, 30),
      assetCost: num(r.assetCost, 0, { min: 0 }),
      assetLifeMonths: int(r.assetLifeMonths, 0, { min: 0, max: 1200 }),
      assetStart: ym(r.assetStart),
      ratio: num(r.ratio, 1, { min: 0.0001, max: 1 }),
      incClass: oneOf(r.incClass, ['sales', 'nonop'], 'sales'),
      depClass: oneOf(r.depClass, ['cogs', 'nonop'], 'cogs'),
      termMonths: r.termMonths === null || r.termMonths === undefined || r.termMonths === '' ? null : int(r.termMonths, 12, { min: 1, max: 1200 }),
    },
    // 返済スケジュールの手修正（支払月 → 支払額）
    paymentOverrides: Array.isArray(c.paymentOverrides) ? c.paymentOverrides.slice(0, 1200).filter((x) => x && ym(x.ym)).map((x) => ({ ym: ym(x.ym), amount: num(x.amount, 0, { min: 0 }), reason: str(x.reason, 200) })) : [],
    actuals,
  };
}

/**
 * 取込データ全体の検証。例外を投げずに { data, warnings } を返す。
 */
/** 連結修正仕訳の繰越設定（内容別）。未知の内容・値は捨てる（初期値はエンジンが持つ） */
export function sanitizeCarry(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['C-02', 'C-03', 'C-04', 'C-20', 'C-17', 'C-13', 'C-14', 'C-10', 'C-11']) if (['carry_reverse', 'carry', 'none'].includes(raw[k])) out[k] = raw[k];
  return out;
}

/** 仕訳の手修正（期間・契約・内容ごとに、手修正後の行と修正前の行・理由） */
export function sanitizeOverrides(raw) {
  const list = raw && Array.isArray(raw.journals) ? raw.journals.slice(0, 5000) : [];
  // 科目は既知の勘定科目だけ、会社は会社コードの規則か「連結」だけを受け付ける
  const lines = (ls) => (Array.isArray(ls) ? ls.slice(0, 50).filter((l) => l && Object.prototype.hasOwnProperty.call(ACCOUNTS, l.acc) && (l.co === 'CONSOL' || validCode(l.co))).map((l) => ({ acc: l.acc, co: l.co, amt: num(l.amt, 0), label: str(l.label, 60) })) : []);
  return { journals: list.filter((o) => o && ym(o.periodStart) && ym(o.periodEnd) && /^[A-Z]-?[0-9A-Z-]{1,8}$/.test(o.tpl || '')).map((o) => ({
    key: str(o.key, 120), periodStart: ym(o.periodStart), periodEnd: ym(o.periodEnd), contractId: str(o.contractId, 30), tpl: str(o.tpl, 10), src: str(o.src, 10),
    lines: lines(o.lines), orig: lines(o.orig), reason: str(o.reason, 300), at: str(o.at, 40),
  })) };
}

export function sanitizeData(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('データ形式が不正です（JSONオブジェクトではありません）');
  const companies = Array.isArray(raw.companies) ? raw.companies.slice(0, MAX_COMPANIES).filter((x) => x && typeof x === 'object').map(sanitizeCompany) : [];
  const contracts = Array.isArray(raw.contracts) ? raw.contracts.slice(0, MAX_CONTRACTS).filter((x) => x && typeof x === 'object').map(sanitizeContract) : [];
  if (Array.isArray(raw.contracts) && raw.contracts.length > MAX_CONTRACTS) warnings.push(`契約は最大${MAX_CONTRACTS}件までのため、超過分を読み込みませんでした`);
  // 会社コード・契約番号の問題は読込を止めずに自動で付け替え、警告として知らせる（既存データを失わないため）
  const codes = new Set();
  const rename = new Map();
  for (const c of companies) {
    let code = c.code;
    const invalid = !validCode(code);
    if (invalid || codes.has(code)) {
      let n = 1;
      const baseCode = (code && validCode(code) ? code : String(code || 'CO').replace(/[\u0000-\u001f\u007f|]/g, '').replace(/^(__proto__|prototype|constructor)$/, 'CO') || 'CO').slice(0, 16);
      while (codes.has(`${baseCode}_${n}`)) n++;
      const nc = `${baseCode}_${n}`;
      warnings.push(`会社コード「${code}」は${!code ? '空' : invalid ? '使用できない文字・予約語を含む' : '重複'}のため「${nc}」に付け替えました${invalid ? '' : '（契約は先に登録された会社を参照したままです）'}`);
      // 重複の場合、契約の参照は最初の会社のまま（付け替えた側は契約のない会社として残す）
      if (invalid && code && !rename.has(code)) rename.set(code, nc);
      c.code = nc;
    }
    codes.add(c.code);
  }
  const ids = new Set();
  for (const c of contracts) {
    if (rename.has(c.lessorCo)) c.lessorCo = rename.get(c.lessorCo);
    if (rename.has(c.lesseeCo)) c.lesseeCo = rename.get(c.lesseeCo);
    if (!c.id || RESERVED_IDS.has(c.id) || ids.has(c.id)) {
      let n = 2;
      const baseId = (c.id && !RESERVED_IDS.has(c.id) ? c.id : 'K').slice(0, 24);
      while (ids.has(`${baseId}-${n}`)) n++;
      warnings.push(`契約番号「${c.id}」は${!c.id ? '空' : RESERVED_IDS.has(c.id) ? '予約語' : '重複'}のため「${baseId}-${n}」に付け替えました`);
      c.id = `${baseId}-${n}`;
    }
    ids.add(c.id);
  }
  const cfg = raw.config && typeof raw.config === 'object' ? raw.config : {};
  const accountNames = {};
  if (cfg.accountNames && typeof cfg.accountNames === 'object') {
    for (const [k, v] of Object.entries(cfg.accountNames).slice(0, 200)) if (/^[A-Z_]{2,20}(\.[a-z]{2,10})?$/.test(k)) accountNames[k] = str(v, 60);
    // 旧版の科目キーからの移行
    if (accountNames.LEASE_COST) {
      for (const k of ['ASC_COST', 'SHORT_COST', 'PRE_RENT']) if (!accountNames[k]) accountNames[k] = accountNames.LEASE_COST;
      delete accountNames.LEASE_COST;
      warnings.push('旧版の科目「LEASE_COST」の名称を、ASC_COST・SHORT_COST・PRE_RENT に引き継ぎました');
    }
  }
  const notes = {};
  if (raw.notes && typeof raw.notes === 'object') {
    for (const [k, v] of Object.entries(raw.notes).slice(0, 100)) if (/^POL-\d{2}$/.test(k)) notes[k] = str(v, 4000);
  }
  // 監査ログは切り捨てない（上限を超えた場合のみ古い記録を除き、連鎖の起点ハッシュを auditAnchor に残す）
  const rawLog = Array.isArray(raw.auditLog) ? raw.auditLog : [];
  const MAX_LOG = 100000;
  const kept = rawLog.slice(-MAX_LOG).map((e) => ({ at: str(e?.at, 40), action: str(e?.action, 60), detail: str(e?.detail, 500), prev: str(e?.prev, 32), hash: str(e?.hash, 32) }));
  const auditLog = kept;
  const auditAnchor = rawLog.length > MAX_LOG ? kept[0]?.prev || '' : str(raw.auditAnchor || '', 32);
  const importedLogs = Array.isArray(raw.importedLogs) ? raw.importedLogs.slice(0, 50).map((x) => ({ file: str(x?.file, 120), at: str(x?.at, 40), anchor: str(x?.anchor, 32), log: Array.isArray(x?.log) ? x.log.slice(-MAX_LOG).map((e) => ({ at: str(e?.at, 40), action: str(e?.action, 60), detail: str(e?.detail, 500), prev: str(e?.prev, 32), hash: str(e?.hash, 32) })) : [] })) : [];
  if (raw.companies && Array.isArray(raw.companies) && raw.companies.some((c) => c && typeof c === 'object' && !c.adoption)) warnings.push('適用初年度の方法が未設定の会社は「完全遡及（リース開始時から測定）」として読み込みました。会社マスタで確認してください');
  const manualJournals = Array.isArray(raw.manualJournals) ? raw.manualJournals.slice(0, 2000).map(sanitizeManual).filter(Boolean) : [];
  const locks = Array.isArray(raw.locks) ? raw.locks.slice(0, 500).map(sanitizeLock).filter(Boolean) : [];
  const checkNotes = {};
  if (raw.checkNotes && typeof raw.checkNotes === 'object') {
    for (const [k, v] of Object.entries(raw.checkNotes).slice(0, 50)) if (/^CHK-\d{2}$/.test(k)) checkNotes[k] = str(v, 2000);
  }
  return {
    data: {
      version: 1,
      config: { unit: str(cfg.unit || '千円', 10), fyeMonth: int(cfg.fyeMonth, 3, { min: 1, max: 12 }), accountNames, carry: sanitizeCarry(cfg.carry) },
      companies,
      contracts,
      notes,
      manualJournals,
      locks,
      checkNotes,
      noteInputs: sanitizeNoteInputs(raw.noteInputs),
      overrides: sanitizeOverrides(raw.overrides),
      auditLog,
      auditAnchor,
      importedLogs,
    },
    warnings,
  };
}

/** 手入力仕訳（理由必須） */
export function sanitizeManual(m) {
  if (!m || typeof m !== 'object') return null;
  const lines = Array.isArray(m.lines) ? m.lines.slice(0, 50).map((l) => ({
    acc: /^[A-Z_]{2,20}$/.test(l?.acc) && l.acc !== 'LEASE_COST' ? l.acc : 'MANUAL',
    label: str(l?.label, 60),
    co: str(l?.co, 20),
    amt: Math.round(num(l?.amt, 0)),
  })).filter((l) => l.amt !== 0) : [];
  const start = ym(m.periodStart), end = ym(m.periodEnd);
  if (!start || !end || !lines.length) return null;
  return { id: str(m.id, 40), periodStart: start, periodEnd: end, kind: m.kind === 'IND' ? 'IND' : 'CON', carry: m.carry === 'carry' ? 'carry' : 'none', contractId: str(m.contractId, 30), title: str(m.title, 100), reason: str(m.reason, 1000), evidence: str(m.evidence, 300), createdAt: str(m.createdAt, 40), lines };
}

/** 期間確定（スナップショット） */
export function sanitizeLock(l) {
  if (!l || typeof l !== 'object') return null;
  const start = ym(l.periodStart), end = ym(l.periodEnd);
  if (!start || !end) return null;
  const snap = Object.create(null);
  if (l.snapshot && typeof l.snapshot === 'object') {
    for (const [cid, v] of Object.entries(l.snapshot).slice(0, 5000)) {
      if (!v || typeof v !== 'object') continue;
      const nets = Object.create(null);
      if (v.nets && typeof v.nets === 'object') for (const [k, a] of Object.entries(v.nets).slice(0, 500)) if (typeof k === 'string' && k.length <= 160 && !/[\u0000-\u001f]/.test(k)) nets[k] = Math.round(num(a, 0));
      snap[str(cid, 30)] = { nets };
    }
  }
  return { periodStart: start, periodEnd: end, label: str(l.label, 60), lockedAt: str(l.lockedAt, 40), policiesHash: str(l.policiesHash, 40), snapHash: str(l.snapHash, 32), imported: l.imported === true, policies: l.policies && typeof l.policies === 'object' ? Object.fromEntries(Object.entries(l.policies).filter(([k]) => /^POL-\d{2}$/.test(k)).map(([k, v]) => [k, str(v, 30)])) : null, snapshot: snap };
}

/** CSV セルの無害化（数式インジェクション対策：NFR-011） */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** 監査ログ用の簡易ハッシュ（FNV-1a 32bit×2）。改ざん検知の補助であり暗号学的強度はない。 */
export function chainHash(prev, text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  const s = `${prev}|${text}`;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c; h2 = Math.imul(h2, 0x5bd1e995) >>> 0; h2 ^= h2 >>> 15;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function verifyChain(log, anchor = '') {
  let prev = anchor || '';
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.prev !== prev || e.hash !== chainHash(prev, `${e.at}|${e.action}|${e.detail}`)) return { ok: false, index: i };
    prev = e.hash;
  }
  return { ok: true, index: -1 };
}

export function appendLog(log, action, detail) {
  const prev = log.length ? log[log.length - 1].hash : '';
  const at = new Date().toISOString();
  const d = str(detail, 500);
  const a = str(action, 60);
  log.push({ at, action: a, detail: d, prev, hash: chainHash(prev, `${at}|${a}|${d}`) });
  return log;
}
