// 画面共通の部品
import { h, amt, statusBadge, calcable } from './dom.js';
import { accountLabel } from '../engine/accounts.js';
import { fmt, indexToJp } from '../engine/util.js';

export const COLORS = { lessee: 'var(--s1)', lessor: 'var(--s2)', diff: 'var(--s3)', s4: 'var(--s4)', s5: 'var(--s5)', s6: 'var(--s6)', s7: 'var(--s7)', s8: 'var(--s8)' };
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

/** 数値の見出し（.kpi の中の .k）。opts.calc を渡すと値を押して計算の確認を開ける */
export function kpi(label, value, sub, opts = {}) {
  const b = h('b', { class: opts.accent === 'crit' ? 'red' : '' }, value instanceof Node ? value : String(value));
  if (opts.calc) calcable(b, opts.calc);
  return h('div', { class: `k${opts.accent ? ` accent-${opts.accent}` : ''}` }, h('span', null, label), b, sub ? h('small', { class: 'k-sub' }, sub) : null);
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
  // 金額を押すと「計算の確認」：計算式（根拠）と、元になった月ごとの個別仕訳の取消・出典
  const info = (l) => () => {
    const label = accountLabel(l, pol, names);
    const months = (j.details || []).flatMap((d) => d.lines.filter((x) => x.acc === l.acc && x.co === l.co && (x.meta?.contractId || '') === (l.meta?.contractId || '')).map((x) => ({ d, x })));
    return {
      context: `${j.tpl} ${j.title}${j.contractId && j.contractId !== '—' ? `（${j.contractId}）` : ''}`,
      title: `${label}（${coName(l.co, companies)}）${l.amt > 0 ? '借方' : '貸方'}`,
      value: Math.abs(l.amt),
      notes: l.bases && l.bases.length ? l.bases.slice(0, 12) : [],
      breakdown: months.length ? { title: `月ごとの明細（${months.length}件：個別仕訳の取消）`, cols: [{ label: '年月', key: 'ym' }, { label: '内容', key: 'note' }, { label: '金額', key: 'amt', num: true }], rows: [...months.map(({ d, x }) => ({ ym: indexToJp(d.m), note: d.note, amt: Math.abs(x.amt) })), { ym: '合計', note: '', amt: months.reduce((a, { x }) => a + Math.abs(x.amt), 0), total: true }] } : null,
      sources: [
        ...(j.contractId && j.contractId !== '—' ? [{ label: `契約 ${j.contractId}` }] : []),
        { label: `仕訳 ${j.tpl}`, kind: 'journal' },
        ...(j.manual ? [{ label: '手入力', kind: 'manual' }] : []),
        ...(j.tpl === 'C-01' || j.tpl === 'C-01T' || j.tpl === 'C-01N' || j.tpl === 'M-01O' ? [{ label: '前期末からの繰越', kind: 'carry' }] : []),
      ],
    };
  };
  for (let i = 0; i < n; i++) {
    const d = dr[i], c = cr[i];
    rows.push(h('tr', null,
      h('td', null, d ? h('span', null, accountLabel(d, pol, names), h('span', { class: 'co' }, coName(d.co, companies))) : ''),
      d ? amt(d.amt, { calc: opts.noBasis ? null : info(d) }) : h('td'),
      h('td', null, c ? h('span', null, accountLabel(c, pol, names), h('span', { class: 'co' }, coName(c.co, companies))) : ''),
      c ? amt(-c.amt, { calc: opts.noBasis ? null : info(c) }) : h('td')));
  }
  const tot = dr.reduce((a, l) => a + l.amt, 0);
  const totC = -cr.reduce((a, l) => a + l.amt, 0);
  const balanced = tot === totC;
  const tbl = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl journal' },
    h('thead', null, h('tr', null, h('th', null, '借方科目'), h('th', null, '金額'), h('th', null, '貸方科目'), h('th', null, '金額'))),
    h('tbody', null, rows, h('tr', { class: 'total' }, h('td', null, '合計'), amt(tot), h('td', null, balanced ? statusBadge('ok', '貸借一致') : statusBadge('ng', '貸借不一致')), amt(totC)))));
  const basis = h('details', { class: 'basis' }, h('summary', null, 'この仕訳の根拠をすべて表示（金額を押すと右の「計算の確認」でも見られます）'),
    h('ul', { class: 'basis-list' }, j.lines.map((l) => h('li', null, h('strong', null, `${accountLabel(l, pol, names)}（${coName(l.co, companies)}）${l.amt > 0 ? '借方' : '貸方'} ${fmt(Math.abs(l.amt))}`), l.bases && l.bases.length ? h('ul', null, l.bases.slice(0, 6).map((b) => h('li', null, b)), l.bases.length > 6 ? h('li', null, `ほか ${l.bases.length - 6} 件`) : null) : null))),
    j.details && j.details.length ? h('div', null, h('div', { class: 'sub-title' }, `月次の明細（${j.details.length}件：個別仕訳の取消）`),
      h('div', { class: 'tbl-wrap scroll-y' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, h('th', null, '年月'), h('th', null, '内容'), h('th', null, '借方'), h('th', null, '貸方'))),
        h('tbody', null, j.details.map((d) => h('tr', null, h('td', null, indexToJp(d.m)), h('td', null, d.note),
          h('td', null, d.lines.filter((l) => l.amt > 0).map((l) => `${accountLabel(l, pol, names)} ${fmt(l.amt)}`).join('、')),
          h('td', null, d.lines.filter((l) => l.amt < 0).map((l) => `${accountLabel(l, pol, names)} ${fmt(-l.amt)}`).join('、')))))))) : null);
  return h('article', { class: `journal-card kind-${j.kind}` },
    h('header', null,
      h('span', { class: `tpl tpl-${j.kind}` }, j.tpl),
      h('span', { class: 'jt' }, j.title),
      opts.hideContract ? null : h('span', { class: 'jc' }, j.manual ? `手入力（理由：${j.reason}）` : `${j.contractId}：${coName(j.lessorCo, companies)} → ${coName(j.lesseeCo, companies)}`)),
    tbl, opts.noBasis ? null : basis);
}

export function emptyState(msg) {
  return h('div', { class: 'empty' }, msg);
}
