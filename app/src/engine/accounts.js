// 勘定科目定義（共通部品）。表示名はカスタマイズ層（config.accountNames）で上書きできる。
// side: 'L'=借手会社の科目, 'R'=貸手会社の科目, 'C'=連結固有の科目
// type: 'BS' | 'PL'

export const ACCOUNTS = {
  // ── 借手（BS） ──
  ROU_COST: { name: '使用権資産', type: 'BS', side: 'L', group: '資産' },
  ROU_ACC: { name: '使用権資産減価償却累計額', type: 'BS', side: 'L', group: '資産' },
  LL_C: { name: 'リース負債（流動）', type: 'BS', side: 'L', group: '負債' },
  LL_NC: { name: 'リース負債（固定）', type: 'BS', side: 'L', group: '負債' },
  LEASE_ACCRUED: { name: '未払リース料', type: 'BS', side: 'L', group: '負債' },
  OTHER_ASSET: { name: '長期前払費用（初期直接費用）', type: 'BS', side: 'L', group: '資産' },
  OTHER_ACC: { name: '長期前払費用償却累計額（初期直接費用）', type: 'BS', side: 'L', group: '資産' },
  LEGACY_ASSET: { name: 'リース資産（個別の旧科目）', type: 'BS', side: 'L', group: '資産' },
  LEGACY_ACC: { name: 'リース資産減価償却累計額（個別の旧科目）', type: 'BS', side: 'L', group: '資産' },
  LEGACY_LIAB_C: { name: 'リース債務（流動・個別の旧科目）', type: 'BS', side: 'L', group: '負債' },
  LEGACY_LIAB: { name: 'リース債務（固定・個別の旧科目）', type: 'BS', side: 'L', group: '負債' },
  // ── 借手（PL） ──
  DEP_ROU: { name: '減価償却費（使用権資産）', type: 'PL', side: 'L', group: '費用' },
  INT: { name: 'リース負債に係る利息費用', type: 'PL', side: 'L', group: '費用' },
  ASC_COST: { name: 'リース費用（ASC842 単一リース費用）', type: 'PL', side: 'L', group: '費用' },
  SHORT_COST: { name: 'リース費用（短期・少額リース等）', type: 'PL', side: 'L', group: '費用' },
  PRE_RENT: { name: '支払リース料（適用開始前・旧基準）', type: 'PL', side: 'L', group: '費用' },
  TERM_GAIN: { name: 'リース解約損益', type: 'PL', side: 'L', group: '損益' },
  PENALTY_EXP: { name: '解約違約金（支払）', type: 'PL', side: 'L', group: '費用' },
  MOD_GAIN: { name: 'リース条件変更損益（範囲の縮小）', type: 'PL', side: 'L', group: '損益' },
  IDC_EXP: { name: '初期直接費用（連結上の費用処理）', type: 'PL', side: 'L', group: '費用' },
  DEP_OTHER: { name: '減価償却費（初期直接費用）', type: 'PL', side: 'L', group: '費用' },
  // ── 貸手（BS） ──
  ACCR_INC: { name: '未収リース料（定額法による未収）', type: 'BS', side: 'R', group: '資産' },
  RENTAL_ASSET: { name: '賃貸資産', type: 'BS', side: 'R', group: '資産' },
  RENTAL_ACC: { name: '賃貸資産減価償却累計額', type: 'BS', side: 'R', group: '資産' },
  // ── 貸手（PL） ──
  LEASE_INC: { name: '受取リース料', type: 'PL', side: 'R', group: '収益' },
  RENTAL_DEP: { name: '減価償却費（賃貸資産）', type: 'PL', side: 'R', group: '費用' },
  PENALTY_INC: { name: '受取違約金（解約）', type: 'PL', side: 'R', group: '収益' },
  // ── 連結固有 ──
  RECLASS_ASSET: { name: '有形固定資産（使用実態の科目）', type: 'BS', side: 'C', group: '資産' },
  RECLASS_ACC: { name: '有形固定資産減価償却累計額（使用実態の科目）', type: 'BS', side: 'C', group: '資産' },
  DEP_RECLASS: { name: '減価償却費（借手の使用部門）', type: 'PL', side: 'C', group: '費用' },
  RE_OPEN: { name: '利益剰余金期首残高', type: 'BS', side: 'C', group: '純資産' },
  NCI: { name: '非支配株主持分', type: 'BS', side: 'C', group: '純資産' },
  CAP_SURPLUS: { name: '資本剰余金（持分変動）', type: 'BS', side: 'C', group: '純資産' },
  MANUAL: { name: '手入力科目（貸借対照表）', type: 'BS', side: 'C', group: '手入力' },
  MANUAL_PL: { name: '手入力科目（損益計算書）', type: 'PL', side: 'C', group: '手入力' },
  NCI_PL: { name: '非支配株主に帰属する当期純利益', type: 'PL', side: 'C', group: '損益' },
  DTA: { name: '繰延税金資産（△は繰延税金負債）', type: 'BS', side: 'C', group: '資産' },
  TAX_ADJ: { name: '法人税等調整額', type: 'PL', side: 'C', group: '費用' },
};

export const ASSET_CLASSES = {
  building: '建物',
  machine: '機械装置',
  vehicle: '車両運搬具',
  tool: '工具器具備品',
  land: '土地',
  other: 'その他',
};

export const LESSEE_DEPT = { sga: '販売費及び一般管理費', mfg: '製造原価（売上原価）' };
export const LESSOR_INC_CLASS = { sales: '売上高', nonop: '営業外収益' };
export const LESSOR_DEP_CLASS = { cogs: '売上原価（賃貸原価）', nonop: '営業外費用（賃貸費用）' };

/**
 * 仕訳明細の表示名を決める。
 * @param {object} line 仕訳明細 { acc, meta }
 * @param {object} policies 会計方針
 * @param {object} names カスタマイズ層の科目名上書き
 */
export function accountLabel(line, policies = {}, names = {}) {
  if (line.acc === 'MANUAL' || line.acc === 'MANUAL_PL' || (line.label && !ACCOUNTS[line.acc])) return line.label || ACCOUNTS[line.acc]?.name || '手入力科目';
  const m = line.meta || {};
  // ユーザー別の科目名：「キー.区分」（例 DEP_ROU.mfg、LEASE_INC.sales）→「キー」の順に優先
  const variant = { DEP_ROU: m.lesseeDept, DEP_RECLASS: m.lesseeDept, LEASE_INC: m.lessorIncClass, RENTAL_DEP: m.lessorDepClass, RECLASS_ASSET: m.assetClass, RECLASS_ACC: m.assetClass, ROU_COST: m.assetClass, ROU_ACC: m.assetClass }[line.acc];
  if (variant && names[`${line.acc}.${variant}`]) return names[`${line.acc}.${variant}`];
  // 区分を持つ科目は、名称だけを上書きした場合も区分を付記して別の行に集計する（区分の異なる金額の合算を防ぐ）
  const variantLabel = { DEP_ROU: LESSEE_DEPT[m.lesseeDept], DEP_RECLASS: LESSEE_DEPT[m.lesseeDept], LEASE_INC: LESSOR_INC_CLASS[m.lessorIncClass], RENTAL_DEP: LESSOR_DEP_CLASS[m.lessorDepClass], RECLASS_ASSET: ASSET_CLASSES[m.assetClass], RECLASS_ACC: ASSET_CLASSES[m.assetClass] }[line.acc];
  if (names[line.acc] && variantLabel) return `${names[line.acc]}（${variantLabel}）`;
  if (names[line.acc] && !(line.acc === 'ROU_COST' || line.acc === 'ROU_ACC')) return names[line.acc];
  const base = names[line.acc] || ACCOUNTS[line.acc]?.name || line.acc;
  const cls = ASSET_CLASSES[m.assetClass] || '';
  switch (line.acc) {
    case 'ROU_COST':
      return policies['POL-06'] === 'include' ? `${cls}（使用権資産）` : base;
    case 'ROU_ACC':
      return policies['POL-06'] === 'include' ? `${cls}減価償却累計額（使用権資産）` : base;
    case 'DEP_ROU':
      return `減価償却費（使用権資産・${LESSEE_DEPT[m.lesseeDept] || ''}）`;
    case 'LEASE_INC':
      return `${LESSOR_INC_CLASS[m.lessorIncClass] || ''}（受取リース料）`;
    case 'RENTAL_DEP':
      return `${LESSOR_DEP_CLASS[m.lessorDepClass] || ''}（減価償却費）`;
    case 'RECLASS_ASSET':
      return `${cls || '有形固定資産'}（連結上の自己使用資産）`;
    case 'RECLASS_ACC':
      return `${cls || '有形固定資産'}減価償却累計額（連結上の自己使用資産）`;
    case 'DEP_RECLASS':
      return `減価償却費（${LESSEE_DEPT[m.lesseeDept] || ''}）`;
    default:
      return base;
  }
}

/** 科目の表示グループキー（集計用）：表示名＋会社 */
export function isPL(acc) {
  return ACCOUNTS[acc]?.type === 'PL';
}

/** 契約から科目表示用のメタ情報（集約キーにも使う） */
export function metaOf(c) {
  return {
    contractId: c.id,
    assetClass: c.assetClass,
    lesseeDept: c.lessee?.dept,
    lessorIncClass: c.lessor?.incClass || 'sales',
    lessorDepClass: c.lessor?.depClass || 'cogs',
  };
}

/**
 * 会社の税率・非支配株主持分比率（指定月時点。履歴の適用開始年月で切替）
 * @param {object} co 会社
 * @param {number} idx 月インデックス
 * @param {'taxRate'|'nciRatio'} key
 */
export function rateAt(co, idx, key) {
  if (!co) return 0;
  let v = co[key] || 0;
  for (const h of co.history || []) {
    const [y, m] = h.fromYm.split('-').map(Number);
    if (y * 12 + m - 1 <= idx) v = h[key] || 0;
  }
  return v;
}

/** 連結損益計算書の区分（段階損益の比較用） */
export function plSection(line) {
  const m = line.meta || {};
  switch (line.acc) {
    case 'LEASE_INC': return m.lessorIncClass === 'nonop' ? '営業外収益' : '売上高';
    case 'RENTAL_DEP': return m.lessorDepClass === 'nonop' ? '営業外費用' : '売上原価';
    case 'DEP_ROU': case 'DEP_RECLASS': return m.lesseeDept === 'mfg' ? '売上原価' : '販管費';
    case 'ASC_COST': case 'SHORT_COST': case 'PRE_RENT': case 'DEP_OTHER': case 'IDC_EXP': return m.lesseeDept === 'mfg' ? '売上原価' : '販管費';
    case 'INT': return '営業外費用';
    case 'TERM_GAIN': case 'MOD_GAIN': case 'PENALTY_EXP': case 'PENALTY_INC': return '特別損益';
    case 'TAX_ADJ': return '法人税等';
    case 'NCI_PL': return '非支配株主に帰属する当期純利益';
    case 'MANUAL_PL': return '手入力（損益）';
    default: return ACCOUNTS[line.acc]?.type === 'PL' ? 'その他の損益' : null;
  }
}
