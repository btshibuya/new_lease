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

export function sanitizeCompany(c) {
  return {
    code: str(c.code, 20),
    name: str(c.name, 100),
    isParent: bool(c.isParent),
    fyeMonth: int(c.fyeMonth, 3, { min: 1, max: 12 }),
    taxRate: num(c.taxRate, 0, { min: 0, max: 0.99 }),
    nciRatio: num(c.nciRatio, 0, { min: 0, max: 1 }),
    taxEffect: c.taxEffect === false ? false : true,
    legacyAccounts: bool(c.legacyAccounts),
    splitsCurrent: c.splitsCurrent === false ? false : true,
    currency: str(c.currency || 'JPY', 3),
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
      for (const f of ['L', 'rouNet', 'inc']) if (v[f] !== undefined && v[f] !== null && v[f] !== '') a[f] = num(v[f], 0);
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
    lessee: {
      model: oneOf(l.model, ['jgaap', 'asc842ol', 'offbalance'], 'jgaap'),
      rate: num(l.rate, 0, { min: 0, max: 0.99 }),
      idc: num(l.idc, 0, { min: 0 }),
      dept: oneOf(l.dept, ['sga', 'mfg'], 'sga'),
      liabilityOverride: l.liabilityOverride === null || l.liabilityOverride === undefined || l.liabilityOverride === '' ? null : num(l.liabilityOverride, 0, { min: 0 }),
      depMonths: l.depMonths === null || l.depMonths === undefined || l.depMonths === '' ? null : int(l.depMonths, 12, { min: 1, max: 1200 }),
      derecognizeAtExpiry: l.derecognizeAtExpiry === false ? false : true,
      transition: t.method === 'cumulative' ? { method: 'cumulative', ym: ym(t.ym), rate: num(t.rate, 0, { min: 0, max: 0.99 }) } : { method: 'none' },
    },
    lessor: {
      assetId: str(r.assetId, 30),
      assetCost: num(r.assetCost, 0, { min: 0 }),
      assetLifeMonths: int(r.assetLifeMonths, 0, { min: 0, max: 1200 }),
      assetStart: ym(r.assetStart),
      ratio: num(r.ratio, 1, { min: 0.0001, max: 1 }),
      incClass: oneOf(r.incClass, ['sales', 'nonop'], 'sales'),
      depClass: oneOf(r.depClass, ['cogs', 'nonop'], 'cogs'),
    },
    actuals,
  };
}

/**
 * 取込データ全体の検証。例外を投げずに { data, warnings } を返す。
 */
export function sanitizeData(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('データ形式が不正です（JSONオブジェクトではありません）');
  const companies = Array.isArray(raw.companies) ? raw.companies.slice(0, MAX_COMPANIES).filter((x) => x && typeof x === 'object').map(sanitizeCompany) : [];
  const contracts = Array.isArray(raw.contracts) ? raw.contracts.slice(0, MAX_CONTRACTS).filter((x) => x && typeof x === 'object').map(sanitizeContract) : [];
  if (Array.isArray(raw.contracts) && raw.contracts.length > MAX_CONTRACTS) warnings.push(`契約は最大${MAX_CONTRACTS}件までのため、超過分を読み込みませんでした`);
  const codes = new Set();
  for (const c of companies) {
    if (!c.code) warnings.push('会社コードが空の会社があります');
    if (codes.has(c.code)) warnings.push(`会社コード「${c.code}」が重複しています`);
    codes.add(c.code);
  }
  const ids = new Set();
  for (const c of contracts) {
    if (ids.has(c.id)) warnings.push(`契約番号「${c.id}」が重複しています`);
    ids.add(c.id);
  }
  const cfg = raw.config && typeof raw.config === 'object' ? raw.config : {};
  const accountNames = {};
  if (cfg.accountNames && typeof cfg.accountNames === 'object') {
    for (const [k, v] of Object.entries(cfg.accountNames).slice(0, 200)) if (/^[A-Z_]{2,20}$/.test(k)) accountNames[k] = str(v, 60);
  }
  const notes = {};
  if (raw.notes && typeof raw.notes === 'object') {
    for (const [k, v] of Object.entries(raw.notes).slice(0, 100)) if (/^POL-\d{2}$/.test(k)) notes[k] = str(v, 4000);
  }
  const auditLog = Array.isArray(raw.auditLog)
    ? raw.auditLog.slice(-5000).map((e) => ({ at: str(e?.at, 40), action: str(e?.action, 60), detail: str(e?.detail, 500), prev: str(e?.prev, 32), hash: str(e?.hash, 32) }))
    : [];
  return {
    data: {
      version: 1,
      config: { unit: str(cfg.unit || '千円', 10), fyeMonth: int(cfg.fyeMonth, 3, { min: 1, max: 12 }), accountNames },
      companies,
      contracts,
      notes,
      manualJournals: [],
      auditLog,
    },
    warnings,
  };
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

export function verifyChain(log) {
  let prev = '';
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
