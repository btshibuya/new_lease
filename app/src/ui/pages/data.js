import { h, card, table, download, toast, statusBadge } from '../dom.js';
import { state, exportJson, replaceData, resetSample, update } from '../store.js';
import { sanitizeData, verifyChain } from '../../engine/data.js';
import { sanitizePolicies } from '../../engine/policies.js';
import { ACCOUNTS } from '../../engine/accounts.js';

const MAX_BYTES = 5 * 1024 * 1024;

export function renderData(ctx) {
  const { data } = ctx;
  const file = h('input', { type: 'file', accept: '.json,application/json', on: { change: async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > MAX_BYTES) return toast('ファイルが大きすぎます（上限5MB）', 'error');
    if (!/\.json$/i.test(f.name)) return toast('JSONファイルを選んでください', 'error');
    try {
      const raw = JSON.parse(await f.text());
      const body = raw && raw.format === 'newlease-consolidation' ? raw : { data: raw };
      const { data: clean, warnings } = sanitizeData(body.data);
      if (!confirm(`会社 ${clean.companies.length} 社・契約 ${clean.contracts.length} 件を読み込み、現在のデータを置き換えます。よろしいですか？${warnings.length ? `\n\n注意：\n${warnings.slice(0, 5).join('\n')}` : ''}`)) return;
      if (body.policies) state.policies = sanitizePolicies(body.policies);
      replaceData(clean, `${f.name}（会社${clean.companies.length}・契約${clean.contracts.length}）`);
      toast('読み込みました');
    } catch (err) {
      toast(`読み込めませんでした：${err.message}`, 'error');
    }
  } } });
  const chain = verifyChain(data.auditLog);
  const names = { ...data.config.accountNames };
  const nameRows = Object.entries(ACCOUNTS).map(([k, v]) => ({ k, v }));
  return h('div', { class: 'page' },
    h('h1', null, 'データ管理・ログ'),
    card('保存と読込',
      h('p', { class: 'help' }, 'データはこのブラウザ内（localStorage）にのみ保存され、外部には送信されません。別の端末・担当者と共有する場合はJSONで書き出してください。読込時は項目を検証し、不正な値は既定値に置き換えます（上限5MB）。'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', on: { click: () => download(`newlease_${new Date().toISOString().slice(0, 10)}.json`, exportJson(), 'application/json') } }, 'JSONで書き出す'),
        h('label', { class: 'btn' }, 'JSONを読み込む', file),
        h('button', { class: 'btn danger', type: 'button', on: { click: () => { if (confirm('現在のデータをサンプルデータに置き換えますか？（監査ログは残ります）')) resetSample(); } } }, 'サンプルデータに戻す'))),
    card('科目名のカスタマイズ（ユーザー別設定）',
      h('p', { class: 'help' }, '共通部品の科目名を、利用会社の勘定科目名に置き換えられます。空欄は標準名を使います。'),
      h('div', { class: 'table-wrap scroll-y' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, h('th', null, 'キー'), h('th', null, '標準の科目名'), h('th', null, '利用会社の科目名'))),
        h('tbody', null, nameRows.map((r) => h('tr', null, h('td', null, r.k), h('td', null, r.v.name), h('td', null, h('input', { type: 'text', maxlength: 60, value: names[r.k] || '', 'aria-label': r.v.name, on: { input: (e) => { if (e.target.value) names[r.k] = e.target.value; else delete names[r.k]; } } }))))))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => update((d) => { d.config.accountNames = Object.fromEntries(Object.entries(names).map(([k, v]) => [k, String(v).slice(0, 60)])); }, '科目名変更', `${Object.keys(names).length}件`) } }, '科目名を保存'))),
    card('監査ログ（変更履歴）',
      h('p', null, '検証：', chain.ok ? statusBadge('ok', `改ざんなし（${data.auditLog.length}件の連鎖ハッシュが一致）`) : statusBadge('ng', `${chain.index + 1}件目以降で不一致（ログが編集された可能性）`)),
      h('p', { class: 'help' }, '各記録は直前の記録のハッシュ値を含みます（簡易的な改ざん検知。暗号学的な保証ではありません）。'),
      table([{ label: '日時', render: (e) => new Date(e.at).toLocaleString('ja-JP') }, { label: '操作', key: 'action' }, { label: '内容', key: 'detail' }, { label: 'ハッシュ', key: 'hash' }], [...data.auditLog].reverse().slice(0, 300), { className: 'compact' })));
}
