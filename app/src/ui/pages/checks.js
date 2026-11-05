import { h, card, statusBadge, table } from '../dom.js';
import { kpi } from '../components.js';

export function renderChecks(ctx) {
  const { checks, period } = ctx;
  const n = (s) => checks.filter((c) => c.status === s).length;
  return h('div', { class: 'page' },
    h('h1', null, `検算（${period.label}）`),
    h('div', { class: 'kpis' },
      kpi('OK', `${n('ok')} 項目`, null, { accent: 'good' }),
      kpi('警告', `${n('warn')} 項目`, '内容を確認し判断を記録', { accent: 'warn' }),
      kpi('NG', `${n('ng')} 項目`, 'NGが残る期間は締めない', { accent: 'crit' })),
    card(null, h('p', { class: 'help' }, '各検算は、仕訳の作成とは別の計算経路で結果を確かめます（例：CHK-03 は損益の累計・残高の差・仕訳の純資産修正額の3経路の一致、CHK-05 は2つの仕訳作成方式の一致、CHK-07 は現在価値の逆順再計算）。')),
    ...checks.map((c) => h('section', { class: `card check st-border-${c.status}` },
      h('header', { class: 'check-head' }, statusBadge(c.status), h('h2', null, `${c.id} ${c.title}`)),
      h('p', null, c.detail),
      c.rows.length ? h('details', { open: c.status === 'ng' }, h('summary', null, `明細（${c.rows.length}件）`),
        table([{ label: '判定', render: (r) => h('td', null, r.ok ? statusBadge('ok') : r.warn ? statusBadge('warn') : c.status === 'ok' ? statusBadge('ok') : statusBadge(c.status)) }, { label: '契約', key: 'contract' }, { label: '内容', key: 'message' }], c.rows, { className: 'compact' })) : null)));
}
