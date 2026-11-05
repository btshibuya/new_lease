import { h, card, select, download, table, amt } from '../dom.js';
import { journalCard, kpi, emptyState } from '../components.js';
import { state } from '../store.js';
import { TEMPLATES } from '../../engine/elimination.js';
import { accountLabel, ACCOUNTS } from '../../engine/accounts.js';
import { toCsv } from '../../engine/data.js';
import { fmt } from '../../engine/util.js';

const filter = { kind: 'all', contract: 'all', tpl: 'all', account: '' };

export function renderJournals(ctx) {
  const { gen, pol, names, companies, period, data } = ctx;
  const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const js = gen.journals.filter((j) => (filter.kind === 'all' || j.kind === filter.kind) && (filter.contract === 'all' || j.contractId === filter.contract) && (filter.tpl === 'all' || j.tpl === filter.tpl));
  const pl = js.flatMap((j) => j.lines).filter((l) => ACCOUNTS[l.acc]?.type === 'PL' && !['TAX_ADJ', 'NCI_PL'].includes(l.acc)).reduce((a, l) => a - l.amt, 0);
  const tax = js.flatMap((j) => j.lines).filter((l) => l.acc === 'TAX_ADJ').reduce((a, l) => a + l.amt, 0);
  const dr = js.flatMap((j) => j.lines).filter((l) => l.amt > 0).reduce((a, l) => a + l.amt, 0);
  const cr = -js.flatMap((j) => j.lines).filter((l) => l.amt < 0).reduce((a, l) => a + l.amt, 0);
  const tpls = [...new Set(gen.journals.map((j) => j.tpl))];
  const controls = h('div', { class: 'filters' },
    h('label', null, '区分 ', select([['all', 'すべて'], ['IND', '個社修正'], ['CON', '連結修正']], filter.kind, (v) => { filter.kind = v; rerender(); })),
    h('label', null, '契約 ', select([['all', 'すべて'], ...data.contracts.map((c) => [c.id, `${c.id} ${c.name}`])], filter.contract, (v) => { filter.contract = v; rerender(); })),
    h('label', null, 'テンプレート ', select([['all', 'すべて'], ...tpls.map((t) => [t, `${t} ${TEMPLATES[t]?.title || ''}`])], filter.tpl, (v) => { filter.tpl = v; rerender(); })),
    h('button', { class: 'btn', type: 'button', on: { click: () => exportCsv(js, ctx) } }, '仕訳帳をCSV出力'));

  // T勘定
  const accLabels = [...new Set(js.flatMap((j) => j.lines.map((l) => accountLabel(l, pol, names))))].sort();
  const tSel = h('label', null, '科目 ', select([['', '— 科目を選択 —'], ...accLabels.map((a) => [a, a])], filter.account, (v) => { filter.account = v; rerender(); }));
  let tView = emptyState('科目を選ぶと、借方・貸方の明細をT勘定形式で表示します。');
  if (filter.account) {
    const items = js.flatMap((j) => j.lines.filter((l) => accountLabel(l, pol, names) === filter.account).map((l) => ({ j, l })));
    const d = items.filter((x) => x.l.amt > 0), c = items.filter((x) => x.l.amt < 0);
    const side = (arr, sign) => h('div', { class: 't-side' }, arr.map((x) => h('div', { class: 't-row' }, h('span', null, `${x.j.tpl} ${x.j.contractId}`), h('span', { class: 'num' }, fmt(sign * x.l.amt)))));
    const td = d.reduce((a, x) => a + x.l.amt, 0), tc = -c.reduce((a, x) => a + x.l.amt, 0);
    tView = h('div', { class: 't-account' },
      h('div', { class: 't-title' }, filter.account),
      h('div', { class: 't-body' }, h('div', null, h('div', { class: 't-head' }, '借方'), side(d, 1), h('div', { class: 't-total' }, `計 ${fmt(td)}`)), h('div', null, h('div', { class: 't-head' }, '貸方'), side(c, -1), h('div', { class: 't-total' }, `計 ${fmt(tc)}`))),
      h('div', { class: 't-net' }, `純額：${td >= tc ? '借方' : '貸方'} ${fmt(Math.abs(td - tc))}`));
  }

  return h('div', { class: 'page' },
    h('h1', null, `仕訳（${period.label}）`),
    h('div', { class: 'kpis' },
      kpi('仕訳本数', `${js.length} 本`, `個社修正 ${js.filter((j) => j.kind === 'IND').length}／連結修正 ${js.filter((j) => j.kind === 'CON').length}`),
      kpi('借方合計 ／ 貸方合計', `${fmt(dr)} ／ ${fmt(cr)}`, dr === cr ? '一致' : '不一致'),
      kpi('当期の損益への影響（税引前）', fmt(pl), '表示中の仕訳による連結利益の増減', { accent: 'diff' }),
      kpi('法人税等調整額', fmt(tax), '＋は税金費用の増加')),
    card(null, controls),
    card('T勘定ビュー', tSel, tView),
    js.length ? h('div', { class: 'journals' }, js.map((j) => journalCard(j, { pol, names, companies }))) : card(null, emptyState('該当する仕訳はありません')));
}

function exportCsv(js, ctx) {
  const { pol, names, companies, period } = ctx;
  const rows = [['期間', '仕訳ID', '区分', 'テンプレート', '摘要', '契約', '貸手', '借手', '貸借', '科目', '会社', '金額', '根拠']];
  for (const j of js) {
    for (const l of j.lines) {
      rows.push([period.label, j.id, j.kind === 'IND' ? '個社修正' : '連結修正', j.tpl, j.title, j.contractId, j.lessorCo, j.lesseeCo, l.amt > 0 ? '借方' : '貸方', accountLabel(l, pol, names), l.co === 'CONSOL' ? '連結' : l.co, Math.abs(l.amt), (l.bases || []).slice(0, 3).join(' / ')]);
    }
  }
  download(`仕訳帳_${period.label}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
}
