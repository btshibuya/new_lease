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

/** 金額セル（右寄せ、マイナスは△） */
export function amt(v, opts = {}) {
  return h('td', { class: `num${v < 0 ? ' neg' : ''}${opts.strong ? ' strong' : ''}` }, v === null || v === undefined ? '' : fmt(v));
}

/** 表を作る。cols: [{label, key|render, num}] */
export function table(cols, rows, opts = {}) {
  const thead = h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.num ? 'num' : '', scope: 'col', title: c.title }, c.label))));
  const tbody = h('tbody', null, rows.map((r) => h('tr', { class: opts.rowClass ? opts.rowClass(r) : '' }, cols.map((c) => {
    const v = c.render ? c.render(r) : r[c.key];
    if (v instanceof Node) return v.tagName === 'TD' ? v : h('td', { class: c.num ? 'num' : '' }, v);
    if (c.num) return amt(v);
    return h('td', null, v ?? '');
  }))));
  const tfoot = opts.foot ? h('tfoot', null, opts.foot) : null;
  return h('div', { class: 'table-wrap' }, h('table', { class: `tbl ${opts.className || ''}` }, opts.caption ? h('caption', null, opts.caption) : null, thead, tbody, tfoot));
}

/** 状態アイコン（色だけに頼らず、記号とラベルを併記） */
export function statusBadge(status, label) {
  const map = { ok: ['✓', 'OK'], warn: ['!', '警告'], ng: ['✕', 'NG'] };
  const [icon, text] = map[status] || ['?', status];
  return h('span', { class: `badge st-${status}`, role: 'status' }, h('span', { class: 'badge-icon', 'aria-hidden': 'true' }, icon), label || text);
}

export function card(title, ...children) {
  return h('section', { class: 'card' }, title ? h('h2', { class: 'card-title' }, title) : null, ...children);
}

export function field(label, input, help) {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, help ? h('div', { class: 'help' }, help) : null);
}

export function select(options, value, onChange) {
  return h('select', { on: { change: (e) => onChange(e.target.value) } }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
}

export function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

export function toast(msg, kind = 'info') {
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, msg);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
