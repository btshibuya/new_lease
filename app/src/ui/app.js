// アプリ本体：画面遷移・期間選択・計算結果の共有
import { h, clear, select } from './dom.js';
import { state, init, subscribe, setUi } from './store.js';
import { buildPeriods, ymToIndex, fiscalYearOf } from '../engine/util.js';
import { buildSchedule } from '../engine/schedule.js';
import { generateAll } from '../engine/elimination.js';
import { runChecks, overallStatus } from '../engine/checks.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderContracts } from './pages/contracts.js';
import { renderCompanies } from './pages/companies.js';
import { renderPolicies } from './pages/policies.js';
import { renderJournals } from './pages/journals.js';
import { renderWorksheet } from './pages/worksheet.js';
import { renderChecks } from './pages/checks.js';
import { renderData } from './pages/data.js';
import { renderHelp } from './pages/help.js';

const PAGES = [
  { id: 'dashboard', label: 'ダッシュボード', render: renderDashboard },
  { id: 'policies', label: '会計方針設定', render: renderPolicies },
  { id: 'contracts', label: '契約・スケジュール', render: renderContracts },
  { id: 'companies', label: '会社マスタ', render: renderCompanies },
  { id: 'journals', label: '仕訳', render: renderJournals },
  { id: 'worksheet', label: '連結精算表・CF・注記', render: renderWorksheet },
  { id: 'checks', label: '検算', render: renderChecks },
  { id: 'data', label: 'データ管理・ログ', render: renderData },
  { id: 'help', label: '使い方・設例', render: renderHelp },
];

export function parentFye(data) {
  return data.companies.find((c) => c.isParent)?.fyeMonth || data.config.fyeMonth || 3;
}

/** 計算（画面描画のたびに実行。契約数千件規模までを想定） */
export function compute() {
  const d = state.data;
  const pol = state.policies;
  const fye = parentFye(d);
  const valid = d.contracts.filter((c) => { try { ymToIndex(c.commencement); return true; } catch { return false; } });
  const starts = valid.map((c) => ymToIndex(c.commencement));
  const ends = valid.map((c) => ymToIndex(c.commencement) + (c.termMonths || 1) - 1);
  const minI = Math.min(ymToIndex('2027-04'), ...starts);
  const maxI = Math.max(ymToIndex('2028-03'), ...ends);
  const periods = buildPeriods(minI, maxI, fye, state.ui.granularity);
  const yearPeriods = buildPeriods(minI, maxI, fye, 'year');
  let idx = state.ui.periodIndex;
  if (!Number.isInteger(idx) || idx < 0 || idx >= periods.length) {
    const [fs] = fiscalYearOf(ymToIndex('2027-04'), fye);
    idx = Math.max(0, periods.findIndex((p) => p.start >= fs));
  }
  const period = periods[idx];
  const schedCache = new Map();
  for (const c of d.contracts) {
    try { schedCache.set(c.id, buildSchedule(c, pol)); } catch { /* 入力エラーは検算で表示 */ }
  }
  const gen = generateAll(d, period, pol, { schedCache });
  const names = d.config.accountNames || {};
  const checks = runChecks(d, period, pol, gen, names, { schedCache });
  return { data: d, pol, periods, yearPeriods, period, periodIndex: idx, gen, checks, names, schedCache, companies: d.companies, unit: d.config.unit || '' , status: overallStatus(checks) };
}

function currentPage() {
  const id = (location.hash || '#/dashboard').replace(/^#\//, '').split('?')[0];
  return PAGES.find((p) => p.id === id) || PAGES[0];
}

function render() {
  const root = document.getElementById('app');
  const page = currentPage();
  let ctx;
  try {
    ctx = compute();
  } catch (e) {
    clear(root).append(h('div', { class: 'error' }, `計算中にエラーが発生しました：${e.message}`));
    return;
  }
  const nav = h('nav', { class: 'nav', 'aria-label': '画面' }, PAGES.map((p) => h('a', { href: `#/${p.id}`, class: p.id === page.id ? 'active' : '', 'aria-current': p.id === page.id ? 'page' : null }, p.label)));
  const periodSel = h('div', { class: 'period' },
    h('label', null, '期間 ',
      select([['year', '年度'], ['quarter', '四半期']], state.ui.granularity, (v) => setUi({ granularity: v, periodIndex: null }))),
    select(ctx.periods.map((p, i) => [i, p.label]), ctx.periodIndex, (v) => setUi({ periodIndex: Number(v) })),
    h('span', { class: 'unit' }, `金額単位：${ctx.unit}`),
    h('a', { href: '#/checks', class: `status-pill st-${ctx.status}` }, ctx.status === 'ok' ? '✓ 検算OK' : ctx.status === 'warn' ? '! 検算：警告あり' : '✕ 検算：NGあり'),
    h('button', { class: 'btn-link', type: 'button', title: '表示テーマの切替', on: { click: () => {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      setUi({ theme: next });
    } } }, '◐ テーマ'));
  const header = h('header', { class: 'top' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-title' }, 'グループ内リース 連結仕訳'), h('div', { class: 'brand-sub' }, '新リース会計基準（企業会計基準第34号）・貸手オペレーティング・リース')),
    periodSel);
  const main = h('main', { id: 'main', class: 'main' });
  try {
    main.append(page.render(ctx));
  } catch (e) {
    main.append(h('div', { class: 'error' }, `画面の表示中にエラーが発生しました：${e.message}`));
    console.error(e);
  }
  const warn = state.storageOk ? null : h('div', { class: 'banner' }, 'この環境ではブラウザ保存が使えないため、変更は再読み込みで失われます。「データ管理」からJSONで保存してください。');
  const scrollY = window.scrollY;
  clear(root).append(header, nav, warn || '', main);
  if (render.lastPage === page.id) window.scrollTo(0, scrollY);
  render.lastPage = page.id;
}

init();
if (state.ui.theme) document.documentElement.dataset.theme = state.ui.theme;
subscribe(render);
window.addEventListener('hashchange', render);
render();
