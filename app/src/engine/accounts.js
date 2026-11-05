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
  LEGACY_LIAB: { name: 'リース債務（個別の旧科目）', type: 'BS', side: 'L', group: '負債' },
  // ── 借手（PL） ──
  DEP_ROU: { name: '減価償却費（使用権資産）', type: 'PL', side: 'L', group: '費用' },
  INT: { name: '支払利息', type: 'PL', side: 'L', group: '費用' },
  LEASE_COST: { name: 'リース費用（単一費用・簡便法）', type: 'PL', side: 'L', group: '費用' },
  TERM_GAIN: { name: 'リース解約損益', type: 'PL', side: 'L', group: '損益' },
  IDC_EXP: { name: '初期直接費用（連結上の費用処理）', type: 'PL', side: 'L', group: '費用' },
  DEP_OTHER: { name: '減価償却費（初期直接費用）', type: 'PL', side: 'L', group: '費用' },
  // ── 貸手（BS） ──
  ACCR_INC: { name: '未収リース料（定額法による未収）', type: 'BS', side: 'R', group: '資産' },
  RENTAL_ASSET: { name: '賃貸資産', type: 'BS', side: 'R', group: '資産' },
  RENTAL_ACC: { name: '賃貸資産減価償却累計額', type: 'BS', side: 'R', group: '資産' },
  // ── 貸手（PL） ──
  LEASE_INC: { name: '受取リース料', type: 'PL', side: 'R', group: '収益' },
  RENTAL_DEP: { name: '減価償却費（賃貸資産）', type: 'PL', side: 'R', group: '費用' },
  // ── 連結固有 ──
  RECLASS_ASSET: { name: '有形固定資産（使用実態の科目）', type: 'BS', side: 'C', group: '資産' },
  RECLASS_ACC: { name: '有形固定資産減価償却累計額（使用実態の科目）', type: 'BS', side: 'C', group: '資産' },
  DEP_RECLASS: { name: '減価償却費（借手の使用部門）', type: 'PL', side: 'C', group: '費用' },
  RE_OPEN: { name: '利益剰余金期首残高', type: 'BS', side: 'C', group: '純資産' },
  NCI: { name: '非支配株主持分', type: 'BS', side: 'C', group: '純資産' },
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
  const base = names[line.acc] || ACCOUNTS[line.acc]?.name || line.acc;
  const m = line.meta || {};
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
