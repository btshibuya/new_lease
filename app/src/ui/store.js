// アプリの状態管理。ブラウザの localStorage に保存（利用者ごとの端末内のみ）。
// localStorage が使えない環境（プライベートモード等）でも動作するよう、すべて try/catch で保護する。
import { sampleData } from '../engine/sample.js';
import { sanitizeData, appendLog } from '../engine/data.js';
import { defaultPolicies, sanitizePolicies } from '../engine/policies.js';
import { deepClone } from '../engine/util.js';

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
  ui: { granularity: 'year', periodIndex: null, contractId: null, journalFilter: {}, theme: null },
  storageOk: true,
  listeners: new Set(),
};

export function init() {
  const raw = loadRaw();
  if (raw && raw.data) {
    try {
      state.data = sanitizeData(raw.data).data;
      state.policies = sanitizePolicies(raw.policies);
      state.ui = { ...state.ui, ...(raw.ui && typeof raw.ui === 'object' ? { granularity: raw.ui.granularity === 'quarter' ? 'quarter' : 'year', periodIndex: Number.isInteger(raw.ui.periodIndex) ? raw.ui.periodIndex : null, theme: ['light', 'dark'].includes(raw.ui.theme) ? raw.ui.theme : null } : {}) };
    } catch {
      state.data = sampleData();
      state.policies = defaultPolicies();
    }
  } else {
    state.data = sampleData();
    state.policies = defaultPolicies();
    appendLog(state.data.auditLog, '初期化', 'サンプルデータを読み込みました');
  }
  save();
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ data: state.data, policies: state.policies, ui: { granularity: state.ui.granularity, periodIndex: state.ui.periodIndex, theme: state.ui.theme } }));
    state.storageOk = true;
  } catch {
    state.storageOk = false;
  }
}

export function subscribe(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

export function emit() {
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
  emit();
}

export function resetSample() {
  const log = state.data?.auditLog || [];
  state.data = sampleData();
  state.data.auditLog = log;
  appendLog(state.data.auditLog, 'サンプル復元', 'サンプルデータに置き換えました');
  emit();
}

export function replaceData(newData, label) {
  const log = state.data?.auditLog || [];
  state.data = newData;
  state.data.auditLog = [...log];
  appendLog(state.data.auditLog, 'データ取込', label);
  emit();
}

export function exportJson() {
  return JSON.stringify({ format: 'newlease-consolidation', exportedAt: new Date().toISOString(), data: state.data, policies: state.policies }, null, 2);
}

export function snapshot() {
  return deepClone({ data: state.data, policies: state.policies });
}
