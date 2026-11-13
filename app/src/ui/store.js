// アプリの状態管理。ブラウザの localStorage に保存（利用者ごとの端末内のみ）。
// localStorage が使えない環境（プライベートモード等）でも動作するよう、すべて try/catch で保護する。
import { sampleData, TEST_DATA_VERSION } from '../engine/sample.js';
import { sampleNoteInputs } from '../engine/sampleNotes.js';

/** サンプルデータ（注記の収集値のテストデータつき） */
function fullSample(pol) {
  const d = sampleData();
  try { d.noteInputs = sampleNoteInputs(d, pol); } catch { d.noteInputs = {}; }
  return d;
}

import { sanitizeData, appendLog, chainHash, sanitizeCompany, sanitizeContract } from '../engine/data.js';
import { defaultPolicies, sanitizePolicies } from '../engine/policies.js';
import { deepClone, indexToYm } from '../engine/util.js';

/** 期間の区切り：年度、四半期（発生・累計）、月次（発生・累計） */
export const GRANULARITIES = ['year', 'quarter', 'quarter_ytd', 'month', 'month_ytd'];

const KEY = 'newlease.v1';

function loadRaw() {
  try {
    const s = localStorage.getItem(KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export const state = {
  data: null,
  policies: null,
  ui: { granularity: 'year', periodIndex: null, contractId: null, journalFilter: {}, palette: 'bt', menuOpen: false },
  dirty: null, // 保存していない変更（画面名）。画面移動の前に確認する
  storageOk: true,
  loadWarnings: [],
  loadNotice: null, // 読込時のお知らせ（テスト物件の自動追加など）
  loadError: null,
  version: 0,
  listeners: new Set(),
};

export function init() {
  const raw = loadRaw();
  if (raw && raw.data) {
    try {
      const res = sanitizeData(raw.data);
      state.data = res.data;
      state.loadWarnings = res.warnings;
      state.policies = sanitizePolicies(raw.policies);
      // 以前の版で保存されたデータには、追加したテスト物件がない。未登録のものだけを一度だけ自動で追加する（既存は変更・削除しない）
      if ((state.data.config.testDataVersion || 0) < TEST_DATA_VERSION) {
        const r = mergeTestData();
        const n = mergeTestNotes();
        state.data.config.testDataVersion = TEST_DATA_VERSION;
        const parts = [r.contracts.length || r.companies.length ? `テスト物件（会社 ${r.companies.length}社・契約 ${r.contracts.length}件）` : '', n ? `注記の収集値のテストデータ（${n}件）` : ''].filter(Boolean);
        if (parts.length) state.loadNotice = `以前の版で保存されたデータに、${parts.join('と')}を追加しました。登録済みの会社・契約・収集値は変更・削除していません。不要な場合は削除できます（削除したものは再び追加されません）。`;
      }
      state.ui = { ...state.ui, ...(raw.ui && typeof raw.ui === 'object' ? { granularity: GRANULARITIES.includes(raw.ui.granularity) ? raw.ui.granularity : 'year', periodIndex: Number.isInteger(raw.ui.periodIndex) ? raw.ui.periodIndex : null, palette: ['bt', 'blue', 'lightblue', 'green', 'red', 'teal', 'dark'].includes(raw.ui.palette) ? raw.ui.palette : 'bt' } : {}) };
    } catch (e) {
      // 読込に失敗しても元のデータは消さず、別のキーに退避してから初期状態で開く
      try { localStorage.setItem(`${KEY}.backup.${Date.now()}`, JSON.stringify(raw)); } catch { /* 退避できない場合も続行 */ }
      state.loadError = `保存データを読み込めなかったため、退避してサンプルデータで開きました（${e.message}）。退避したデータは「データ管理」から書き出せます。`;
      state.policies = defaultPolicies();
      state.data = fullSample(state.policies);
    }
  } else {
    state.policies = defaultPolicies();
    state.data = fullSample(state.policies);
    appendLog(state.data.auditLog, '初期化', 'サンプルデータを読み込みました');
  }
  save();
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ data: state.data, policies: state.policies, ui: { granularity: state.ui.granularity, periodIndex: state.ui.periodIndex, palette: state.ui.palette } }));
    state.storageOk = true;
  } catch {
    state.storageOk = false;
  }
}

export function subscribe(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

export function emit(dataChanged = true) {
  if (dataChanged) state.version++;
  save();
  for (const fn of state.listeners) fn();
}

/** データ更新（監査ログに記録） */
export function update(mutator, action, detail) {
  mutator(state.data, state.policies);
  if (action) appendLog(state.data.auditLog, action, detail || '');
  emit();
}

export function setUi(patch) {
  Object.assign(state.ui, patch);
  emit(false);
}

/**
 * テスト物件（サンプルの会社・契約）のうち、まだ登録されていないものだけを追加する。既存の会社・契約は変更・削除しない。
 * 同じ会社コード・契約番号がすでにあるものは追加しない（上書きしない）。
 * @returns {{ companies: string[], contracts: string[], skipped: string[] }}
 */
export function addTestData() {
  const r = mergeTestData(true);
  return r;
}

/** 注記の収集値のテストデータのうち、未入力のもの（期間・会社・項目）だけを追加する。戻り値：追加した件数 */
function mergeTestNotes() {
  let add;
  try { add = sampleNoteInputs(state.data, state.policies); } catch { return 0; }
  const cur = state.data.noteInputs || (state.data.noteInputs = {});
  const codes = new Set(state.data.companies.map((c) => c.code));
  let n = 0;
  for (const [pk, byCo] of Object.entries(add)) for (const [co, byKey] of Object.entries(byCo)) {
    if (!codes.has(co)) continue;
    for (const [k, v] of Object.entries(byKey)) {
      const t = ((cur[pk] ||= {})[co] ||= {});
      if (t[k]) continue;
      t[k] = v; n++;
    }
  }
  if (n) appendLog(state.data.auditLog, '注記の収集値のテストデータの追加（自動）', `${Object.keys(add).join('、')}：${n}件（未入力の項目だけ）`);
  return n;
}

/** 未登録のテスト物件を state.data に追加する（log=true のときは画面の操作として監査ログに記録して再描画） */
function mergeTestData(viaUpdate = false) {
  const s = sampleData();
  const codes = new Set(state.data.companies.map((c) => c.code));
  const ids = new Set(state.data.contracts.map((c) => c.id));
  const coAdd = s.companies.filter((c) => !codes.has(c.code));
  const usable = new Set([...codes, ...coAdd.map((c) => c.code)]);
  const kAdd = s.contracts.filter((c) => !ids.has(c.id) && usable.has(c.lessorCo) && usable.has(c.lesseeCo));
  const skipped = s.contracts.filter((c) => ids.has(c.id)).map((c) => c.id);
  if (!coAdd.length && !kAdd.length) return { companies: [], contracts: [], skipped };
  const mut = (d) => {
    d.companies.push(...coAdd.map(sanitizeCompany).map((c) => ({ ...c, isParent: false })));
    d.contracts.push(...kAdd.map(sanitizeContract));
  };
  if (!viaUpdate) {
    mut(state.data);
    appendLog(state.data.auditLog, 'テスト物件の追加（自動）', `会社 ${coAdd.map((c) => c.code).join('、') || 'なし'}／契約 ${kAdd.length}件（${kAdd.map((c) => c.id).join('、')}）`);
    return { companies: coAdd.map((c) => c.code), contracts: kAdd.map((c) => c.id), skipped };
  }
  update(mut, 'テスト物件の追加', `会社 ${coAdd.map((c) => c.code).join('、') || 'なし'}／契約 ${kAdd.length}件（${kAdd.map((c) => c.id).join('、')}）${skipped.length ? `／登録済みのため追加しない ${skipped.length}件` : ''}`);
  return { companies: coAdd.map((c) => c.code), contracts: kAdd.map((c) => c.id), skipped };
}

export function resetSample() {
  const log = state.data?.auditLog || [];
  const anchor = state.data?.auditAnchor || '';
  state.data = fullSample(state.policies);
  state.data.auditLog = log;
  state.data.auditAnchor = anchor;
  appendLog(state.data.auditLog, 'サンプル復元', 'サンプルデータに置き換えました');
  emit();
}

export function replaceData(newData, label) {
  const log = state.data?.auditLog || [];
  const anchor = state.data?.auditAnchor || '';
  const prevImported = state.data?.importedLogs || [];
  // 取込ファイルの監査ログは破棄せず、別枠で保存して検証できるようにする
  const imported = newData.auditLog && newData.auditLog.length ? [{ file: label, at: new Date().toISOString(), anchor: newData.auditAnchor || '', log: newData.auditLog }] : [];
  state.data = newData;
  state.data.importedLogs = [...prevImported, ...(newData.importedLogs || []), ...imported].slice(-50);
  // 取込ファイルの確定スナップショットは、この端末で確定したものではないため「取込（未検証）」とする
  state.data.locks = (state.data.locks || []).map((l) => ({ ...l, imported: true }));
  state.data.auditLog = [...log];
  state.data.auditAnchor = anchor;
  appendLog(state.data.auditLog, 'データ取込', label);
  emit();
}

export function exportJson() {
  return JSON.stringify({ format: 'newlease-consolidation', exportedAt: new Date().toISOString(), data: state.data, policies: state.policies }, null, 2);
}

export function snapshot() {
  return deepClone({ data: state.data, policies: state.policies });
}

/** 期間の確定（スナップショット保存）。 */
export function lockPeriod(period, nets, policies) {
  const s = indexToYm(period.start), e = indexToYm(period.end);
  if ((state.data.locks || []).some((l) => l.periodStart === s && l.periodEnd === e)) return false;
  const snapHash = chainHash('', JSON.stringify(nets));
  state.data.locks = [...(state.data.locks || []), { periodStart: s, periodEnd: e, label: period.label, lockedAt: new Date().toISOString(), policiesHash: chainHash('', JSON.stringify(policies)), policies: { ...policies }, snapHash, snapshot: nets }];
  appendLog(state.data.auditLog, '期間確定', `${period.label}（契約・手入力仕訳 ${Object.keys(nets).length} 件のスナップショット、ハッシュ ${snapHash}）`);
  emit();
  return true;
}

export function unlockPeriod(period, reason) {
  const s = indexToYm(period.start), e = indexToYm(period.end);
  state.data.locks = (state.data.locks || []).filter((l) => !(l.periodStart === s && l.periodEnd === e));
  appendLog(state.data.auditLog, '確定解除', `${period.label}：${reason}`);
  emit();
}

export function isLocked(period) {
  const s = indexToYm(period.start), e = indexToYm(period.end);
  return (state.data.locks || []).some((l) => l.periodStart === s && l.periodEnd === e);
}

/** 退避されたデータのキー一覧 */
export function backups() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`${KEY}.backup.`)) out.push(k);
    }
  } catch { /* 取得できない環境 */ }
  return out.sort();
}

export function readBackup(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
