import { h, card, statusBadge, table, toast } from '../dom.js';
import { kpi } from '../components.js';
import { state, update, lockPeriod, unlockPeriod, isLocked } from '../store.js';
import { snapshotNets } from '../../engine/checks.js';

export function renderChecks(ctx) {
  const { checks, period, gen, status, names } = ctx;
  const n = (s) => checks.filter((c) => c.status === s).length;
  const locked = isLocked(period);
  const lockBox = card('期間の確定（締め）',
    h('p', { class: 'help' }, '確定すると、この期間の仕訳（契約別・科目別の金額）をスナップショットとして保存します。以後、契約・会社マスタ・会計方針を変更して確定済み期間の数値が変わると、検算 CHK-13 が NG になります（過去の連結財務諸表との不一致を防ぐため）。NG が残る期間は確定できません。'),
    locked
      ? h('div', { class: 'actions' }, statusBadge('ok', `${period.label} は確定済み`),
        h('button', { class: 'btn danger', type: 'button', on: { click: () => {
          const reason = prompt('確定を解除する理由を入力してください（監査ログに記録されます）');
          if (!reason || !reason.trim()) return toast('理由が未入力のため解除しませんでした', 'error');
          unlockPeriod(period, reason.trim().slice(0, 300));
          toast('確定を解除しました');
        } } }, '確定を解除する'))
      : h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', disabled: status === 'ng', title: status === 'ng' ? 'NG の検算があるため確定できません' : '', on: { click: () => {
          if (!confirm(`${period.label} を確定しますか？`)) return;
          lockPeriod(period, snapshotNets(gen, state.policies, names), state.policies);
          toast(`${period.label} を確定しました`);
        } } }, `${period.label} を確定する`),
        status === 'ng' ? h('span', { class: 'muted' }, 'NG の検算を解消すると確定できます') : null),
    (state.data.locks || []).length ? table([{ label: '確定済み期間', key: 'label' }, { label: '確定日時', render: (l) => new Date(l.lockedAt).toLocaleString('ja-JP') }, { label: '契約・手入力仕訳の数', render: (l) => Object.keys(l.snapshot).length }], state.data.locks, { className: 'compact' }) : null,
    ...(state.data.locks || []).map((l) => h('details', null, h('summary', null, `${l.label} の確定時の内容（契約別・表示科目別の金額）を見る`),
      table([{ label: '契約', key: 'cid' }, { label: '表示科目｜会社', key: 'k' }, { label: '金額（借方＋）', key: 'v', num: true }],
        Object.entries(l.snapshot).flatMap(([cid, v]) => Object.entries(v.nets || {}).map(([k, val]) => ({ cid, k, v: val }))), { className: 'compact' }))));

  const noteInput = (id) => {
    const ta = h('textarea', { rows: 2, maxlength: 2000, placeholder: '例）在庫回転期間が短く、期末在庫に含まれる差額は○千円と僅少なため調整しない（2028年4月 経理部 ○○）', value: (state.data.checkNotes || {})[id] || '' });
    return h('div', { class: 'note' }, h('div', { class: 'sub-title' }, '判断の記録（記録すると警告が解消され、監査ログに残ります）'), ta,
      h('button', { class: 'btn', type: 'button', on: { click: () => update((d) => { d.checkNotes = { ...(d.checkNotes || {}), [id]: ta.value.trim().slice(0, 2000) }; if (!d.checkNotes[id]) delete d.checkNotes[id]; }, '判断の記録', `${id}：${ta.value.trim().slice(0, 100)}`) } }, '記録する'));
  };

  return h('div', { class: 'page' },
    h('h1', null, `検算（${period.label}）`),
    h('div', { class: 'kpis' },
      kpi('OK', `${n('ok')} 項目`, null, { accent: 'good' }),
      kpi('警告', `${n('warn')} 項目`, '内容を確認し判断を記録', { accent: 'warn' }),
      kpi('NG', `${n('ng')} 項目`, 'NGが残る期間は確定できません', { accent: 'crit' })),
    card(null, h('p', { class: 'help' }, '各検算の「検証方法」は、その検算が仕訳の作成とどの程度独立しているかを示します。「別経路で計算」「別実装で再計算」「公式による再計算」は、仕訳とは異なる計算で期待値を作って比較するもので、エンジンに誤りがあれば NG になります（自動テストで、意図的に入れた22種類の誤りをすべて検出することを確認していますが、すべての誤りを検出できるわけではありません）。「外部との突合」は個別帳簿の実績が入力されている場合のみ有効です。')),
    lockBox,
    ...checks.map((c) => h('section', { class: `card check st-border-${c.status}` },
      h('header', { class: 'check-head' }, statusBadge(c.status), h('h2', null, `${c.id} ${c.title}`), c.independence ? h('span', { class: 'chip' }, `検証方法：${c.independence}`) : null),
      h('p', null, c.detail),
      c.id === 'CHK-12' && c.rows.length ? noteInput('CHK-12') : null,
      c.rows.length ? h('details', { open: c.status === 'ng' }, h('summary', null, `明細（${c.rows.length}件）`),
        table([{ label: '判定', render: (r) => h('td', null, r.ok ? statusBadge('ok') : r.warn ? statusBadge('warn') : c.status === 'ok' ? statusBadge('ok') : statusBadge(c.status)) }, { label: '契約', key: 'contract' }, { label: '内容', key: 'message' }], c.rows, { className: 'compact' })) : null)));
}
