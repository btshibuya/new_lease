import { h, card, statusBadge, table, toast, ask } from '../dom.js';
import { kpi } from '../components.js';
import { state, update, lockPeriod, unlockPeriod, isLocked } from '../store.js';
import { snapshotNets } from '../../engine/checks.js';
import { chooseAndGo, goTo } from '../nav.js';
import { setReportUnit } from './contracts.js';
import { focusJournals } from './journals.js';

export function renderChecks(ctx) {
  const { checks, period, gen, status, names } = ctx;
  const n = (s) => checks.filter((c) => c.status === s).length;
  const locked = isLocked(period);
  const lockBox = card('期間の確定（締め）',
    h('div', { class: 'alert alert-info' }, '確定すると、この期間の仕訳（契約別・科目別の金額）を確定時の記録として保存します。以後、契約・会社マスタ・会計方針を変更して確定済み期間の数値が変わると、検算 CHK-13 が NG になります（過去の連結財務諸表との不一致を防ぐため）。NG が残る期間は確定できません。'),
    locked
      ? h('div', { class: 'actions' }, statusBadge('ok', `${period.label} は確定済み`),
        h('button', { class: 'btn btn-danger', type: 'button', on: { click: async () => {
          const reason = await ask({ title: `${period.label} の確定を解除しますか？`, message: '解除の理由は監査ログに記録されます。', input: '解除の理由（必須）', okLabel: '確定を解除する', danger: true });
          if (!reason) return;
          unlockPeriod(period, reason.slice(0, 300));
          toast('確定を解除しました');
        } } }, '確定を解除する'))
      : h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', disabled: status === 'ng', title: status === 'ng' ? 'NG の検算があるため確定できません' : '', on: { click: async () => {
          if (!(await ask({ title: `${period.label} を確定しますか？`, message: 'この期間の仕訳を確定時の記録として保存します。以後、確定済み期間の数値が変わる変更をすると検算 CHK-13 が NG になります。', okLabel: '確定する' }))) return;
          lockPeriod(period, snapshotNets(gen, state.policies, names), state.policies);
          toast(`${period.label} を確定しました`);
        } } }, `${period.label} を確定する`),
        status === 'ng' ? h('span', { class: 'muted' }, 'NG の検算を解消すると確定できます') : null),
    (state.data.locks || []).length ? table([{ label: '確定済み期間', key: 'label' }, { label: '確定日時', render: (l) => new Date(l.lockedAt).toLocaleString('ja-JP') }, { label: '契約・手入力仕訳の数', render: (l) => Object.keys(l.snapshot).length }], state.data.locks, { className: 'compact' }) : null,
    ...(state.data.locks || []).map((l) => h('details', null, h('summary', null, `${l.label} を確定したときの記録（契約別・表示科目別の金額）を見る`),
      table([{ label: '契約', key: 'cid' }, { label: '表示科目｜会社', key: 'k' }, { label: '金額（借方＋）', key: 'v', num: true }],
        Object.entries(l.snapshot).flatMap(([cid, v]) => Object.entries(v.nets || {}).map(([k, val]) => ({ cid, k, v: val }))), { className: 'compact' }))));

  const noteInput = (id) => {
    const ta = h('textarea', { rows: 2, maxlength: 2000, placeholder: '例）在庫回転期間が短く、期末在庫に含まれる差額は○千円と僅少なため調整しない（2028年4月 経理部 ○○）', value: (state.data.checkNotes || {})[id] || '' });
    return h('div', { class: 'note' }, h('div', { class: 'sub-title' }, '判断の記録（記録すると警告が解消され、監査ログに残ります）'), ta,
      h('button', { class: 'btn', type: 'button', on: { click: () => update((d) => { d.checkNotes = { ...(d.checkNotes || {}), [id]: ta.value.trim().slice(0, 2000) }; if (!d.checkNotes[id]) delete d.checkNotes[id]; }, '判断の記録', `${id}：${ta.value.trim().slice(0, 100)}`) } }, '記録する'));
  };

  return h('div', { class: 'page' },
    h('div', { class: 'kpi' },
      kpi('OK', `${n('ok')} 項目`, null, { accent: 'good' }),
      kpi('警告', `${n('warn')} 項目`, '内容を確認し判断を記録', { accent: 'warn' }),
      kpi('NG', `${n('ng')} 項目`, 'NGが残る期間は確定できません', { accent: 'crit' })),
    card(null, h('div', { class: 'alert alert-info' }, '各検算の「検証方法」は、その検算が仕訳の作成とどの程度独立しているかを示します。「別経路で計算」「別実装で再計算」「公式による再計算」は、仕訳とは異なる計算で期待値を作って比較するものです。自動テストでは、意図的に入れた28種類の誤り（税効果・非支配株主持分・償却・利息・条件変更・遡及測定・CF など）をすべて検出することを確認していますが、すべての誤りを検出できるわけではありません。特に、契約条件そのものの入力誤りや、借手・貸手の帳簿との差は「外部との突合」（CHK-10）でしか検出できません。「外部との突合」は個別帳簿の実績が入力されている場合のみ有効です。')),
    lockBox,
    ...checks.map((c) => h('section', { class: `card check st-border-${c.status}`, id: c.id },
      h('header', { class: 'check-head' }, statusBadge(c.status), h('h2', null, `${c.id} ${c.title}`), c.independence ? h('span', { class: 'badge' }, `検証方法：${c.independence}`) : null),
      h('p', null, c.detail),
      c.id === 'CHK-12' && c.rows.length ? noteInput('CHK-12') : null,
      c.rows.length ? h('details', { open: c.status === 'ng' }, h('summary', null, `明細（${c.rows.length}件）`),
        table([{ label: '判定', render: (r) => h('td', null, r.ok ? statusBadge('ok') : r.warn ? statusBadge('warn') : c.status === 'ok' ? statusBadge('ok') : statusBadge(c.status)) }, { label: '契約', render: (r) => (r.contract || !r.company ? contractCell(r.contract, ctx) : companyCell(r.company, ctx)) }, { label: '内容', key: 'message' }], c.rows, { className: 'compact' })) : null)));
}

/** 検算の明細の会社コードから、会社マスタ（持分比率の推移）へ */
function companyCell(code, ctx) {
  const c = ctx.data.companies.find((x) => x.code === code);
  if (!c) return h('td', { class: 'nw' }, code);
  return h('td', { class: 'nw' }, h('button', { class: 'btn-link', type: 'button', title: '会社マスタの持分比率の推移へ', on: { click: () => goTo({ page: 'companies', target: `own-${c.code}` }) } }, `会社 ${c.code}`));
}

/** 検算の明細の契約番号から、関連する画面（契約の登録・月次レポート・仕訳帳）へ */
function contractCell(id, ctx) {
  const c = ctx.data.contracts.find((x) => x.id === id);
  if (!c) return h('td', { class: 'nw' }, id ?? '');
  return h('td', { class: 'nw' }, h('button', { class: 'btn-link contract-link', type: 'button', title: '関連する画面へ', on: { click: () => chooseAndGo(`検算の明細：契約 ${c.id} ${c.name}`, [
    { title: `契約の登録：${c.id}`, desc: '契約（物件）の登録・編集画面', page: 'contracts', contractId: c.id, target: 'contract-editor' },
    { title: `返済・償却スケジュールと財務諸表への影響（月次）：${c.id}`, desc: '毎月の元本・利息・償却費・残高・イベント', go: () => { setReportUnit('month'); goTo({ page: 'contracts', contractId: c.id, target: 'contract-monthly' }); } },
    { title: `仕訳帳（契約 ${c.id} で絞り込み）`, desc: 'この契約の当期の仕訳', go: () => focusJournals({ contract: c.id }) },
    { title: `個別の帳簿残高（実績）との突合：${c.id}`, desc: '検算 CHK-10 の入力欄', page: 'contracts', contractId: c.id, label: undefined, target: 'actuals' },
  ]) } }, c.id));
}
