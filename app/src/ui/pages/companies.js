import { h, card, toast, ask } from '../dom.js';
import { lineChart } from '../charts.js';
import { update, state, setUi } from '../store.js';
import { sanitizeCompany, validCode } from '../../engine/data.js';
import { deepClone, indexToJp, ymToIndex } from '../../engine/util.js';
import { DEEMED, OWN_KINDS, ownershipSteps, deemedMonthIdx, rateAt } from '../../engine/accounts.js';

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
    h('td', null, (c.ownership || []).length ? h('span', { class: 'muted small', title: '下の「持分比率の推移」から求めます' }, '持分比率の推移を使用') : inp(c, 'nciRatio', 'pct', { label: '非支配株主持分比率' })),
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
    ownershipCard(data),
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
    data.companies.some((c) => (c.ownership || []).length) ? h('div', { class: 'alert alert-warn' }, `持分比率の推移を入力している会社（${data.companies.filter((c) => (c.ownership || []).length).map((c) => c.code).join('、')}）は、この履歴の非支配株主持分比率を使いません（税率の履歴は使います）。`) : null,
    h('div', { class: 'alert alert-info' }, '税率改正の場合は「改正税法の成立日を含む決算期の期首年月」を入力します（繰延税金は決算日までに成立した税率で計算するため。施行日ではありません）。持分の追加取得・売却の場合は、持分が変動した月を入力します。その月から新しい率を使います。過去の期間は当時の率で再計算されるため、開始仕訳は前期末の確定額と一致します。税率変更の影響は当期の法人税等調整額（C-13）、持分比率の変動は資本剰余金（C-14、資本取引）で処理します。'),
    ...blocks);
}

const pctTxt = (v) => `${(v * 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** 持分比率の推移：異動日（取得・追加取得・一部売却）と異動後の親会社持分比率。みなし日の翌月から新しい比率で非支配株主に按分する */
function ownershipCard(data) {
  const draft = deepClone(data.companies.filter((c) => !c.isParent).map((c) => ({ code: c.code, name: c.name, fyeMonth: c.fyeMonth, ownership: c.ownership || [] })));
  const blocks = draft.map((c) => {
    const body = h('tbody');
    const summary = h('span', { class: 'muted small' });
    const draw = () => {
      const steps = ownershipSteps({ ownership: c.ownership.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date || '')), fyeMonth: c.fyeMonth });
      summary.textContent = steps.length ? `：${steps.map((x) => `${pctTxt(x.parent)}（非支配 ${pctTxt(x.nci)}、${indexToJp(x.fromIdx)}から）`).join(' → ')}` : '：未入力（会社マスタの非支配株主持分比率と履歴を使います）';
      body.replaceChildren(...c.ownership.map((x, i) => {
        const ok = /^\d{4}-\d{2}-\d{2}$/.test(x.date || '');
        const dm = ok ? deemedMonthIdx(x, c.fyeMonth) : null;
        const eff = h('td', { class: 'small nw' }, ok ? `${indexToJp(dm + 1)}から（みなし日 ${indexToJp(dm)}末）` : '異動日を入力');
        const re = () => draw();
        return h('tr', null,
          h('td', null, h('input', { type: 'date', value: x.date || '', 'aria-label': '異動日', on: { change: (e) => { x.date = e.target.value; re(); } } })),
          h('td', null, h('select', { 'aria-label': '異動の種類', on: { change: (e) => { x.kind = e.target.value; } } }, Object.entries(OWN_KINDS).map(([v, l]) => h('option', { value: v, selected: x.kind === v }, l)))),
          h('td', null, h('input', { type: 'number', step: 'any', min: 0, max: 100, value: +((x.ratio ?? 1) * 100).toFixed(4), 'aria-label': '異動後の親会社持分比率（％）', on: { change: (e) => { x.ratio = Number(e.target.value) / 100; re(); } } })),
          h('td', { class: 'num' }, pctTxt(1 - (x.ratio ?? 1))),
          h('td', null, h('select', { 'aria-label': 'みなし日', on: { change: (e) => { x.deemed = e.target.value; re(); } } }, Object.entries(DEEMED).map(([v, l]) => h('option', { value: v, selected: (x.deemed || 'nearest_month_end') === v }, l))),
            x.deemed === 'month' ? h('input', { type: 'month', value: x.effYm || '', 'aria-label': '適用開始月', on: { change: (e) => { x.effYm = e.target.value; re(); } } }) : null),
          eff,
          h('td', null, h('input', { type: 'text', value: x.memo || '', maxlength: 200, 'aria-label': '備考', on: { input: (e) => { x.memo = e.target.value; } } })),
          h('td', null, h('button', { class: 'btn-link danger', type: 'button', on: { click: () => { c.ownership.splice(i, 1); state.dirty = `持分比率の推移（${c.code}）`; draw(); } } }, '削除')));
      }));
    };
    draw();
    // 保存済みの推移のグラフ（月ごとの親会社持分比率・非支配株主持分比率。みなし日の翌月から変わる）
    const saved = data.companies.find((x) => x.code === c.code);
    let chart = null;
    if ((saved.ownership || []).length) {
      const st = ownershipSteps(saved);
      const from = st[0].fromIdx, to = st[st.length - 1].fromIdx + 12; // 支配獲得（最初の取得の適用開始月）から
      const months = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      const lab = (i) => `${String(Math.floor(i / 12)).slice(2)}/${(i % 12) + 1}`;
      chart = lineChart({ wide: true, height: 220, title: `${c.code} の持分比率の推移（％、月次）`, subtitle: `異動日とみなし日：${st.map((x) => `${x.rec.date}（${OWN_KINDS[x.rec.kind] || ''}）→ みなし日 ${indexToJp(x.deemedIdx)}末・${indexToJp(x.fromIdx)}から ${pctTxt(x.parent)}`).join('、')}`, labels: months.map(lab),
        series: [{ name: '親会社持分比率', values: months.map((m) => Math.round((1 - rateAt(saved, m, 'nciRatio')) * 1000) / 10), color: 'var(--s1)' }, { name: '非支配株主持分比率', values: months.map((m) => Math.round(rateAt(saved, m, 'nciRatio') * 1000) / 10), color: 'var(--s2)', dashed: true }], unit: '％' });
    }
    // 入力・追加・削除をしたら、保存せずに画面を移るときに確認する
    const dirty = () => { state.dirty = `持分比率の推移（${c.code}）`; };
    return h('details', { id: `own-${c.code}`, open: c.ownership.length > 0, on: { input: dirty, change: (e) => { if (e.target !== e.currentTarget) dirty(); } } }, h('summary', null, h('b', null, `${c.code} ${c.name}`), summary), chart,
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl compact form-table' }, h('thead', null, h('tr', null, ['異動日', '種類', '異動後の親会社持分比率（％）', '非支配株主持分比率', 'みなし日', '新しい比率を使う月', '備考', ''].map((t) => h('th', null, t)))), body)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', on: { click: () => { const last = c.ownership[c.ownership.length - 1]; c.ownership.push({ date: '', kind: c.ownership.length ? 'add' : 'acquire', ratio: last ? last.ratio : 1, deemed: 'nearest_month_end', memo: '' }); state.dirty = `持分比率の推移（${c.code}）`; draw(); } } }, '＋ 異動を追加'),
        h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => {
          if (c.ownership.some((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x.date || ''))) return toast('異動日を入力してください', 'error');
          if (c.ownership.some((x) => !(x.ratio >= 0 && x.ratio <= 1))) return toast('親会社持分比率は0〜100％で入力してください', 'error');
          if (new Set(c.ownership.map((x) => x.date)).size !== c.ownership.length) return toast('同じ異動日が重複しています', 'error');
          if (c.ownership.some((x) => x.deemed === 'month' && !/^\d{4}-\d{2}$/.test(x.effYm || ''))) return toast('みなし日を「適用開始月を指定」にした行は、適用開始月を入力してください', 'error');
          // 確定済みの期間の比率が変わる場合は確認する（変わると CHK-13 が NG になる）
          const orig = data.companies.find((x) => x.code === c.code);
          const next = sanitizeCompany({ ...orig, ownership: c.ownership });
          const firstDiff = (() => { for (let i = ymToIndex('2000-01'); i <= ymToIndex('2100-12'); i++) if (rateAt(orig, i, 'nciRatio') !== rateAt(next, i, 'nciRatio')) return i; return null; })();
          const hitLocks = firstDiff === null ? [] : (data.locks || []).filter((l) => ymToIndex(l.periodEnd) >= firstDiff);
          const doSave = () => {
            state.dirty = null;
            update((d) => { const t = d.companies.find((x) => x.code === c.code); t.ownership = next.ownership; }, '持分比率の推移の更新', `${c.code}：${c.ownership.map((x) => `${x.date} ${OWN_KINDS[x.kind] || ''} ${pctTxt(x.ratio)}（${DEEMED[x.deemed] || ''}）`).join('、') || 'なし'}`);
            toast('保存しました');
          };
          if (!hitLocks.length) return doSave();
          ask({ title: '確定済みの期間の持分比率が変わります', message: `${indexToJp(firstDiff)}以降の非支配株主持分比率が変わるため、確定済みの期間（${hitLocks.map((l) => l.label).join('、')}）の数値も変わります（検算 CHK-13 が NG になります）。保存しますか？`, okLabel: '保存する', danger: true }).then((ok) => { if (ok) doSave(); });
        } } }, '推移を保存')));
  });
  return card('持分比率の推移（取得・追加取得・一部売却）',
    h('div', { class: 'alert alert-info' }, '子会社株式の取得・追加取得・一部売却の日付と、異動後の親会社持分比率を入力します。非支配株主持分比率＝1−親会社持分比率です。取得日・売却日が子会社の決算日以外のときは、前後いずれかの決算日（四半期決算日を含む）に行われたものとみなして処理できます（連結財務諸表に関する会計基準 注5）。アプリは月次で計算するため、みなし日（月末）の翌月から新しい比率を使い、期中（年度・四半期・月次）に比率が変わった場合は、比率が同じ月ごとに非支配株主へ按分します。比率が変わった月の前月末の基礎額×比率の差は持分変動（資本剰余金）とします。'),
    ...blocks);
}
