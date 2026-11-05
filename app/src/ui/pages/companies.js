import { h, card, toast } from '../dom.js';
import { update } from '../store.js';
import { sanitizeCompany } from '../../engine/data.js';
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
    h('td', null, used.has(c.code) ? h('span', { class: 'muted' }, '使用中') : h('button', { class: 'btn-link danger', type: 'button', on: { click: () => update((d) => { d.companies = d.companies.filter((x) => x.code !== c.code); }, '会社削除', c.code) } }, '削除'))));
  const save = () => {
    const clean = draft.map(sanitizeCompany);
    const codes = clean.map((c) => c.code);
    if (codes.some((c) => !c)) return toast('会社コードは必須です', 'error');
    if (new Set(codes).size !== codes.length) return toast('会社コードが重複しています', 'error');
    if (clean.filter((c) => c.isParent).length !== 1) return toast('親会社を1社選んでください', 'error');
    const missing = [...used].filter((c) => !codes.includes(c));
    if (missing.length) return toast(`契約で使用中の会社コードは変更できません：${missing.join('、')}`, 'error');
    update((d) => { d.companies = clean; }, '会社マスタ更新', `${clean.length}社`);
    toast('保存しました');
  };
  return h('div', { class: 'page' },
    h('h1', null, '会社マスタ'),
    card(null,
      h('p', { class: 'help' }, '法定実効税率は税効果（POL-02）、非支配株主持分比率は非支配株主持分への按分（POL-01）に使います。「旧科目名」は個別で「リース資産／リース債務」の科目を使っている会社（個社修正 IND-01 で組替）、「流動区分なし」は個別でリース負債を流動・固定に区分していない会社（IND-02）です。'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl form-table' },
        h('thead', null, h('tr', null, ['会社コード', '会社名', '親会社', '決算月', '法定実効税率（％）', '非支配株主持分比率（％）', '個別で税効果を計上', '旧科目名を使用', '流動区分なし', ''].map((t) => h('th', null, t)))),
        h('tbody', null, rows))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', on: { click: () => update((d) => d.companies.push(sanitizeCompany({ code: `C${d.companies.length + 1}`, name: '新しい会社', fyeMonth: 3, taxRate: 0.3 })), '会社追加', '') } }, '＋ 会社を追加'),
        h('button', { class: 'btn primary', type: 'button', on: { click: save } }, '保存'))));
}
