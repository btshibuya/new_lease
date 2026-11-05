// SVG グラフ（外部ライブラリ不使用）。全グラフに凡例・ホバーのツールチップ・「表で見る」切替を付ける。
import { h, s, table } from './dom.js';
import { fmt } from '../engine/util.js';

const W = 720;
const PAD = { l: 72, r: 16, t: 16, b: 44 };

function niceTicks(min, max, n = 5) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
}

function frame(opts, svg, tableNode) {
  const wrap = h('figure', { class: `chart${opts.wide ? ' wide' : ''}` });
  const tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
  const body = h('div', { class: 'chart-body' }, svg, tip);
  const tbl = h('div', { class: 'chart-table', hidden: true }, tableNode);
  const btn = h('button', { class: 'btn-link', type: 'button', 'aria-pressed': 'false', on: { click: () => {
    const show = tbl.hidden;
    tbl.hidden = !show; body.hidden = show;
    btn.textContent = show ? 'グラフで見る' : '表で見る';
    btn.setAttribute('aria-pressed', String(show));
  } } }, '表で見る');
  const legend = opts.legend && opts.legend.length > 1
    ? h('ul', { class: 'legend' }, opts.legend.map((l) => h('li', null, h('span', { class: `sw ${l.kind || ''}`, style: { '--c': l.color } }), l.name)))
    : null;
  wrap.append(
    h('figcaption', { class: 'chart-head' }, h('div', null, h('div', { class: 'chart-title' }, opts.title || ''), opts.subtitle ? h('div', { class: 'chart-sub' }, opts.subtitle) : null), btn),
    legend || '', body, tbl,
  );
  wrap._tip = tip;
  wrap._body = body;
  return wrap;
}

function showTip(fig, evt, lines) {
  const tip = fig._tip;
  tip.replaceChildren(...lines.map((l, i) => h('div', { class: i === 0 ? 'tip-title' : 'tip-row' },
    l.color ? h('span', { class: 'sw', style: { '--c': l.color } }) : null, l.text)));
  tip.hidden = false;
  const r = fig._body.getBoundingClientRect();
  const x = evt.clientX - r.left;
  const y = evt.clientY - r.top;
  const tw = tip.offsetWidth;
  tip.style.setProperty('left', `${Math.min(Math.max(x + 12, 0), r.width - tw - 4)}px`);
  tip.style.setProperty('top', `${Math.max(y - 10, 0)}px`);
}
function hideTip(fig) { fig._tip.hidden = true; }

function axes(g, x0, x1, y, ticks, labels, xPos, unit) {
  for (const t of ticks) {
    g.append(s('line', { x1: x0, x2: x1, y1: y(t), y2: y(t), class: t === 0 ? 'axis-zero' : 'grid' }));
    g.append(s('text', { x: x0 - 8, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, fmt(t)));
  }
  const every = Math.ceil(labels.length / 12);
  labels.forEach((lb, i) => {
    if (i % every) return;
    g.append(s('text', { x: xPos(i), y: PAD.t + (y.h || 0) + 18, class: 'tick', 'text-anchor': 'middle' }, lb));
  });
  if (unit) g.append(s('text', { x: 8, y: 12, class: 'tick unit' }, unit));
}

/**
 * 折れ線（任意で2系列間の帯を塗る）
 * opts: { title, labels, series:[{name, values, color, dashed}], band:{upper, lower, name, color}, unit }
 */
export function lineChart(opts) {
  const H = opts.height || 280;
  const ih = H - PAD.t - PAD.b;
  const iw = W - PAD.l - PAD.r;
  const all = opts.series.flatMap((x) => x.values).filter((v) => Number.isFinite(v));
  const { lo, hi, ticks } = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const y = (v) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;
  y.h = ih;
  const n = opts.labels.length;
  const x = (i) => PAD.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'svg', role: 'img', 'aria-label': opts.title });
  const g = s('g');
  axes(g, PAD.l, W - PAD.r, y, ticks, opts.labels, x, opts.unit);
  if (opts.band) {
    const up = opts.series[opts.band.upper].values;
    const lw = opts.series[opts.band.lower].values;
    const pts = up.map((v, i) => `${x(i)},${y(v)}`).concat(lw.map((v, i) => `${x(i)},${y(v)}`).reverse()).join(' ');
    g.append(s('polygon', { points: pts, class: 'band', style: { '--c': opts.band.color } }));
  }
  for (const se of opts.series) {
    const d = se.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
    g.append(s('path', { d, class: `line${se.dashed ? ' dashed' : ''}`, style: { '--c': se.color } }));
    se.values.forEach((v, i) => g.append(s('circle', { cx: x(i), cy: y(v), r: 3.5, class: 'dot', style: { '--c': se.color } })));
  }
  const cross = s('line', { y1: PAD.t, y2: PAD.t + ih, class: 'cross', visibility: 'hidden' });
  g.append(cross);
  svg.append(g);
  const legend = opts.series.map((x2) => ({ name: x2.name, color: x2.color, kind: x2.dashed ? 'dash' : 'line' }));
  if (opts.band) legend.push({ name: opts.band.name, color: opts.band.color, kind: 'area' });
  const tbl = table([{ label: '期間', key: 'label' }, ...opts.series.map((x2, k) => ({ label: x2.name, num: true, render: (r) => r.v[k] })), ...(opts.band ? [{ label: opts.band.name, num: true, render: (r) => r.v[opts.band.upper] - r.v[opts.band.lower] }] : [])],
    opts.labels.map((lb, i) => ({ label: lb, v: opts.series.map((x2) => x2.values[i]) })));
  const fig = frame({ ...opts, legend }, svg, tbl);
  // ホバー
  const hit = s('rect', { x: PAD.l - 10, y: PAD.t, width: iw + 20, height: ih, class: 'hit' });
  hit.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - PAD.l) / iw) * (n - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    const lines = [{ text: opts.labels[i] }, ...opts.series.map((se) => ({ color: se.color, text: `${se.name}：${fmt(se.values[i])}` }))];
    if (opts.band) lines.push({ color: opts.band.color, text: `${opts.band.name}：${fmt(opts.series[opts.band.upper].values[i] - opts.series[opts.band.lower].values[i])}` });
    showTip(fig, e, lines);
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(fig); });
  svg.append(hit);
  return fig;
}

/**
 * 棒グラフ（積上げ可、同一単位の折れ線を重ねられる）
 * opts: { title, labels, series:[{name, values, color}], stacked, line:{name, values, color}, unit }
 */
export function barChart(opts) {
  const H = opts.height || 280;
  const ih = H - PAD.t - PAD.b;
  const iw = W - PAD.l - PAD.r;
  const n = opts.labels.length;
  const k = opts.series.length;
  let mn = 0, mx = 0;
  for (let i = 0; i < n; i++) {
    if (opts.stacked) {
      let p = 0, q = 0;
      for (const se of opts.series) { const v = se.values[i] || 0; if (v >= 0) p += v; else q += v; }
      mx = Math.max(mx, p); mn = Math.min(mn, q);
    } else for (const se of opts.series) { mx = Math.max(mx, se.values[i] || 0); mn = Math.min(mn, se.values[i] || 0); }
    if (opts.line) { mx = Math.max(mx, opts.line.values[i] || 0); mn = Math.min(mn, opts.line.values[i] || 0); }
  }
  const { lo, hi, ticks } = niceTicks(mn, mx);
  const y = (v) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;
  y.h = ih;
  const band = iw / n;
  const xc = (i) => PAD.l + band * i + band / 2;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'svg', role: 'img', 'aria-label': opts.title });
  const g = s('g');
  axes(g, PAD.l, W - PAD.r, y, ticks, opts.labels, xc, opts.unit);
  const groupW = Math.min(band * 0.72, 64);
  const fig = { _tip: null };
  for (let i = 0; i < n; i++) {
    let p = 0, q = 0;
    const bw = opts.stacked ? groupW : Math.max((groupW - (k - 1) * 2) / k, 2);
    opts.series.forEach((se, j) => {
      const v = se.values[i] || 0;
      if (!v) return;
      let y0, y1;
      if (opts.stacked) {
        if (v >= 0) { y0 = y(p); y1 = y(p + v); p += v; } else { y0 = y(q); y1 = y(q + v); q += v; }
      } else { y0 = y(0); y1 = y(v); }
      const bx = opts.stacked ? xc(i) - groupW / 2 : xc(i) - groupW / 2 + j * (bw + 2);
      const top = Math.min(y0, y1), hgt = Math.max(Math.abs(y1 - y0) - (opts.stacked ? 2 : 0), 1);
      g.append(s('rect', { x: bx, y: top + (opts.stacked && v >= 0 ? 2 : 0), width: bw, height: hgt, rx: 3, class: 'bar', style: { '--c': se.color } }));
    });
  }
  if (opts.line) {
    const d = opts.line.values.map((v, i) => `${i ? 'L' : 'M'}${xc(i)},${y(v)}`).join('');
    g.append(s('path', { d, class: 'line', style: { '--c': opts.line.color } }));
    opts.line.values.forEach((v, i) => g.append(s('circle', { cx: xc(i), cy: y(v), r: 4, class: 'dot', style: { '--c': opts.line.color } })));
  }
  svg.append(g);
  const legend = opts.series.map((x2) => ({ name: x2.name, color: x2.color, kind: 'box' }));
  if (opts.line) legend.push({ name: opts.line.name, color: opts.line.color, kind: 'line' });
  const cols = [{ label: '期間', key: 'label' }, ...opts.series.map((x2, j) => ({ label: x2.name, num: true, render: (r) => r.v[j] }))];
  if (opts.line) cols.push({ label: opts.line.name, num: true, render: (r) => r.lv });
  const tbl = table(cols, opts.labels.map((lb, i) => ({ label: lb, v: opts.series.map((x2) => x2.values[i] || 0), lv: opts.line ? opts.line.values[i] : null })));
  const f = frame({ ...opts, legend }, svg, tbl);
  for (let i = 0; i < n; i++) {
    const hit = s('rect', { x: PAD.l + band * i, y: PAD.t, width: band, height: ih, class: 'hit' });
    hit.addEventListener('mousemove', (e) => {
      const lines = [{ text: opts.labels[i] }, ...opts.series.map((se) => ({ color: se.color, text: `${se.name}：${fmt(se.values[i] || 0)}` }))];
      if (opts.stacked && opts.series.length > 1) lines.push({ text: `合計：${fmt(opts.series.reduce((a, se) => a + (se.values[i] || 0), 0))}` });
      if (opts.line) lines.push({ color: opts.line.color, text: `${opts.line.name}：${fmt(opts.line.values[i])}` });
      showTip(f, e, lines);
    });
    hit.addEventListener('mouseleave', () => hideTip(f));
    svg.append(hit);
  }
  return f;
}

/**
 * ウォーターフォール（ブリッジ）
 * opts: { title, steps:[{label, value, total}], unit }
 */
export function waterfall(opts) {
  const H = opts.height || 300;
  const ih = H - PAD.t - PAD.b - 20;
  const iw = W - PAD.l - PAD.r;
  let run = 0;
  const bars = opts.steps.map((st) => {
    if (st.total) { const b = { ...st, from: 0, to: st.value }; run = st.value; return b; }
    const b = { ...st, from: run, to: run + st.value }; run += st.value; return b;
  });
  const vals = bars.flatMap((b) => [b.from, b.to]);
  const { lo, hi, ticks } = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const y = (v) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;
  y.h = ih;
  const n = bars.length;
  const band = iw / n;
  const xc = (i) => PAD.l + band * i + band / 2;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'svg', role: 'img', 'aria-label': opts.title });
  const g = s('g');
  for (const t of ticks) {
    g.append(s('line', { x1: PAD.l, x2: W - PAD.r, y1: y(t), y2: y(t), class: t === 0 ? 'axis-zero' : 'grid' }));
    g.append(s('text', { x: PAD.l - 8, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, fmt(t)));
  }
  const bw = Math.min(band * 0.6, 56);
  bars.forEach((b, i) => {
    const top = Math.min(y(b.from), y(b.to));
    const hgt = Math.max(Math.abs(y(b.to) - y(b.from)), 1);
    const color = b.total ? 'var(--total)' : b.value >= 0 ? 'var(--up)' : 'var(--down)';
    g.append(s('rect', { x: xc(i) - bw / 2, y: top, width: bw, height: hgt, rx: 3, class: 'bar', style: { '--c': color } }));
    if (i < n - 1) g.append(s('line', { x1: xc(i) + bw / 2, x2: xc(i + 1) - bw / 2, y1: y(b.to), y2: y(b.to), class: 'connector' }));
    g.append(s('text', { x: xc(i), y: top - 6, class: 'val', 'text-anchor': 'middle' }, fmt(b.total ? b.value : b.value)));
    const words = String(b.label);
    const lines = words.length > 8 ? [words.slice(0, 8), words.slice(8, 16)] : [words];
    lines.forEach((t, k) => g.append(s('text', { x: xc(i), y: PAD.t + ih + 18 + k * 14, class: 'tick', 'text-anchor': 'middle' }, t)));
  });
  if (opts.unit) g.append(s('text', { x: 8, y: 12, class: 'tick unit' }, opts.unit));
  svg.append(g);
  const tbl = table([{ label: '項目', key: 'label' }, { label: '金額', key: 'value', num: true }, { label: '累計', key: 'to', num: true }], bars);
  const f = frame({ ...opts, legend: [{ name: '増加', color: 'var(--up)', kind: 'box' }, { name: '減少', color: 'var(--down)', kind: 'box' }, { name: '合計', color: 'var(--total)', kind: 'box' }] }, svg, tbl);
  bars.forEach((b, i) => {
    const hit = s('rect', { x: PAD.l + band * i, y: PAD.t, width: band, height: ih, class: 'hit' });
    hit.addEventListener('mousemove', (e) => showTip(f, e, [{ text: b.label }, { text: `${b.total ? '合計' : '増減'}：${fmt(b.value)}` }, ...(b.basis ? [{ text: b.basis }] : [])]));
    hit.addEventListener('mouseleave', () => hideTip(f));
    svg.append(hit);
  });
  return f;
}

/**
 * グループ内リース相関図
 * opts: { title, nodes:[{id,label,sub}], edges:[{from,to,label,detail,weight}] }
 */
export function network(opts) {
  const H = opts.height || 360;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - 70;
  const n = opts.nodes.length;
  const pos = {};
  opts.nodes.forEach((nd, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1);
    pos[nd.id] = { x: cx + R * Math.cos(a) * 1.25, y: cy + R * Math.sin(a) };
  });
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'svg', role: 'img', 'aria-label': opts.title });
  const defs = s('defs', null, s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'arrowhead' })));
  svg.append(defs);
  const maxW = Math.max(1, ...opts.edges.map((e) => e.weight || 1));
  const f = frame({ ...opts, legend: [] }, svg, table([{ label: '貸手', key: 'from' }, { label: '借手', key: 'to' }, { label: '内容', key: 'label' }], opts.edges.map((e) => ({ ...e, from: opts.nodes.find((x) => x.id === e.from)?.label, to: opts.nodes.find((x) => x.id === e.to)?.label }))));
  const pairCount = {};
  for (const e of opts.edges) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const key = [e.from, e.to].sort().join('|');
    const idx = (pairCount[key] = (pairCount[key] || 0) + 1);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const bend = (e.from < e.to ? 1 : -1) * (28 + (idx - 1) * 22);
    const sx = a.x + (dx / len) * 46, sy = a.y + (dy / len) * 46;
    const ex = b.x - (dx / len) * 50, ey = b.y - (dy / len) * 50;
    const mx = (sx + ex) / 2 + nx * bend, my = (sy + ey) / 2 + ny * bend;
    const wdt = 1.5 + 4 * ((e.weight || 1) / maxW);
    const path = s('path', { d: `M${sx},${sy} Q${mx},${my} ${ex},${ey}`, class: 'edge', 'stroke-width': wdt, 'marker-end': 'url(#arrow)' });
    svg.append(path);
    const lx = (sx + 2 * mx + ex) / 4, ly = (sy + 2 * my + ey) / 4;
    const t = s('text', { x: lx, y: ly, class: 'edge-label', 'text-anchor': 'middle' }, e.label);
    svg.append(t);
    const hit = s('path', { d: `M${sx},${sy} Q${mx},${my} ${ex},${ey}`, class: 'edge-hit' });
    hit.addEventListener('mousemove', (ev) => showTip(f, ev, [{ text: `${opts.nodes.find((x) => x.id === e.from)?.label} → ${opts.nodes.find((x) => x.id === e.to)?.label}` }, ...(e.detail || []).map((d) => ({ text: d }))]));
    hit.addEventListener('mouseleave', () => hideTip(f));
    svg.append(hit);
  }
  for (const nd of opts.nodes) {
    const p = pos[nd.id];
    svg.append(s('rect', { x: p.x - 80, y: p.y - 26, width: 160, height: 52, rx: 10, class: `node${nd.parent ? ' parent' : ''}` }));
    svg.append(s('text', { x: p.x, y: p.y - 3, class: 'node-label', 'text-anchor': 'middle' }, nd.label));
    if (nd.sub) svg.append(s('text', { x: p.x, y: p.y + 15, class: 'node-sub', 'text-anchor': 'middle' }, nd.sub));
  }
  return f;
}

/**
 * 契約タイムライン（ガントチャート）
 * opts: { title, rows:[{label, start, end, termination, color}], min, max, highlight:{start,end}, monthLabel }
 */
export function gantt(opts) {
  const rowH = 30;
  const top = 26;
  const H = top + rowH * opts.rows.length + 10;
  const L = 220;
  const iw = W - L - PAD.r;
  const x = (m) => L + ((m - opts.min) / (opts.max - opts.min + 1)) * iw;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'svg', role: 'img', 'aria-label': opts.title });
  const f = frame({ ...opts, legend: [{ name: 'リース期間', color: 'var(--s1)', kind: 'box' }, { name: '選択中の期間', color: 'var(--hl)', kind: 'area' }] }, svg,
    table([{ label: '契約', key: 'label' }, { label: '開始', key: 'startLabel' }, { label: '終了', key: 'endLabel' }, { label: '備考', key: 'note' }], opts.rows));
  if (opts.highlight) svg.append(s('rect', { x: x(opts.highlight.start), y: top - 6, width: Math.max(x(opts.highlight.end + 1) - x(opts.highlight.start), 1), height: H - top, class: 'hl' }));
  for (let y0 = Math.ceil(opts.min / 12) * 12; y0 <= opts.max; y0 += 12) {
    svg.append(s('line', { x1: x(y0), x2: x(y0), y1: top - 6, y2: H - 4, class: 'grid' }));
    svg.append(s('text', { x: x(y0) + 3, y: 14, class: 'tick' }, `${Math.floor(y0 / 12)}`));
  }
  opts.rows.forEach((r, i) => {
    const yy = top + i * rowH;
    svg.append(s('text', { x: 8, y: yy + 18, class: 'tick row-label' }, r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label));
    const bar = s('rect', { x: x(r.start), y: yy + 6, width: Math.max(x(r.end + 1) - x(r.start), 2), height: rowH - 12, rx: 4, class: 'bar', style: { '--c': r.color || 'var(--s1)' } });
    svg.append(bar);
    if (r.termination !== null && r.termination !== undefined) {
      svg.append(s('text', { x: x(r.termination + 1), y: yy + 20, class: 'mark', 'text-anchor': 'middle' }, '✕'));
    }
    const hit = s('rect', { x: L, y: yy, width: iw, height: rowH, class: 'hit' });
    hit.addEventListener('mousemove', (e) => showTip(f, e, [{ text: r.label }, { text: `${r.startLabel} 〜 ${r.endLabel}` }, ...(r.note ? [{ text: r.note }] : [])]));
    hit.addEventListener('mouseleave', () => hideTip(f));
    if (r.onClick) hit.addEventListener('click', r.onClick);
    svg.append(hit);
  });
  return f;
}
