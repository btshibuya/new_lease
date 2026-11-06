import { h, card, table, download, toast, statusBadge, ask } from '../dom.js';
import { state, exportJson, replaceData, resetSample, update, backups, readBackup } from '../store.js';
import { sanitizeData, verifyChain, appendLog } from '../../engine/data.js';
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
      if (!(await ask({ title: `会社 ${clean.companies.length} 社・契約 ${clean.contracts.length} 件を読み込みますか？`, message: `現在のデータを置き換えます（監査ログは残ります）。${warnings.length ? `\n\n読込時の自動修正：\n${warnings.slice(0, 5).join('\n')}` : ''}`, okLabel: '読み込む' }))) return;
      if (body.policies) {
        const np = sanitizePolicies(body.policies);
        const diff = Object.keys(np).filter((k) => np[k] !== state.policies[k]).map((k) => `${k}:${state.policies[k]}→${np[k]}`);
        state.policies = np;
        if (diff.length) appendLog(state.data.auditLog, '会計方針変更（取込）', diff.join('、'));
      }
      replaceData(clean, `${f.name}（会社${clean.companies.length}・契約${clean.contracts.length}）`);
      toast('読み込みました');
    } catch (err) {
      toast(`読み込めませんでした：${err.message}`, 'error');
    }
  } } });
  const chain = verifyChain(data.auditLog, data.auditAnchor);
  const names = { ...data.config.accountNames };
  const nameRows = Object.entries(ACCOUNTS).map(([k, v]) => ({ k, v }));
  return h('div', { class: 'page' },
    h('h1', null, 'データ管理・ログ'),
    card('保存と読込',
      h('p', { class: 'help' }, 'データはこのブラウザ内（localStorage）にのみ保存され、外部には送信されません。別の端末・担当者と共有する場合はJSONで書き出してください。読込時は項目を検証し、不正な値は既定値に置き換えます（上限5MB）。'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', on: { click: () => download(`newlease_${new Date().toISOString().slice(0, 10)}.json`, exportJson(), 'application/json') } }, 'JSONで書き出す'),
        h('label', { class: 'btn' }, 'JSONを読み込む', file),
        h('button', { class: 'btn danger', type: 'button', on: { click: async () => { if (await ask({ title: 'サンプルデータに戻しますか？', message: '現在の会社・契約・手入力仕訳・確定情報をサンプルデータに置き換えます（監査ログは残ります）。必要なら先に書き出してください。', okLabel: 'サンプルに戻す', danger: true })) resetSample(); } } }, 'サンプルデータに戻す'))),
    backups().length ? card('退避されたデータ',
      h('p', { class: 'help' }, '読込に失敗した保存データを退避しています。書き出して内容を確認してください。'),
      h('ul', null, backups().map((k) => h('li', null, k, ' ', h('button', { class: 'btn-link', type: 'button', on: { click: () => download(`${k}.json`, readBackup(k) || '', 'application/json') } }, '書き出す'))))) : null,
    card('科目名のカスタマイズ（ユーザー別設定）',
      h('p', { class: 'help' }, '共通部品の科目名を、利用会社の勘定科目名に置き換えられます。空欄は標準名を使います。区分ごとに変えたい場合は「キー.区分」（例：DEP_ROU.mfg、LEASE_INC.nonop、RECLASS_ASSET.building）でも指定できます（JSONで編集）。'),
      h('div', { class: 'table-wrap scroll-y' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, h('th', null, 'キー'), h('th', null, '標準の科目名'), h('th', null, '利用会社の科目名'))),
        h('tbody', null, nameRows.map((r) => h('tr', null, h('td', null, r.k), h('td', null, r.v.name), h('td', null, h('input', { type: 'text', maxlength: 60, value: names[r.k] || '', 'aria-label': r.v.name, on: { input: (e) => { if (e.target.value) names[r.k] = e.target.value; else delete names[r.k]; } } }))))))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => update((d) => { d.config.accountNames = Object.fromEntries(Object.entries(names).map(([k, v]) => [k, String(v).slice(0, 60)])); }, '科目名変更', `${Object.keys(names).length}件`) } }, '科目名を保存'))),
    card('監査ログ（変更履歴）',
      h('p', null, '検証：', chain.ok ? statusBadge('ok', `改ざんなし（${data.auditLog.length}件の連鎖ハッシュが一致）`) : statusBadge('ng', `${chain.index + 1}件目以降で不一致（ログが編集された可能性）`)),
      h('p', { class: 'help' }, '各記録は直前の記録のハッシュ値を含みます。途中の記録の書換え・削除は検知できますが、末尾の削除や全体の作り直しは検知できない簡易的な仕組みです（暗号学的な保証ではありません）。操作者名は記録しません（端末内で使う前提のため）。'),
      table([{ label: '日時', render: (e) => new Date(e.at).toLocaleString('ja-JP') }, { label: '操作', key: 'action' }, { label: '内容', key: 'detail' }, { label: 'ハッシュ', key: 'hash' }], [...data.auditLog].reverse().slice(0, 300), { className: 'compact' })),
    (data.importedLogs || []).length ? card('取込ファイルの監査ログ（別枠で保存）',
      table([{ label: '取込元', key: 'file' }, { label: '取込日時', render: (x) => new Date(x.at).toLocaleString('ja-JP') }, { label: '件数', render: (x) => x.log.length }, { label: '連鎖の検証', render: (x) => h('td', null, verifyChain(x.log, x.anchor).ok ? statusBadge('ok', '一致') : statusBadge('ng', '不一致')) }], data.importedLogs, { className: 'compact' })) : null);
}
