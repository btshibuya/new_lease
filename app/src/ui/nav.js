// 画面間の移動（仕訳 → 契約情報・スケジュール・税効果のプルーフ・会社マスタ・会計方針など）
import { h } from './dom.js';
import { setUi } from './store.js';
import { guard } from './app.js';

/**
 * 指定の画面へ移動し、項目・欄を目立たせる。
 * @param {{page:string, contractId?:string, label?:string, target?:string, company?:string, open?:boolean}} t
 *   label：編集画面の項目名（その入力欄にフォーカス）、target：要素のID（その欄へスクロール）、company：会社マスタの行
 */
export function goTo(t) {
  guard(() => {
    rememberReturn();
    if (t.contractId) setUi({ contractId: t.contractId });
    if (location.hash !== `#${t.page}`) location.hash = `#${t.page}`;
    else window.dispatchEvent(new HashChangeEvent('hashchange'));
    setTimeout(() => highlight(t), 180);
  });
}

function flash(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2400);
}

function highlight(t) {
  if (t.label) {
    const scope = t.page === 'contracts' ? document.getElementById('contract-editor') || document : document;
    const lab = [...scope.querySelectorAll('.fg-label, legend, th')].find((x) => x.textContent.trim() === t.label);
    if (lab) {
      const input = lab.htmlFor ? document.getElementById(lab.htmlFor) : null;
      flash(lab.closest('fieldset') && lab.tagName === 'LEGEND' ? lab.closest('fieldset') : lab);
      if (input) { flash(input.closest('.fg-input') || input); setTimeout(() => input.focus({ preventScroll: true }), 400); }
    }
  }
  if (t.target) {
    const el = document.getElementById(t.target);
    if (el) { if (el.tagName === 'DETAILS') el.open = true; flash(el); }
  }
  if (t.company) {
    const row = [...document.querySelectorAll('tbody tr')].find((tr) => [...tr.querySelectorAll('input')].some((i) => i.value === t.company));
    flash(row);
  }
}

/** 移動先が複数あるときは、候補を表示して選んでもらう。1つならそのまま移動する */
export function chooseAndGo(title, candidates) {
  if (!candidates.length) return;
  if (candidates.length === 1) { const c = candidates[0]; return c.go ? c.go() : goTo(c); }
  const prev = document.activeElement;
  let overlay;
  const close = () => { overlay.remove(); if (prev && prev.focus) prev.focus(); };
  const list = h('ul', { class: 'jump-list' }, candidates.map((c) => h('li', null,
    h('button', { class: 'btn jump-btn', type: 'button', on: { click: () => { close(); c.go ? c.go() : goTo(c); } } },
      h('b', null, c.title), c.desc ? h('span', { class: 'muted small' }, c.desc) : null))));
  const box = h('div', { class: 'modal ask', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'jump-title' },
    h('div', { class: 'modal-head' }, h('b', { id: 'jump-title' }, title)),
    h('p', { class: 'ask-msg' }, '移動先を選んでください。'), list,
    h('div', { class: 'row ask-actions' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', on: { click: close } }, '閉じる')));
  overlay = h('div', { class: 'modal-bg', on: { keydown: (e) => { if (e.key === 'Escape') close(); }, click: (e) => { if (e.target === overlay) close(); } } }, box);
  document.body.appendChild(overlay);
  list.querySelector('button')?.focus();
}

// ── 元の画面へ戻る：ジャンプする前の画面・スクロール位置を覚え、画面の左下に「戻る」ボタンを出す ──
const returns = [];
let restoreHook = null; // 画面ごとの状態（仕訳帳の絞り込みなど）を覚えて戻すための関数（journals.js が設定）
export function setRestoreHook(fn) { restoreHook = fn; }

/** いまの画面を「戻り先」として覚える（ジャンプの直前に呼ぶ） */
export function rememberReturn() {
  const title = document.querySelector('.step-title')?.textContent?.replace(/^\d+/, '').trim() || document.title;
  returns.push({ hash: location.hash || '#dashboard', y: window.scrollY, title, extra: restoreHook ? restoreHook.save() : null });
  if (returns.length > 10) returns.shift();
  drawReturn();
}

function drawReturn() {
  let box = document.getElementById('return-box');
  if (!returns.length) { if (box) box.remove(); return; }
  const last = returns[returns.length - 1];
  const btn = h('button', { class: 'btn btn-primary', type: 'button', title: 'ジャンプする前の画面・位置に戻ります', on: { click: () => goBack() } }, `← ${last.title} に戻る`);
  const close = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': '戻るボタンを閉じる', on: { click: () => { returns.length = 0; drawReturn(); } } }, '×');
  if (!box) { box = h('div', { id: 'return-box', class: 'return-box', role: 'navigation', 'aria-label': '元の画面へ戻る' }); document.body.appendChild(box); }
  box.replaceChildren(...[btn, returns.length > 1 ? h('span', { class: 'small muted' }, `（あと${returns.length - 1}つ前まで戻れます）`) : null, close].filter(Boolean));
}

function goBack() {
  const r = returns.pop();
  drawReturn();
  if (!r) return;
  guard(() => {
    if (r.extra && restoreHook) restoreHook.load(r.extra);
    if (location.hash !== r.hash) location.hash = r.hash;
    else window.dispatchEvent(new HashChangeEvent('hashchange'));
    setTimeout(() => window.scrollTo({ top: r.y, behavior: 'smooth' }), 200);
  });
}
