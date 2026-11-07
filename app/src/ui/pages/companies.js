import { h, card, toast, ask } from '../dom.js';
import { update, state, setUi } from '../store.js';
import { sanitizeCompany, validCode } from '../../engine/data.js';
import { deepClone } from '../../engine/util.js';

export function renderCompanies(ctx) {
  const { data } = ctx;
  const draft = deepClone(data.companies);
  const used = new Set(data.contracts.flatMap((c) => [c.lessorCo, c.lesseeCo]));
  const inp = (o, k, type = 'text', opts = {}) => {
    if (type === 'checkbox') return h('input', { type, checked: opts.invert ? o[k] === false : !!o[k], 'aria-label': opts.label, on: { change: (e) => { o[k] = opts.invert ? !e.target.checked : e.target.checked; } } });
    if (type === 'pct') return h('input', { type: 'number', step: 'any', min: 0, max: 100, value: +(o[k] * 100).toFixed(4), 'aria-label': opts.label, on: { input: (e) => { o[k] = Number(e.target.value) / 100; } } });
    return h('input', { type, value: o[k] ?? '', maxlength: opts.max, min: opts.min, max: opts.maxv, 'aria-label': opts.label, on: { input: (e) => { o[k] = type === 'number' ? Number(e.target.value) : e.target.value; } } });
  };
  const rows = draft.map((c, i) => h('tr', null,
    h('td', null, inp(c, 'code', 'text', { max: 20, label: '会社コード' })),
    h('td', null, inp(c, 'name', 'text', { max: 100, label: '会社名' })),
    h('td', null, h('input', { type: 'radio', name: 'parent', checked: c.isParent, 'aria-label': '親会社', on: { change: () => draft.forEach((x, k) => { x.isParent = k === i; }) } })),
    h('td', null, inp(c, 'fyeMonth', 'number', { min: 1, maxv: 12, label: '決算月' })),
    h('td', null, inp(c, 'taxRate', 'pct', { label: '法定実効税率' })),
    h('td', null, inp(c, 'nciRatio', 'pct', { label: '非支配株主持分比率' })),
    h('td', null, inp(c, 'taxEffect', 'checkbox', { label: '個別で税効果を計上' })),
    h('td', null, inp(c, 'legacyAccounts', 'checkbox', { label: '旧科目名' })),
    h('td', null, inp(c, 'splitsCurrent', 'checkbox', { invert: true, label: '流動区分なし' })),
    h('td', null, inp(c, 'dtaRatio', 'pct', { label: '繰延税金資産の計上割合' })),
    h('td', null, h('select', { 'aria-label': '適用初年度の方法', on: { change: (e) => { c.adoption = { ...(c.adoption || {}), method: e.target.value }; } } },
      [['cumulative', '累積的影響方式'], ['retrospective', '完全遡及'], ['applied', '適用済み（IFRS・US GAAP等）']].map(([v, l]) => h('option', { value: v, selected: (c.adoption?.method || 'cumulative') === v }, l))),
      h('input', { type: 'month', value: c.adoption?.ym || '2027-04', 'aria-label': '適用開始年月', on: { input: (e) => { c.adoption = { ...(c.adoption || {}), ym: e.target.value }; } } })),
    h('td', null, used.has(c.code) ? h('span', { class: 'muted' }, '使用中') : h('button', { class: 'btn btn-sm btn-danger', type: 'button', on: { click: async () => { if (await ask({ title: `会社 ${c.code} を削除しますか？`, message: c.name, okLabel: '削除する', danger: true })) { state.dirty = null; update((d) => { d.companies = d.companies.filter((x) => x.code !== c.code); }, '会社削除', c.code); } } } }, '削除'))));
  const dirtyMark = h('span', { class: state.dirty ? 'dirty' : 'muted' }, state.dirty ? '保存していない変更があります' : '保存済み');
  function markDirty() { state.dirty = '会社マスタ'; dirtyMark.className = 'dirty'; dirtyMark.textContent = '保存していない変更があります'; }
  const save = async () => {
    const clean = draft.map(sanitizeCompany);
    const codes = clean.map((c) => c.code);
    if (codes.some((c) => !validCode(c))) return toast('会社コードは英数字・_・- の1〜20文字で入力してください（予約語は不可）', 'error');
    if (new Set(codes).size !== codes.length) return toast('会社コードが重複しています', 'error');
    if (clean.filter((c) => c.isParent).length !== 1) return toast('親会社を1社選んでください', 'error');
    const missing = [...used].filter((c) => !codes.includes(c));
    if (missing.length) return toast(`契約で使用中の会社コードは変更できません：${missing.join('、')}`, 'error');
    // 使用中の会社の基準税率・持分比率を変えると、履歴のない過去期間も遡って変わる
    const changed = clean.filter((c) => { const o = data.companies.find((x) => x.code === c.code); return o && used.has(c.code) && (o.taxRate !== c.taxRate || o.nciRatio !== c.nciRatio); });
    if (changed.length && !(await ask({ title: '基準税率・持分比率を変更しますか？', message: `${changed.map((c) => c.code).join('、')} の基準値を変更すると、履歴のない過去の期間も遡って再計算されます（確定済み期間は CHK-13 が NG になります）。\n税率改正や持分の変動であれば、下の「履歴」に適用開始年月つきで追加してください。`, okLabel: '基準値を変更する', danger: true }))) return;
    state.dirty = null;
    update((d) => { d.companies = clean; }, '会社マスタ更新', `${clean.length}社`);
    toast('保存しました');
  };
  return h('div', { class: 'page' },
    card(null,
      h('div', { class: 'alert alert-info' }, '法定実効税率は税効果（POL-02）、非支配株主持分比率は非支配株主持分への按分（POL-01）に使います。「繰延税金資産の計上割合」は、回収可能性により個別で繰延税金資産を一部しか計上していない場合に設定します（取消額に反映）。「適用初年度」は、適用開始前に開始した契約の借手の測定に使います（累積的影響方式：適用開始時の残高から測定、完全遡及：リース開始時から測定）。「旧科目名」は個別で「リース資産／リース債務」の科目を使っている会社（個社修正 IND-01 で組替）、「流動区分なし」は個別でリース負債を流動・固定に区分していない会社（IND-02）です。'),
      h('div', { class: 'tbl-wrap', on: { input: markDirty, change: markDirty } }, h('table', { class: 'tbl form-table' },
        h('thead', null, h('tr', null, ['会社コード', '会社名', '親会社', '決算月', '法定実効税率（％）', '非支配株主持分比率（％）', '個別で税効果を計上', '旧科目名を使用', '流動区分なし', '繰延税金資産の計上割合（％）', '新リース会計基準の適用初年度（方法・期首）', ''].map((t) => h('th', null, t)))),
        h('tbody', null, rows))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', on: { click: () => { state.dirty = null; update((d) => d.companies.push(sanitizeCompany({ code: `C${d.companies.length + 1}`, name: '新しい会社', fyeMonth: 3, taxRate: 0.3, adoption: { method: 'cumulative', ym: '2027-04' } })), '会社追加', ''); } } }, '＋ 会社を追加'))),
    historyCard(data),
    h('div', { class: 'save-bar' },
      h('button', { class: 'btn btn-primary', type: 'button', on: { click: save } }, '保存して再計算'),
      h('button', { class: 'btn', type: 'button', on: { click: () => { state.dirty = null; setUi({}); toast('変更を破棄しました'); } } }, '変更を破棄'),
      h('a', { class: 'btn', href: '#policies' }, '次へ：会計方針を選ぶ →'),
      dirtyMark));
}

/** 税率・非支配株主持分比率の履歴（適用開始年月つき） */
function historyCard(data) {
  const draft = deepClone(data.companies.map((c) => ({ code: c.code, name: c.name, base: { taxRate: c.taxRate, nciRatio: c.nciRatio }, history: c.history || [] })));
  const blocks = draft.map((c) => {
    const body = h('tbody');
    const draw = () => body.replaceChildren(
      h('tr', null, h('td', null, '（基準値）'), h('td', null, `${(c.base.taxRate * 100).toFixed(2)}%`), h('td', null, `${(c.base.nciRatio * 100).toFixed(2)}%`), h('td', { class: 'muted' }, '上の会社マスタで変更')),
      ...c.history.map((x, i) => h('tr', null,
        h('td', null, h('input', { type: 'month', value: x.fromYm, 'aria-label': '適用開始年月', on: { input: (e) => { x.fromYm = e.target.value; } } })),
        h('td', null, h('input', { type: 'number', step: 'any', value: +(x.taxRate * 100).toFixed(4), 'aria-label': '税率', on: { input: (e) => { x.taxRate = Number(e.target.value) / 100; } } })),
        h('td', null, h('input', { type: 'number', step: 'any', value: +(x.nciRatio * 100).toFixed(4), 'aria-label': '非支配株主持分比率', on: { input: (e) => { x.nciRatio = Number(e.target.value) / 100; } } })),
        h('td', null, h('button', { class: 'btn-link danger', type: 'button', on: { click: () => { c.history.splice(i, 1); draw(); } } }, '削除')))));
    draw();
    return h('details', null, h('summary', null, `${c.code} ${c.name}（変更 ${c.history.length}件）`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl compact' }, h('thead', null, h('tr', null, ['適用開始年月（税率は成立日を含む期の期首／持分は変動月）', '法定実効税率（％）', '非支配株主持分比率（％）', ''].map((t) => h('th', null, t)))), body)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', on: { click: () => { c.history.push({ fromYm: '2028-04', taxRate: c.base.taxRate, nciRatio: c.base.nciRatio }); draw(); } } }, '＋ 変更を追加'),
        h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => {
          if (c.history.some((x) => !/^\d{4}-\d{2}$/.test(x.fromYm || ''))) return toast('適用開始年月を入力してください', 'error');
          if (new Set(c.history.map((x) => x.fromYm)).size !== c.history.length) return toast('同じ適用開始年月が重複しています', 'error');
          update((d) => { const t = d.companies.find((x) => x.code === c.code); t.history = sanitizeCompany({ ...t, history: c.history }).history; }, '税率・持分比率の履歴更新', `${c.code}：${c.history.map((x) => `${x.fromYm} 税率${(x.taxRate * 100).toFixed(2)}% 持分${(x.nciRatio * 100).toFixed(2)}%`).join('、') || 'なし'}`);
          toast('保存しました');
        } } }, '履歴を保存')));
  });
  return card('税率・非支配株主持分比率の履歴（期別）',
    h('div', { class: 'alert alert-info' }, '税率改正の場合は「改正税法の成立日を含む決算期の期首年月」を入力します（繰延税金は決算日までに成立した税率で計算するため。施行日ではありません）。持分の追加取得・売却の場合は、持分が変動した月を入力します。その月から新しい率を使います。過去の期間は当時の率で再計算されるため、開始仕訳は前期末の確定額と一致します。税率変更の影響は当期の法人税等調整額（C-13）、持分比率の変動は資本剰余金（C-14、資本取引）で処理します。'),
    ...blocks);
}
