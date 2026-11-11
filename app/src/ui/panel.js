// 右の「計算の確認」欄（ビジネストラストのデザイン：design/DESIGN.md の panel）
// 数値を押すと開き、値・式・値を入れた式・内訳・ドリルダウン・出典を表示する。
// メニューを切り替えたとき・Esc・×で閉じる。「← 戻る」で直前の表示に戻る。
import { h, clear, setCalcHook, download } from './dom.js';
import { fmt } from '../engine/util.js';
import { toCsv } from '../engine/data.js';

const st = { el: null, stack: [], anchors: [] };

/**
 * 表示内容の形式
 * {
 *   context: '連結・2028年3月期',    // 小さく表示する文脈
 *   title: 'リース負債に係る利息費用（子会社S1）',     // 何の数値か
 *   value: 137 | '0.47%',              // 値
 *   formula: [{ label, value }|'＋'|'＝' ...],   // 式（部品は chip）
 *   expr: '4,580 × 3.000% ＝ 137',     // 値を入れた式
 *   breakdown: { title, cols:[{label,key,num}], rows:[...], total },   // 内訳（会社別・契約別など）
 *   drill: { title, rows:[{ label, value, expr, src, children:[...] }] },   // 計算過程のドリルダウン
 *   notes: ['...'],                    // 補足
 *   sources: [{ label, kind }]         // 出典（kind: journal / manual / carry）
 *   links: [{ label, go }]             // 関連する画面へのリンク（元帳・仕訳帳など）
 *   more: [{ label, desc, open }]      // さらに分解する（open() が次の段階の内容を返す。パンくずで戻れる）
 * }
 */
// 内訳の契約番号から契約へ移動する関数（app.js が設定。存在しない契約番号なら null を返す）
let contractLink = null;
export function setContractLink(fn) { contractLink = fn; }

export function mountPanel(el) {
  st.el = el;
  setCalcHook(openCalc);
  render();
}

export function openCalc(info, anchor) {
  if (!st.el) return;
  for (const a of st.anchors) a.classList.remove('hl-main');
  // 画面の数値を押したときは新しい経路を始める（「さらに分解する」は同じ経路に積む）
  if (anchor) { anchor.classList.add('hl-main'); st.anchors = [anchor]; st.stack = []; }
  if (info && info.fresh) st.stack = []; // 数値を押さずに開く場合も、新しい経路として開く
  st.stack.push(info);
  render();
  st.el.scrollTop = 0;
}

export function closeCalc() {
  for (const a of st.anchors) a.classList.remove('hl-main');
  st.anchors = [];
  st.stack = [];
  render();
}

export function isOpen() {
  return st.stack.length > 0;
}

const v = (x) => (typeof x === 'number' ? fmt(x) : x ?? '');

function drillRows(rows, depth = 0) {
  const out = [];
  for (const r of rows || []) {
    const kids = r.children && r.children.length ? r.children : null;
    const tr = h('tr', null,
      h('td', { style: { 'padding-left': `${6 + depth * 14}px` } }, h('span', { class: 'drill-tog' }, kids ? '▶' : '■'), r.label, r.src ? h('span', { class: `src ${r.srcKind || ''}` }, r.src) : null),
      h('td', { class: 'num' }, v(r.value)),
      h('td', { class: 'small muted' }, r.expr || ''));
    out.push(tr);
    if (kids) {
      const childTrs = drillRows(kids, depth + 1);
      childTrs.forEach((c) => { c.hidden = true; });
      const tog = tr.querySelector('.drill-tog');
      tog.setAttribute('role', 'button');
      tog.tabIndex = 0;
      const toggle = () => {
        const show = childTrs[0].hidden;
        childTrs.forEach((c) => { if (show || !c.dataset.deep) c.hidden = !show; });
        tog.textContent = show ? '▼' : '▶';
      };
      tog.addEventListener('click', toggle);
      tog.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggle(); });
      childTrs.forEach((c) => { if (depth > 0) c.dataset.deep = '1'; });
      out.push(...childTrs);
    }
  }
  return out;
}

function render() {
  const el = st.el;
  if (!el) return;
  clear(el);
  const info = st.stack[st.stack.length - 1];
  el.classList.toggle('open', !!info);
  if (!info) return;
  el.append(h('div', { class: 'panel-head' },
    h('b', null, '計算の確認'), h('span', { class: 'spacer' }),
    st.stack.length > 1 ? h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => { st.stack.pop(); render(); } } }, '← 戻る') : null,
    h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': '閉じる', on: { click: closeCalc } }, '×')));
  if (st.stack.length > 1) {
    el.append(h('nav', { class: 'calc-crumbs', 'aria-label': 'ドリルダウンの経路' }, st.stack.map((x, i) => {
      const last = i === st.stack.length - 1;
      const name = String(x.title || '').slice(0, 24);
      return h('span', null, i ? h('span', { class: 'crumb-sep' }, ' › ') : null,
        last ? h('b', null, name) : h('button', { class: 'btn-link', type: 'button', title: x.context || '', on: { click: () => { st.stack.length = i + 1; render(); } } }, name));
    })));
  }
  if (info.context) el.append(h('div', { class: 'small muted' }, info.context));
  el.append(h('div', { style: { 'font-weight': '700' } }, info.title || ''));
  el.append(h('div', { class: 'val' }, v(info.value)));
  if ((info.formula && info.formula.length) || info.expr) {
    el.append(h('div', { class: 'card soft calc-formula' },
      h('div', { class: 'small sub' }, '計算式'),
      info.formula && info.formula.length ? h('div', { class: 'calc-line' }, info.formula.map((f) => (typeof f === 'string' ? h('span', { class: 'calc-op' }, ` ${f} `) : h('span', { class: `chip${f.input ? ' input' : ''}`, title: f.note || '' }, `${f.label}：${v(f.value)}`)))) : null,
      info.expr ? h('div', { class: 'small calc-expr' }, '値を入れた式：', h('b', null, info.expr)) : null));
  }
  if (info.breakdown && info.breakdown.rows && info.breakdown.rows.length) {
    const b = info.breakdown;
    // 内訳は CSV で書き出して、表計算ソフトで検算できる
    const exportCsv = () => download(`計算の確認_${String(info.title || '内訳').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}.csv`, toCsv([[info.context || '', info.title || '', info.value ?? ''], [], b.cols.map((c) => c.label), ...b.rows.map((r) => b.cols.map((c) => r[c.key] ?? ''))]), 'text/csv;charset=utf-8');
    el.append(h('div', { class: 'row calc-bk-head' }, h('h3', null, b.title || '内訳'), h('span', { class: 'spacer' }), h('button', { class: 'btn btn-sm', type: 'button', title: '内訳を表計算ソフト用に書き出す', on: { click: exportCsv } }, 'CSV')),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl drill-tbl' },
        h('thead', null, h('tr', null, b.cols.map((c) => h('th', null, c.label)))),
        h('tbody', null, b.rows.map((r) => h('tr', { class: r.total ? 'total' : '' }, b.cols.map((c) => {
          const badge = c.badge && r[c.badge] ? h('span', { class: 'badge co-badge' }, r[c.badge]) : null;
          const text = c.num ? v(r[c.key]) : (r[c.key] === undefined || r[c.key] === null ? '' : r[c.key]);
          const go = c.key === 'contract' && !r.total && contractLink ? contractLink(String(r[c.key] ?? '')) : null;
          if (go) return h('td', null, badge, h('button', { class: 'btn-link contract-link', type: 'button', title: '契約の登録画面・月次レポートへ', on: { click: go } }, text));
          return h('td', { class: c.num ? 'num' : '' }, badge, text);
        })))))));
  }
  // さらに分解する（同じ欄の中で次の段階へ。パンくずで戻れる）
  if (info.more && info.more.length) {
    el.append(h('h3', null, 'さらに分解する'), h('div', { class: 'actions' }, info.more.map((m) => h('button', { class: 'btn btn-sm', type: 'button', title: m.desc || '', on: { click: () => { try { openCalc(m.open()); } catch (e) { openCalc({ title: m.label, value: '', notes: [`分解できませんでした：${e.message}`] }); } } } }, `${m.label} ›`))));
  }
  if (info.drill && info.drill.rows && info.drill.rows.length) {
    el.append(h('h3', null, info.drill.title || '計算過程のドリルダウン'),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl drill-tbl' },
        h('thead', null, h('tr', null, h('th', null, '項目'), h('th', null, '値'), h('th', null, '値を入れた式'))),
        h('tbody', null, drillRows(info.drill.rows)))));
  }
  if (info.notes && info.notes.length) el.append(h('ul', { class: 'small sub calc-notes' }, info.notes.map((n) => h('li', null, n))));
  if (info.sources && info.sources.length) {
    el.append(h('h3', null, '出典'), h('div', { class: 'row' }, info.sources.map((s) => h('span', { class: `src ${s.kind || ''}` }, s.label))));
  }
  // 関連する画面へのリンク（元帳・仕訳帳など）
  if (info.links && info.links.length) {
    el.append(h('h3', null, '関連する画面で見る'), h('div', { class: 'actions' }, info.links.map((x) => h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => { closeCalc(); x.go(); } } }, `${x.label} →`))));
  }
}

window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.stack.length && !document.querySelector('.modal-bg')) closeCalc(); });
