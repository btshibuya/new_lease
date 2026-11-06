// DOM ヘルパー。利用者入力は必ず textContent で挿入し、innerHTML は使わない（XSS対策）。
import { fmt } from '../engine/util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function apply(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k === 'dataset') for (const [p, val] of Object.entries(v)) el.dataset[p] = val;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'selected') el.selected = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** 「計算の確認」欄を開く処理（panel.js が登録する） */
let calcHook = null;
export function setCalcHook(fn) { calcHook = fn; }

/**
 * 押せる数値にする（押すと右の「計算の確認」欄に計算過程と出典を表示）
 * @param {HTMLElement} el 対象の要素（td なら vcell、文中なら v）
 * @param {() => object} infoFn 表示内容を返す関数（押したときに計算）
 */
export function calcable(el, infoFn) {
  if (!infoFn) return el;
  el.classList.add(el.tagName === 'TD' ? 'vcell' : 'v');
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.title = '押すと計算の確認を表示';
  const open = () => calcHook && calcHook(infoFn(), el);
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return el;
}

/** 金額セル（右寄せ、マイナスは△）。opts.calc を渡すと押せる数値になる */
export function amt(v, opts = {}) {
  const td = h('td', { class: `num${opts.strong ? ' strong' : ''}` }, v === null || v === undefined ? '' : fmt(v));
  if (opts.calc && v !== null && v !== undefined) calcable(td, opts.calc);
  return td;
}

/** 表を作る。cols: [{label, key|render, num, nowrap, calc(row) → 計算の確認の内容}] */
export function table(cols, rows, opts = {}) {
  const thead = h('thead', null, h('tr', null, cols.map((c) => h('th', { scope: 'col', title: c.title, class: c.nowrap ? 'nw' : '' }, c.label))));
  const tbody = h('tbody', null, rows.map((r) => h('tr', { class: opts.rowClass ? opts.rowClass(r) : '' }, cols.map((c) => {
    const v = c.render ? c.render(r) : r[c.key];
    if (v instanceof Node) return v.tagName === 'TD' ? v : h('td', { class: c.num ? 'num' : '' }, v);
    if (c.num) return amt(v, { calc: c.calc ? () => c.calc(r) : null });
    return h('td', { class: c.nowrap ? 'nw' : '' }, v ?? '');
  }))));
  const tfoot = opts.foot ? h('tfoot', null, opts.foot) : null;
  return h('div', { class: 'tbl-wrap' }, h('table', { class: `tbl ${opts.className || ''}` }, opts.caption ? h('caption', null, opts.caption) : null, thead, tbody, tfoot));
}

/** 状態のバッジ（色だけに頼らず、記号とラベルを併記）：OK＝緑、確認事項＝黄、NG＝赤 */
export function statusBadge(status, label) {
  const map = { ok: ['✓', 'OK', 'badge ok'], warn: ['!', '確認', 'badge caution'], ng: ['✕', 'NG', 'badge warn'] };
  const [icon, text, cls] = map[status] || ['?', status, 'badge'];
  return h('span', { class: cls, role: 'status' }, h('span', { 'aria-hidden': 'true' }, `${icon} `), label || text);
}

export function card(title, ...children) {
  return h('section', { class: 'card' }, title ? h('h2', { class: 'card-title' }, title) : null, ...children);
}

/**
 * 入力欄（form-grid の1行：ラベル＋入力欄＋出典のバッジ）
 * @param {string} src 出典（契約書・借手の帳簿・貸手の帳簿・既定値 など）
 */
export function field(label, input, help, src) {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return [
    h('label', { for: id, class: 'fg-label' }, label),
    h('div', { class: 'fg-input' }, h('div', { class: 'row' }, input, src ? h('span', { class: `src${src === '既定値' ? ' manual' : ''}` }, src) : null), help ? h('div', { class: 'small muted' }, help) : null),
  ];
}

export function select(options, value, onChange) {
  return h('select', { on: { change: (e) => onChange(e.target.value) } }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
}

/**
 * 画面内の確認ダイアログ（ブラウザの confirm/prompt が使えない環境でも動作する）。
 * @returns {Promise<true|string|null>} 実行＝true（入力ありの場合は入力文字列）、キャンセル＝null
 */
export function ask({ title, message = '', okLabel = '実行する', danger = false, input = null }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const ta = input ? h('textarea', { id: 'ask-input', rows: 3, maxlength: 300, placeholder: input, 'aria-label': input }) : null;
    const err = h('div', { class: 'ask-err', hidden: true }, '入力してください');
    let overlay;
    const close = (v) => { overlay.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
    const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', on: { click: () => {
      if (ta && !ta.value.trim()) { err.hidden = false; ta.focus(); return; }
      close(ta ? ta.value.trim() : true);
    } } }, okLabel);
    const cancel = h('button', { class: 'btn', type: 'button', on: { click: () => close(null) } }, 'キャンセル');
    const box = h('div', { class: 'modal ask', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ask-title' },
      h('div', { class: 'modal-head' }, h('b', { id: 'ask-title' }, title)), message ? h('p', { class: 'ask-msg' }, message) : null, ta, err, h('div', { class: 'row ask-actions' }, h('span', { class: 'spacer' }), cancel, ok));
    overlay = h('div', { class: 'modal-bg', on: { keydown: (e) => { if (e.key === 'Escape') close(null); }, click: (e) => { if (e.target === overlay) close(null); } } }, box);
    document.body.appendChild(overlay);
    (ta || ok).focus();
  });
}

/**
 * 書き出し：内容を画面に表示し、コピーまたはファイル保存を選べるようにする
 * （claude.ai 上の公開ページなど、ダウンロードが禁止された環境ではコピーを使う）。
 */
export function download(filename, content, type) {
  const prev = document.activeElement;
  const ta = h('textarea', { id: 'export-text', rows: 12, readonly: true, 'aria-label': filename, value: content.replace(/^\uFEFF/, '') });
  const note = h('div', { class: 'help' }, 'ファイルとして保存できない環境では「コピー」して、表計算ソフトやテキストエディタに貼り付けてください。');
  let overlay;
  const close = () => { overlay.remove(); if (prev && prev.focus) prev.focus(); };
  const copy = h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => {
    const done = () => toast('コピーしました');
    try {
      navigator.clipboard.writeText(ta.value).then(done, () => { ta.select(); toast('自動でコピーできないため、選択された文字を Ctrl+C（⌘C）でコピーしてください', 'error'); });
    } catch { ta.select(); toast('選択された文字を Ctrl+C（⌘C）でコピーしてください', 'error'); }
  } } }, 'コピー');
  const save = h('button', { class: 'btn', type: 'button', on: { click: () => {
    try {
      const url = URL.createObjectURL(new Blob([content], { type }));
      const a = h('a', { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
    } catch { toast('この環境ではファイルとして保存できません。コピーしてください', 'error'); }
  } } }, 'ファイルとして保存');
  const box = h('div', { class: 'modal ask wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'export-title' },
    h('div', { class: 'modal-head' }, h('b', { id: 'export-title' }, `書き出し：${filename}`)), note, ta,
    h('div', { class: 'row ask-actions' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', on: { click: close } }, '閉じる'), save, copy));
  overlay = h('div', { class: 'modal-bg', on: { keydown: (e) => { if (e.key === 'Escape') close(); } } }, box);
  document.body.appendChild(overlay);
  copy.focus();
}

export function toast(msg, kind = 'info') {
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, msg);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
