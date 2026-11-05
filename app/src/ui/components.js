// 画面共通の部品
import { h, amt, statusBadge } from './dom.js';
import { accountLabel } from '../engine/accounts.js';
import { fmt, indexToJp } from '../engine/util.js';

export const COLORS = { lessee: 'var(--s1)', lessor: 'var(--s2)', diff: 'var(--s3)', s4: 'var(--s4)', s5: 'var(--s5)', s6: 'var(--s6)', s7: 'var(--s7)', s8: 'var(--s8)' };
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

export function kpi(label, value, sub, opts = {}) {
  return h('div', { class: `kpi${opts.accent ? ` accent-${opts.accent}` : ''}` },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, value instanceof Node ? value : String(value)),
    sub ? h('div', { class: 'kpi-sub' }, sub) : null);
}

function coName(code, companies) {
  if (code === 'CONSOL') return '連結';
  return companies.find((c) => c.code === code)?.name || code;
}

/**
 * 仕訳カード：借方・貸方の2列表示＋根拠（計算式・月次明細）
 */
export function journalCard(j, ctx, opts = {}) {
  const { pol, names, companies } = ctx;
  const dr = j.lines.filter((l) => l.amt > 0);
  const cr = j.lines.filter((l) => l.amt < 0);
  const n = Math.max(dr.length, cr.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const d = dr[i], c = cr[i];
    rows.push(h('tr', null,
      h('td', null, d ? h('span', null, accountLabel(d, pol, names), h('span', { class: 'co' }, coName(d.co, companies))) : ''),
      d ? amt(d.amt) : h('td'),
      h('td', null, c ? h('span', null, accountLabel(c, pol, names), h('span', { class: 'co' }, coName(c.co, companies))) : ''),
      c ? amt(-c.amt) : h('td')));
  }
  const tot = dr.reduce((a, l) => a + l.amt, 0);
  const totC = -cr.reduce((a, l) => a + l.amt, 0);
  const balanced = tot === totC;
  const tbl = h('div', { class: 'table-wrap' }, h('table', { class: 'tbl journal' },
    h('thead', null, h('tr', null, h('th', null, '借方科目'), h('th', { class: 'num' }, '金額'), h('th', null, '貸方科目'), h('th', { class: 'num' }, '金額'))),
    h('tbody', null, rows),
    h('tfoot', null, h('tr', null, h('td', null, '合計'), amt(tot, { strong: true }), h('td', null, balanced ? statusBadge('ok', '貸借一致') : statusBadge('ng', '貸借不一致')), amt(totC, { strong: true })))));
  const basis = h('details', { class: 'basis' }, h('summary', null, '根拠を見る（計算式・元になった個別仕訳）'),
    h('ul', { class: 'basis-list' }, j.lines.map((l) => h('li', null, h('strong', null, `${accountLabel(l, pol, names)}（${coName(l.co, companies)}）${l.amt > 0 ? '借方' : '貸方'} ${fmt(Math.abs(l.amt))}`), l.bases && l.bases.length ? h('ul', null, l.bases.slice(0, 6).map((b) => h('li', null, b)), l.bases.length > 6 ? h('li', null, `ほか ${l.bases.length - 6} 件`) : null) : null))),
    j.details && j.details.length ? h('div', null, h('div', { class: 'sub-title' }, `月次の明細（${j.details.length}件：個別仕訳の取消）`),
      h('div', { class: 'table-wrap scroll-y' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, h('th', null, '年月'), h('th', null, '内容'), h('th', null, '借方'), h('th', null, '貸方'))),
        h('tbody', null, j.details.map((d) => h('tr', null, h('td', null, indexToJp(d.m)), h('td', null, d.note),
          h('td', null, d.lines.filter((l) => l.amt > 0).map((l) => `${accountLabel(l, pol, names)} ${fmt(l.amt)}`).join('、')),
          h('td', null, d.lines.filter((l) => l.amt < 0).map((l) => `${accountLabel(l, pol, names)} ${fmt(-l.amt)}`).join('、')))))))) : null);
  return h('article', { class: `journal-card kind-${j.kind}` },
    h('header', null,
      h('span', { class: `tpl tpl-${j.kind}` }, j.tpl),
      h('span', { class: 'jt' }, j.title),
      opts.hideContract ? null : h('span', { class: 'jc' }, `${j.contractId}：${coName(j.lessorCo, companies)} → ${coName(j.lesseeCo, companies)}`)),
    tbl, opts.noBasis ? null : basis);
}

export function emptyState(msg) {
  return h('div', { class: 'empty' }, msg);
}
