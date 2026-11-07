// アプリ本体：画面遷移・期間選択・計算結果の共有
import { h, clear, ask, statusBadge } from './dom.js';
import { state, init, subscribe, setUi, isLocked } from './store.js';
import { mountPanel, closeCalc } from './panel.js';
import { POLICIES } from '../engine/policies.js';
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

// 左ツリーの項目。step は作業の順番（番号の丸）。common は最下部の共通項目
const PAGES = [
  { id: 'dashboard', label: '全体の状況', render: renderDashboard, top: true },
  { id: 'companies', label: '会社を登録する', render: renderCompanies, step: 1 },
  { id: 'policies', label: '会計方針を選ぶ', render: renderPolicies, step: 2 },
  { id: 'contracts', label: '契約を登録する', render: renderContracts, step: 3 },
  { id: 'journals', label: '仕訳を確かめる', render: renderJournals, step: 4 },
  { id: 'worksheet', label: '連結精算表・CF・注記', render: renderWorksheet, step: 5 },
  { id: 'checks', label: '検算・期間の確定', render: renderChecks, step: 6 },
  { id: 'data', label: 'データの保存・変更履歴', render: renderData, common: true },
  { id: 'help', label: '使い方・設例', render: renderHelp, common: true },
];

export function parentFye(data) {
  return data.companies.find((c) => c.isParent)?.fyeMonth || data.config.fyeMonth || 3;
}

/** 計算（画面描画のたびに実行。契約数千件規模までを想定） */
let memo = { key: null, ctx: null };
const lockCache = new Map();
let lockCacheVersion = -1;

export function compute() {
  const memoKey = `${state.version}|${state.ui.granularity}|${state.ui.periodIndex}`;
  if (memo.key === memoKey) return memo.ctx;
  if (lockCacheVersion !== state.version) { lockCache.clear(); lockCacheVersion = state.version; }
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
    try { schedCache.set(c.id, buildSchedule(c, pol, { lesseeCompany: d.companies.find((x) => x.code === c.lesseeCo) })); } catch { /* 入力エラーは検算で表示 */ }
  }
  const gen = generateAll(d, period, pol, { schedCache });
  const names = d.config.accountNames || {};
  const checks = runChecks(d, period, pol, gen, names, { schedCache, lockCache });
  const ctx = { data: d, pol, periods, yearPeriods, period, periodIndex: idx, gen, checks, names, schedCache, companies: d.companies, unit: d.config.unit || '', status: overallStatus(checks) };
  memo = { key: memoKey, ctx };
  return ctx;
}

function currentPage() {
  // 「#dashboard」形式（旧形式「#/dashboard」も受け付ける）
  const id = (location.hash || '#dashboard').replace(/^#\/?/, '').split('?')[0];
  return PAGES.find((p) => p.id === id) || PAGES[0];
}

/** 保存していない変更があるときは、画面移動の前に確認する */
export async function guard(fn) {
  if (!state.dirty) { fn(); return; }
  const ok = await ask({ title: '保存していない変更があります', message: `「${state.dirty}」の変更は保存されていません。保存せずに移動しますか？`, okLabel: '保存せずに移動する', danger: true });
  if (ok) { state.dirty = null; fn(); }
}

/** 左ツリーの子項目を押したとき：該当の見出し・行へ移動して黄色く光らせる */
export function flashTo(id) {
  setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2200);
  }, 60);
}

function stepState(p, ctx) {
  const { data, checks, gen, pol } = ctx;
  const chk = (id) => checks.find((c) => c.id === id);
  switch (p.id) {
    case 'companies': return data.companies.some((c) => c.isParent) && data.companies.length > 1 ? { cls: 'ok', text: '✓' } : { cls: 'todo', text: '・' };
    case 'policies': return { cls: 'ok', text: '✓' };
    case 'contracts': {
      const errs = (chk('CHK-00')?.rows || []).filter((r) => !r.warn).length;
      return errs ? { cls: 'warn', text: String(errs) } : data.contracts.length ? { cls: 'ok', text: '✓' } : { cls: 'todo', text: '・' };
    }
    case 'journals': return gen.journals.length && chk('CHK-01')?.status === 'ok' ? { cls: 'ok', text: '✓' } : { cls: 'todo', text: '・' };
    case 'worksheet': return chk('CHK-04')?.status === 'ok' ? { cls: 'ok', text: '✓' } : { cls: 'warn', text: '1' };
    case 'checks': {
      const ng = checks.filter((c) => c.status === 'ng').length;
      if (ng) return { cls: 'warn', text: String(ng) };
      return isLocked(ctx.period) ? { cls: 'ok', text: '✓' } : { cls: 'todo', text: '・' };
    }
    default: return null;
  }
}

function subItems(p, ctx) {
  const { data, checks, pol } = ctx;
  if (p.id === 'policies') return POLICIES.map((d) => ({ label: `${d.id} ${d.title}${pol[d.id] !== d.default ? '（変更）' : ''}`, go: () => flashTo(d.id) }));
  if (p.id === 'checks') return checks.filter((c) => c.status !== 'ok').map((c) => ({ label: `${c.status === 'ng' ? '✕' : '!'} ${c.id} ${c.title.replace(/（.*$/, '')}`, go: () => flashTo(c.id) }));
  return [];
}

function sidebar(page, ctx) {
  const tree = h('ol', { class: 'nav-tree' });
  for (const p of PAGES.filter((x) => x.step)) {
    const stt = stepState(p, ctx);
    const on = p.id === page.id;
    const li = h('li', { class: `nav-step${on ? ' on' : ''}` },
      h('a', { class: 'nav-head', href: `#${p.id}`, 'aria-current': on ? 'page' : null },
        h('span', { class: 'nav-no' }, String(p.step)), h('span', { class: 'nav-label' }, p.label),
        stt ? h('span', { class: `nav-st ${stt.cls}`, title: stt.cls === 'ok' ? '入力済み' : stt.cls === 'warn' ? '確認事項の件数' : '未入力' }, stt.text) : null));
    const subs = subItems(p, ctx);
    if (subs.length && on) {
      li.append(h('ul', { class: 'nav-sub' }, subs.map((x) => h('li', null, h('a', { href: `#${p.id}`, class: x.on ? 'on' : '', 'aria-current': x.on ? 'true' : null, on: { click: (e) => { e.preventDefault(); guard(x.go); } } }, h('span', { class: 'nav-dot' }), x.label)))));
    }
    tree.append(li);
  }
  return h('nav', { class: `sidebar${state.ui.menuOpen ? ' open' : ''}`, id: 'sidebar', 'aria-label': 'メニュー' },
    h('a', { class: `nav-top${page.id === 'dashboard' ? ' on' : ''}`, href: '#dashboard' }, '全体の状況'),
    h('div', { class: 'small muted nav-caption' }, '作業の手順'),
    tree,
    h('div', { class: 'nav-common' }, PAGES.filter((x) => x.common).map((p) => h('a', { href: `#${p.id}`, class: p.id === page.id ? 'on' : '' }, p.label))));
}

// 配色（ビジネストラストが既定）
export const PALETTES = [['bt', 'ビジネストラスト'], ['blue', 'ブルー'], ['lightblue', 'ライトブルー'], ['green', 'グリーン'], ['red', 'レッド'], ['teal', 'ティール'], ['dark', 'ダーク']];

function header() {
  return h('header', { class: 'app-header' },
    h('button', { class: 'btn btn-sm menu-btn', type: 'button', 'aria-controls': 'sidebar', on: { click: () => setUi({ menuOpen: !state.ui.menuOpen }) } }, '☰ メニュー'),
    h('a', { class: 'brand', href: '#dashboard' }, h('img', { src: 'bt-logo.png', alt: 'BUSINESS TRUST', class: 'brand-logo' }), h('span', { class: 'brand-name' }, 'グループ内リース連結仕訳')),
    h('div', { class: 'who' }, h('label', { for: 'palette' }, '配色'),
      h('select', { id: 'palette', on: { change: (e) => { document.documentElement.dataset.palette = e.target.value; setUi({ palette: e.target.value }); } } },
        PALETTES.map(([v2, l]) => h('option', { value: v2, selected: state.ui.palette === v2 }, l)))));
}

function pageHead(page, ctx) {
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '期間の区切り' },
    [['year', '年度'], ['quarter', '四半期（発生）'], ['quarter_ytd', '四半期（累計）']].map(([v2, l]) => h('button', { type: 'button', class: state.ui.granularity === v2 ? 'on' : '', on: { click: () => setUi({ granularity: v2, periodIndex: null }) } }, l)));
  const st = ctx.status === 'ok' ? statusBadge('ok', '検算OK') : ctx.status === 'warn' ? statusBadge('warn', '検算：確認事項あり') : statusBadge('ng', '検算：NGあり');
  return h('div', { class: 'page-head' },
    h('div', null, h('div', { class: 'crumb' }, page.step ? `手順${page.step}／6　${page.label}` : page.label), h('h1', null, ctx.period.label, ' ', h('span', { class: 'badge' }, `金額単位：${ctx.unit}`))),
    h('div', { class: 'tools' }, seg,
      h('select', { 'aria-label': '期間', on: { change: (e) => setUi({ periodIndex: Number(e.target.value) }) } }, ctx.periods.map((p, i) => h('option', { value: i, selected: i === ctx.periodIndex }, p.label))),
      h('a', { href: '#checks' }, st)));
}

function render() {
  const root = document.getElementById('app');
  const page = currentPage();
  if (render.lastPage && render.lastPage !== page.id) { closeCalc(); state.ui.menuOpen = false; }
  let ctx;
  try {
    ctx = compute();
  } catch (e) {
    // 計算できなくてもメニューとデータ管理は使えるようにする（データの書き出し・修正のため）
    const navE = h('nav', { class: 'sidebar' }, h('div', { class: 'nav-common' }, PAGES.map((p) => h('a', { href: `#${p.id}` }, p.label))));
    const body = h('main', null, h('div', { class: 'alert alert-err' }, `計算中にエラーが発生しました：${e.message}。「データの保存・変更履歴」でデータを書き出すか、サンプルデータに戻してください。`));
    if (page.id === 'data') { try { body.append(renderData({ data: state.data })); } catch (e2) { body.append(h('div', { class: 'alert alert-err' }, e2.message)); } }
    clear(root).append(header(), h('div', { class: 'layout' }, navE, body));
    console.error(e);
    return;
  }
  const main = h('main', { id: 'main' });
  const warns = [];
  if (!state.storageOk) warns.push(h('div', { class: 'alert alert-warn' }, 'この環境ではブラウザに保存できないため、変更は再読み込みで消えます。「データの保存・変更履歴」で保存ファイルに書き出してください。'));
  if (state.loadError) warns.push(h('div', { class: 'alert alert-err' }, state.loadError));
  if (state.loadWarnings.length) warns.push(h('div', { class: 'alert alert-warn' }, `保存データの読込時に自動で直しました：${state.loadWarnings.slice(0, 3).join('／')}${state.loadWarnings.length > 3 ? ` ほか${state.loadWarnings.length - 3}件` : ''}`));
  main.append(pageHead(page, ctx), ...warns);
  if (page.step) main.append(h('h2', { class: 'step-title' }, h('span', { class: 'nav-no' }, String(page.step)), page.label));
  else main.append(h('h2', { class: 'step-title' }, page.label));
  try {
    main.append(page.render(ctx));
  } catch (e) {
    main.append(h('div', { class: 'alert alert-err' }, `画面の表示中にエラーが発生しました：${e.message}`));
    console.error(e);
  }
  const panel = h('aside', { class: 'panel', id: 'calc-panel', 'aria-label': '計算の確認' });
  const scrollY = window.scrollY;
  clear(root).append(header(), h('div', { class: 'layout' }, sidebar(page, ctx), main, panel));
  mountPanel(panel);
  if (render.lastPage === page.id) window.scrollTo(0, scrollY);
  render.lastPage = page.id;
}

init();
document.documentElement.dataset.palette = state.ui.palette || 'bt';
subscribe(render);
// 保存していない変更があるときは、画面の切替えの前に確認する
let lastHash = location.hash;
let reverting = false;
window.addEventListener('hashchange', () => {
  if (reverting) { reverting = false; return; }
  const target = location.hash;
  if (state.dirty && target !== lastHash) {
    reverting = true;
    location.hash = lastHash;
    guard(() => { lastHash = target; location.hash = target; render(); });
    return;
  }
  lastHash = target;
  render();
});
window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
render();
