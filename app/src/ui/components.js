// 画面共通の部品
import { h, amt, statusBadge, calcable } from './dom.js';
import { accountLabel } from '../engine/accounts.js';
import { fmt, indexToJp } from '../engine/util.js';
import { TEMPLATES } from '../engine/elimination.js';

export const COLORS = { lessee: 'var(--s1)', lessor: 'var(--s2)', diff: 'var(--s3)', s4: 'var(--s4)', s5: 'var(--s5)', s6: 'var(--s6)', s7: 'var(--s7)', s8: 'var(--s8)' };
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

/** 数値の見出し（.kpi の中の .k）。opts.calc を渡すと値を押して計算の確認を開ける */
export function kpi(label, value, sub, opts = {}) {
  const b = h('b', { class: opts.accent === 'crit' ? 'red' : '' }, value instanceof Node ? value : String(value));
  if (opts.calc) calcable(b, opts.calc);
  return h('div', { class: `k${opts.accent ? ` accent-${opts.accent}` : ''}` }, h('span', null, label), b, sub ? h('small', { class: 'k-sub' }, sub) : null);
}

function coName(code, companies) {
  if (code === 'CONSOL') return '連結';
  return companies.find((c) => c.code === code)?.name || code;
}

/**
 * 仕訳カード：借方・貸方の2列表示＋根拠（計算式・月次明細）
 */
export function journalCard(j, ctx, opts = {}) {
  const { pol, names, companies } = ctx;
  const dr = j.lines.filter((l) => l.amt > 0);
  const cr = j.lines.filter((l) => l.amt < 0);
  const n = Math.max(dr.length, cr.length);
  const rows = [];
  // 金額を押すと「計算の確認」：計算式（根拠）と、元になった月ごとの個別仕訳の取消・出典
  const info = (l) => () => {
    const label = accountLabel(l, pol, names);
    if (j.parts) {
      // 合算した仕訳：会社（貸手→借手）・契約ごとの内訳
      const rows = j.parts.map((p) => ({ contract: p.manual ? `手入力 ${p.id}` : p.contractId, pair: pairLabel(p, companies), amt: p.lines.filter((x) => accountLabel(x, pol, names) === label && x.co === l.co).reduce((a, x) => a + x.amt, 0) })).filter((x) => x.amt);
      const bases = [...new Set(j.parts.flatMap((p) => p.lines.filter((x) => accountLabel(x, pol, names) === label && x.co === l.co).flatMap((x) => x.bases || [])))];
      return {
        context: `${contentName(j)}（${j.groupLabel}）`,
        title: `${label}（${coName(l.co, companies)}）${l.amt > 0 ? '借方' : '貸方'}`,
        value: Math.abs(l.amt),
        breakdown: { title: `会社・契約ごとの内訳（${rows.length}件）`, cols: [{ label: '会社（貸手→借手）', key: 'pair' }, { label: '契約', key: 'contract' }, { label: '金額', key: 'amt', num: true }], rows: [...rows.map((x) => ({ ...x, amt: Math.abs(x.amt) })), { pair: '合計', contract: '', amt: Math.abs(l.amt), total: true }] },
        notes: bases.slice(0, 8).concat(bases.length > 8 ? [`ほか ${bases.length - 8} 件の根拠`] : []),
        sources: [{ label: `仕訳 ${j.tpl}${j.src ? `（${j.src}）` : ''}`, kind: 'journal' }, ...(String(j.tpl).startsWith('C-01') && j.tpl !== 'C-01R' ? [{ label: '前期末からの繰越', kind: 'carry' }] : [])],
        links: opts.links ? opts.links(l, j) : [],
      };
    }
    const months = (j.details || []).flatMap((d) => d.lines.filter((x) => x.acc === l.acc && x.co === l.co && (x.meta?.contractId || '') === (l.meta?.contractId || '')).map((x) => ({ d, x })));
    return {
      context: `${j.tpl} ${j.title}${j.contractId && j.contractId !== '—' ? `（${j.contractId}）` : ''}`,
      title: `${label}（${coName(l.co, companies)}）${l.amt > 0 ? '借方' : '貸方'}`,
      value: Math.abs(l.amt),
      notes: l.bases && l.bases.length ? l.bases.slice(0, 12) : [],
      breakdown: months.length ? { title: `月ごとの明細（${months.length}件：個別仕訳の取消）`, cols: [{ label: '年月', key: 'ym' }, { label: '内容', key: 'note' }, { label: '金額', key: 'amt', num: true }], rows: [...months.map(({ d, x }) => ({ ym: indexToJp(d.m), note: d.note, amt: Math.abs(x.amt) })), { ym: '合計', note: '', amt: months.reduce((a, { x }) => a + Math.abs(x.amt), 0), total: true }] } : null,
      sources: [
        ...(j.contractId && j.contractId !== '—' ? [{ label: `契約 ${j.contractId}` }] : []),
        { label: `仕訳 ${j.tpl}`, kind: 'journal' },
        ...(j.manual ? [{ label: '手入力', kind: 'manual' }] : []),
        ...(j.tpl === 'C-01' || j.tpl === 'C-01T' || j.tpl === 'C-01N' || j.tpl === 'M-01O' ? [{ label: '前期末からの繰越', kind: 'carry' }] : []),
      ],
      links: opts.links ? opts.links(l, j) : [],
    };
  };
  for (let i = 0; i < n; i++) {
    const d = dr[i], c = cr[i];
    rows.push(h('tr', null,
      h('td', null, d ? h('span', null, accountLabel(d, pol, names), h('span', { class: 'co' }, coName(d.co, companies))) : ''),
      d ? amt(d.amt, { calc: opts.noBasis ? null : info(d) }) : h('td'),
      h('td', null, c ? h('span', null, accountLabel(c, pol, names), h('span', { class: 'co' }, coName(c.co, companies))) : ''),
      c ? amt(-c.amt, { calc: opts.noBasis ? null : info(c) }) : h('td')));
  }
  const tot = dr.reduce((a, l) => a + l.amt, 0);
  const totC = -cr.reduce((a, l) => a + l.amt, 0);
  const balanced = tot === totC;
  const tbl = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl journal' },
    h('thead', null, h('tr', null, h('th', null, '借方科目'), h('th', null, '金額'), h('th', null, '貸方科目'), h('th', null, '金額'))),
    h('tbody', null, rows, h('tr', { class: 'total' }, h('td', null, '合計'), amt(tot), h('td', null, balanced ? statusBadge('ok', '貸借一致') : statusBadge('ng', '貸借不一致')), amt(totC)))));
  // スマホ用：1行に1科目（科目｜借方｜貸方）。会社は会社コードで短く表示する
  const mRows = [...dr, ...cr].map((l) => h('tr', null,
    h('td', null, accountLabel(l, pol, names), h('span', { class: 'co' }, l.co === 'CONSOL' ? '連結' : l.co)),
    l.amt > 0 ? amt(l.amt, { calc: opts.noBasis ? null : info(l) }) : h('td'),
    l.amt < 0 ? amt(-l.amt, { calc: opts.noBasis ? null : info(l) }) : h('td')));
  const tblM = h('div', { class: 'tbl-wrap journal-m-wrap' }, h('table', { class: 'tbl journal-m' },
    h('thead', null, h('tr', null, h('th', null, '科目（会社）'), h('th', null, '借方'), h('th', null, '貸方'))),
    h('tbody', null, mRows, h('tr', { class: 'total' }, h('td', null, balanced ? '合計（貸借一致）' : '合計（貸借不一致）'), amt(tot), amt(totC)))));
  const basis = h('details', { class: 'basis' }, h('summary', null, 'この仕訳の根拠をすべて表示（金額を押すと右の「計算の確認」でも見られます）'),
    h('ul', { class: 'basis-list' }, j.lines.map((l) => h('li', null, h('strong', null, `${accountLabel(l, pol, names)}（${coName(l.co, companies)}）${l.amt > 0 ? '借方' : '貸方'} ${fmt(Math.abs(l.amt))}`), l.bases && l.bases.length ? h('ul', null, l.bases.slice(0, 6).map((b) => h('li', null, b)), l.bases.length > 6 ? h('li', null, `ほか ${l.bases.length - 6} 件`) : null) : null))),
    j.details && j.details.length ? h('div', null, h('div', { class: 'sub-title' }, `月次の明細（${j.details.length}件：個別仕訳の取消）`),
      h('div', { class: 'tbl-wrap scroll-y' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, h('th', null, '年月'), h('th', null, '内容'), h('th', null, '借方'), h('th', null, '貸方'))),
        h('tbody', null, j.details.map((d) => h('tr', null, h('td', null, indexToJp(d.m)), h('td', null, d.note),
          h('td', null, d.lines.filter((l) => l.amt > 0).map((l) => `${accountLabel(l, pol, names)} ${fmt(l.amt)}`).join('、')),
          h('td', null, d.lines.filter((l) => l.amt < 0).map((l) => `${accountLabel(l, pol, names)} ${fmt(-l.amt)}`).join('、')))))))) : null);
  // 合算した仕訳は、会社別・契約別にドリルダウンできる（開いたときに作る）
  let drill = null;
  if (j.parts && j.parts.length > 1 && !opts.noDrill) {
    const box = h('div');
    drill = h('details', { class: 'basis drill', on: { toggle: (e) => {
      if (!e.target.open || box.childNodes.length) return;
      const byPair = new Map();
      for (const p of j.parts) { const k = pairLabel(p, companies); (byPair.get(k) || byPair.set(k, []).get(k)).push(p); }
      for (const [pair, ps] of byPair) {
        const sub = h('div', { class: 'drill-sub' });
        const det = h('details', { class: 'drill-pair', on: { toggle: (ev) => {
          if (!ev.target.open || sub.childNodes.length) return;
          sub.append(...ps.map((p) => journalCard(p, ctx, { ...opts, noDrill: true, compact: true })));
        } } }, h('summary', null, `${pair}（${ps.length}本）：借方合計 ${fmt(ps.flatMap((p) => p.lines).filter((x) => x.amt > 0).reduce((a, x) => a + x.amt, 0))}　契約ごとに表示`), sub);
        box.append(det);
      }
    } } }, h('summary', null, `会社別・契約別の内訳を表示（${j.parts.length}本）`), box);
  }
  const acts = opts.actions ? opts.actions(j).filter(Boolean) : [];
  return h('article', { class: `journal-card kind-${j.kind}${opts.compact ? ' compact' : ''}${j.override ? ' overridden' : ''}` },
    h('header', null,
      h('span', { class: `tpl tpl-${j.kind}` }, j.src ? `${j.tpl}・${j.src}` : j.tpl),
      h('span', { class: 'jt' }, j.title),
      j.override || (j.parts && j.parts.some((p) => p.override)) ? h('span', { class: 'badge caution' }, '手修正あり') : null,
      j.carriedOverride ? h('span', { class: 'badge caution' }, '手修正の引継') : null,
      opts.hideContract ? null : h('span', { class: 'jc' }, j.parts ? j.groupLabel : j.manual ? `手入力（理由：${j.reason}）` : `${j.contractId}：${coName(j.lessorCo, companies)} → ${coName(j.lesseeCo, companies)}`),
      acts.length ? h('span', { class: 'jcard-actions' }, ...acts) : null),
    opts.notice ? opts.notice(j) : null,
    tbl, tblM, drill, opts.noBasis || j.parts ? null : basis);
}

export function emptyState(msg) {
  return h('div', { class: 'empty' }, msg);
}

/** 仕訳の内容（開始仕訳・洗替は元の内容つき）のキーと名前 */
export const contentKey = (j) => (j.src ? `${j.tpl}:${j.src}` : j.tpl);
export const contentName = (j) => j.title || TEMPLATES[j.tpl]?.title || j.tpl;
const TPL_ORDER = Object.keys(TEMPLATES);
export function contentOrder(a, b) {
  const ta = TPL_ORDER.indexOf(a.tpl), tb = TPL_ORDER.indexOf(b.tpl);
  if (ta !== tb) return ta - tb;
  return TPL_ORDER.indexOf(a.src || '') - TPL_ORDER.indexOf(b.src || '');
}
export function pairLabel(j, companies) {
  if (j.manual) return '手入力仕訳';
  if (j.company) return coName(j.company, companies);
  return `${coName(j.lessorCo, companies)} → ${coName(j.lesseeCo, companies)}`;
}

/** 仕訳の行を科目（表示名）・会社ごとに合算する */
export function aggregateLines(lines, pol, names) {
  const m = new Map();
  for (const l of lines) {
    const k = `${accountLabel(l, pol, names)}|${l.co}`;
    const ex = m.get(k);
    if (ex) { ex.amt += l.amt; ex.bases = (ex.bases || []).concat(l.bases || []); } else m.set(k, { ...l, bases: [...(l.bases || [])] });
  }
  return [...m.values()].filter((l) => l.amt);
}

/**
 * 仕訳の表示単位：contract＝契約単位（そのまま）、company＝会社単位（内容×会社の組合せ）、total＝合計（内容ごと）
 * 合算した仕訳は parts（元の仕訳）を持ち、会社別・契約別にドリルダウンできる。
 */
export function groupJournals(js, mode, ctx) {
  const sorted = [...js].sort(contentOrder);
  if (mode === 'contract') return sorted;
  const groups = new Map();
  for (const j of sorted) {
    const k = mode === 'total' ? contentKey(j) : `${contentKey(j)}|${pairLabel(j, ctx.companies)}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(j);
  }
  return [...groups.values()].map((parts) => {
    const f = parts[0];
    const ids = [...new Set(parts.map((p) => p.contractId))];
    return { id: `G-${mode}-${contentKey(f)}-${mode === 'total' ? '' : pairLabel(f, ctx.companies)}`, tpl: f.tpl, src: f.src, kind: f.kind, title: contentName(f), manual: false,
      lessorCo: f.lessorCo, lesseeCo: f.lesseeCo, company: f.company, contractId: ids.length === 1 ? ids[0] : `${ids.length}契約`,
      groupLabel: mode === 'total' ? `合計：${parts.length}本（${ids.length}契約）` : `${pairLabel(f, ctx.companies)}：${parts.length}本（${ids.length}契約）`,
      lines: aggregateLines(parts.flatMap((p) => p.lines), ctx.pol, ctx.names), parts };
  });
}
