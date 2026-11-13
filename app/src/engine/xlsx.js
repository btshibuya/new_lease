// Excel（.xlsx）の書出し・読込（外部ライブラリを使わない最小実装。CSP で外部スクリプトを禁止しているため）。
// 書出し：ZIP（無圧縮）に OOXML の部品を格納する。スタイルは収集表に必要なものだけを固定で持つ。
// 読込：ZIP の中央ディレクトリを読み、無圧縮・deflate（ブラウザ・Node の DecompressionStream）を展開して、
//       シートのセルを文字列の2次元配列にする（共有文字列・インライン文字列・数値・数式の結果に対応）。

// ── ZIP ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

/** 無圧縮の ZIP を作る。files：[{ name, data: string|Uint8Array }] */
export function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    // 日時は固定（1980-01-01）。UTF-8 のファイル名（フラグ bit 11）
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
    parts.push(local, name, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((a, x) => a + x.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, x) => a + x.length, 0));
  let p = 0;
  for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('この環境では圧縮された Excel ファイルを展開できません（ブラウザを最新にしてください）');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ZIP を展開する（中央ディレクトリから読む）。戻り値：Map（ファイル名 → Uint8Array） */
export async function unzip(bytes, { maxEntries = 2000, maxTotal = 200 * 1024 * 1024 } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Excel ファイル（.xlsx）として読めません（ZIP 形式ではありません）');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count > maxEntries) throw new Error('ファイル内の部品が多すぎます');
  const out = new Map();
  const dec = new TextDecoder();
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Excel ファイルの構造が壊れています');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    total += usize;
    if (total > maxTotal) throw new Error('展開後のサイズが大きすぎます');
    const lnlen = dv.getUint16(loff + 26, true), lelen = dv.getUint16(loff + 28, true);
    const start = loff + 30 + lnlen + lelen;
    const raw = b.subarray(start, start + csize);
    // シートや共有文字列など、読む必要のある部品だけを展開する
    if (!/^(xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml))$/.test(name)) continue;
    if (method === 0) out.set(name, raw.slice());
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new Error(`対応していない圧縮形式です（${method}）`);
  }
  return out;
}

// ── XML ──
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
export function xmlEsc(s) {
  return String(s ?? '').replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function xmlUnesc(s) {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
    if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'"; if (e === 'amp') return '&';
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}
/** 文字列要素（<si> や <is>）の中のテキスト（書式付きの <r><t> も連結。ふりがな <rPh> は除く） */
function textOf(xml) {
  const noPh = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of noPh.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) s += xmlUnesc(m[1] || '');
  return s;
}

export function colName(i) { // 0 → A
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref);
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ── 書式（収集表で使うものを固定で定義） ──
export const STYLE = { default: 0, header: 1, text: 2, num: 3, inNum: 4, inText: 5, section: 6, calc: 7, title: 8, note: 9, plain: 10, bold: 11, lockedNote: 12 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0;&quot;△&quot;#,##0"/></numFmts>
<fonts count="5">
<font><sz val="10"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font>
<font><b/><sz val="10"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font>
<font><b/><sz val="14"/><color rgb="FF1F3864"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font>
<font><sz val="9"/><color rgb="FF595959"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font>
</fonts>
<fills count="7">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment vertical="top"/><protection locked="0"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment vertical="top" wrapText="1"/><protection locked="0"/></xf>
<xf numFmtId="0" fontId="1" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * シートの XML を作る。
 * sheet：{ name, rows: Array<Array<null|{v?, f?, s?}>>, cols: number[]（列幅）, freeze: {row, col}（左上の固定範囲）,
 *          autoFilter: 'A5:P100', validations: [{ sqref, type: 'decimal', title, prompt, error }], protect: boolean,
 *          merges: ['A1:F1'], heights: { 行番号(1始まり): 高さ } }
 */
function sheetXml(sh) {
  const rows = sh.rows.map((r, ri) => {
    if (!r) return '';
    const cells = r.map((c, ci) => {
      if (!c) return '';
      const ref = `${colName(ci)}${ri + 1}`;
      const s = c.s ? ` s="${c.s}"` : '';
      if (c.f) return `<c r="${ref}"${s}><f>${xmlEsc(c.f)}</f></c>`;
      if (c.v === null || c.v === undefined || c.v === '') return c.s ? `<c r="${ref}"${s}/>` : '';
      if (typeof c.v === 'number' && Number.isFinite(c.v)) return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
      return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
    }).join('');
    const ht = sh.heights?.[ri + 1] ? ` ht="${sh.heights[ri + 1]}" customHeight="1"` : '';
    return `<row r="${ri + 1}"${ht}>${cells}</row>`;
  }).join('');
  const fz = sh.freeze;
  const pane = fz && (fz.row || fz.col) ? `<pane${fz.col ? ` xSplit="${fz.col}"` : ''}${fz.row ? ` ySplit="${fz.row}"` : ''} topLeftCell="${colName(fz.col || 0)}${(fz.row || 0) + 1}" activePane="${fz.row && fz.col ? 'bottomRight' : fz.row ? 'bottomLeft' : 'topRight'}" state="frozen"/>` : '';
  const cols = sh.cols?.length ? `<cols>${sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  // 保護：パスワードなし。入力欄（ロックしない書式）だけ編集でき、フィルター・列幅・行の高さの変更は許可
  const prot = sh.protect ? '<sheetProtection sheet="1" objects="1" scenarios="1" formatColumns="0" formatRows="0" autoFilter="0" sort="0"/>' : '';
  const af = sh.autoFilter ? `<autoFilter ref="${sh.autoFilter}"/>` : '';
  const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const dv = sh.validations?.length ? `<dataValidations count="${sh.validations.length}">${sh.validations.map((v) => `<dataValidation type="${v.type || 'decimal'}" operator="between" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="${xmlEsc(v.title || '入力エラー')}" error="${xmlEsc(v.error || '数値を入力してください')}" promptTitle="${xmlEsc(v.title || '')}" prompt="${xmlEsc(v.prompt || '')}" sqref="${v.sqref}"><formula1>-999999999999</formula1><formula2>999999999999</formula2></dataValidation>`).join('')}</dataValidations>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"${sh.tabSelected ? ' tabSelected="1"' : ''} zoomScale="100">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${prot}${af}${merges}${dv}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

/** ブック（.xlsx）のバイト列を作る。sheets は上の sheetXml の形式 */
export function writeXlsx(sheets) {
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const names = sheets.map((sh, i) => (sh.autoFilter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEsc(sh.name)}'!$${sh.autoFilter.replace(/([A-Z]+)(\d+)/g, '$1$$$2').replace(':', ':$')}</definedName>` : '')).join('');
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((sh, i) => `<sheet name="${xmlEsc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${names ? `<definedNames>${names}</definedNames>` : ''}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  return zipStore([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh) })),
  ]);
}

/**
 * .xlsx を読み、シートごとのセルを文字列の2次元配列で返す。数値はそのまま文字列（例 "1200"）、数式は計算結果の値。
 * @returns {Promise<Array<{ name: string, rows: string[][] }>>}
 */
export async function readXlsx(bytes) {
  const files = await unzip(bytes);
  const dec = new TextDecoder();
  const get = (n) => (files.has(n) ? dec.decode(files.get(n)) : null);
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('Excel ファイル（.xlsx）として読めません（ブックの情報がありません）');
  const rels = new Map();
  for (const m of (get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1], target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(textOf(m[1] || ''));
  const out = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlUnesc(/name="([^"]*)"/.exec(m[0])?.[1] || '');
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const path = `xl/${rels.get(rid) || ''}`;
    const xml = get(path);
    if (!xml) continue;
    const rows = [];
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rn = Number(/\br="(\d+)"/.exec(rm[1])?.[1]);
      const row = [];
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1], inner = cm[2] || '';
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const ci = ref ? colIndex(ref) : row.length;
        const t = /\bt="([^"]+)"/.exec(attrs)?.[1] || 'n';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let val = '';
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = textOf(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] || '');
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) val = xmlUnesc(v);
        if (ci > 16384) continue;
        while (row.length < ci) row.push('');
        row[ci] = val;
      }
      if (Number.isInteger(rn) && rn > 0 && rn <= 1048576) { while (rows.length < rn - 1) rows.push([]); rows[rn - 1] = row; } else rows.push(row);
    }
    out.push({ name, rows });
  }
  return out;
}
