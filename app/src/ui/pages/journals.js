import { h, card, select, download, toast, ask } from '../dom.js';
import { journalCard, kpi, emptyState } from '../components.js';
import { update } from '../store.js';
import { TEMPLATES } from '../../engine/elimination.js';
import { accountLabel, ACCOUNTS } from '../../engine/accounts.js';
import { toCsv, sanitizeManual } from '../../engine/data.js';
import { fmt, indexToYm } from '../../engine/util.js';

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
    h('button', { class: 'btn', type: 'button', on: { click: () => exportCsv(js, ctx) } }, '仕訳帳を書き出す（表計算ソフト用 CSV）'));

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
    h('div', { class: 'kpi' },
      kpi('仕訳本数', `${js.length} 本`, `個社修正 ${js.filter((j) => j.kind === 'IND').length}／連結修正 ${js.filter((j) => j.kind === 'CON').length}`),
      kpi('借方合計 ／ 貸方合計', `${fmt(dr)} ／ ${fmt(cr)}`, dr === cr ? '一致' : '不一致'),
      kpi('当期の損益への影響（税引前）', fmt(pl), '表示中の仕訳による連結利益の増減', { accent: 'diff' }),
      kpi('法人税等調整額', fmt(tax), '＋は税金費用の増加')),
    card(null, controls),
    card('T勘定（科目ごとの借方・貸方の明細）', tSel, tView),
    manualCard(ctx),
    js.length ? h('div', { class: 'journals' }, js.map((j) => journalCard(j, { pol, names, companies }))) : card(null, emptyState('該当する仕訳はありません')));
}

/** 手入力仕訳（理由必須・監査ログ記録） */
function manualCard(ctx) {
  const { data, period, companies } = ctx;
  const draft = { title: '', contractId: '', kind: 'CON', carry: 'none', reason: '', evidence: '', lines: [{ acc: 'MANUAL_PL', label: '', co: 'CONSOL', dr: '', cr: '' }, { acc: 'MANUAL', label: '', co: 'CONSOL', dr: '', cr: '' }] };
  const accOpts = [['MANUAL_PL', '（科目名を入力：損益計算書）'], ['MANUAL', '（科目名を入力：貸借対照表）'], ...Object.entries(ACCOUNTS).filter(([k]) => k !== 'MANUAL' && k !== 'MANUAL_PL').map(([k, v]) => [k, `${v.name}（${v.type === 'PL' ? '損益' : '貸借'}）`])];
  const coOpts = [['CONSOL', '連結'], ...companies.map((c) => [c.code, `${c.code} ${c.name}`])];
  const body = h('tbody');
  const bal = h('span', { class: 'muted' });
  const recalc = () => {
    const d = draft.lines.reduce((a, l) => a + (Number(l.dr) || 0), 0), c = draft.lines.reduce((a, l) => a + (Number(l.cr) || 0), 0);
    bal.textContent = `借方 ${fmt(d)} ／ 貸方 ${fmt(c)} ${d === c && d > 0 ? '（一致）' : '（不一致）'}`;
  };
  const drawRows = () => {
    body.replaceChildren(...draft.lines.map((l, i) => h('tr', null,
      h('td', null, select(accOpts, l.acc, (v) => { l.acc = v; })),
      h('td', null, h('input', { type: 'text', maxlength: 60, value: l.label, placeholder: '手入力科目のときの科目名', 'aria-label': '科目名', on: { input: (e) => { l.label = e.target.value; } } })),
      h('td', null, select(coOpts, l.co, (v) => { l.co = v; })),
      h('td', null, h('input', { type: 'number', min: 0, step: 1, value: l.dr, 'aria-label': '借方', on: { input: (e) => { l.dr = e.target.value; recalc(); } } })),
      h('td', null, h('input', { type: 'number', min: 0, step: 1, value: l.cr, 'aria-label': '貸方', on: { input: (e) => { l.cr = e.target.value; recalc(); } } })),
      h('td', null, h('button', { class: 'btn-link danger', type: 'button', on: { click: () => { draft.lines.splice(i, 1); drawRows(); recalc(); } } }, '削除')))));
  };
  drawRows();
  recalc();
  const save = () => {
    const isFree = (a) => a === 'MANUAL' || a === 'MANUAL_PL';
    const lines = draft.lines.map((l) => ({ acc: l.acc, label: isFree(l.acc) ? l.label.trim() : '', co: l.co, amt: Math.round((Number(l.dr) || 0) - (Number(l.cr) || 0)) })).filter((l) => l.amt);
    const total = lines.reduce((a, l) => a + l.amt, 0);
    if (!draft.reason.trim()) return toast('理由は必須です', 'error');
    if (lines.length < 2 || total !== 0) return toast('借方と貸方の合計が一致していません', 'error');
    if (lines.some((l) => isFree(l.acc) && !l.label)) return toast('手入力科目の科目名を入力してください', 'error');
    const m = sanitizeManual({ id: `M-${Date.now()}`, periodStart: indexToYm(period.start), periodEnd: indexToYm(period.end), kind: draft.kind, carry: draft.carry, contractId: draft.contractId, title: draft.title || '手入力仕訳', reason: draft.reason, evidence: draft.evidence, createdAt: new Date().toISOString(), lines });
    update((d) => { d.manualJournals = [...(d.manualJournals || []), m]; }, '手入力仕訳追加', `${period.label} ${m.title}：${m.reason}`);
    toast('手入力仕訳を追加しました');
  };
  const existing = (data.manualJournals || []).filter((m) => m.periodStart >= indexToYm(period.start) && m.periodEnd <= indexToYm(period.end));
  return card('手入力仕訳（理由必須・監査ログに記録）',
    h('div', { class: 'alert alert-info' }, '自動作成の対象外の調整（棚卸資産に含まれる償却費、変動リース料・非リース構成部分、決算日差異の調整など）を入力します。選択中の期間に計上され、精算表・期間確定の対象になります。年度の表示には、その年度内の四半期に入力した仕訳も含まれます。手入力仕訳には税効果・非支配株主持分の按分は自動計算されないため、必要なら別の行で入力してください。'),
    existing.length ? h('ul', null, existing.map((m) => h('li', null, `${m.title}（${m.reason}）`, ' ', h('button', { class: 'btn-link danger', type: 'button', on: { click: async () => {
      const why = await ask({ title: `手入力仕訳「${m.title}」を削除しますか？`, message: '削除の理由は監査ログに記録されます。', input: '削除の理由（必須）', okLabel: '削除する', danger: true });
      if (!why) return;
      update((d) => { d.manualJournals = d.manualJournals.filter((x) => x.id !== m.id); }, '手入力仕訳削除', `${m.title}：${why.slice(0, 200)}`);
    } } }, '削除')))) : null,
    h('details', null, h('summary', null, '手入力仕訳を追加する'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', null, '摘要'), h('input', { type: 'text', maxlength: 100, on: { input: (e) => { draft.title = e.target.value; } } })),
        h('div', { class: 'field' }, h('label', null, '関連する契約（任意）'), select([['', '—'], ...data.contracts.map((c) => [c.id, `${c.id} ${c.name}`])], '', (v) => { draft.contractId = v; })),
        h('div', { class: 'field' }, h('label', null, '理由（必須）'), h('input', { type: 'text', maxlength: 1000, on: { input: (e) => { draft.reason = e.target.value; } } })),
        h('div', { class: 'field' }, h('label', null, '区分'), select([['CON', '連結修正'], ['IND', '個社修正']], 'CON', (v) => { draft.kind = v; })),
        h('div', { class: 'field' }, h('label', null, '翌期以降の扱い'), select([['none', '当期のみ（翌期は再計上しない）'], ['carry', '翌期以降も開始仕訳として引き継ぐ（損益は利益剰余金期首へ）']], 'none', (v) => { draft.carry = v; })),
        h('div', { class: 'field' }, h('label', null, '証憑・計算資料'), h('input', { type: 'text', maxlength: 300, on: { input: (e) => { draft.evidence = e.target.value; } } }))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl compact' }, h('thead', null, h('tr', null, ['科目', '科目名（手入力科目）', '会社', '借方', '貸方', ''].map((t) => h('th', null, t)))), body)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => { draft.lines.push({ acc: 'MANUAL', label: '', co: 'CONSOL', dr: '', cr: '' }); drawRows(); } } }, '＋ 行を追加'), bal,
        h('button', { class: 'btn btn-primary', type: 'button', on: { click: save } }, '保存'))));
}

function exportCsv(js, ctx) {
  const { pol, names, companies, period } = ctx;
  const rows = [['期間', '仕訳ID', '区分', 'テンプレート', '摘要', '契約', '貸手', '借手', '貸借', '科目キー', '科目', '会社', '金額', '根拠']];
  for (const j of js) {
    for (const l of j.lines) {
      rows.push([period.label, j.id, j.kind === 'IND' ? '個社修正' : '連結修正', j.tpl, j.title, j.contractId, j.lessorCo, j.lesseeCo, l.amt > 0 ? '借方' : '貸方', l.acc, accountLabel(l, pol, names), l.co === 'CONSOL' ? '連結' : l.co, Math.abs(l.amt), (l.bases || []).slice(0, 3).join(' / ')]);
    }
  }
  download(`仕訳帳_${period.label}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
}
