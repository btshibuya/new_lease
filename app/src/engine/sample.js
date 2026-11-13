// サンプルデータ（金額単位：千円）。K-001 は要件定義書 第10章の設例と同一条件。
// K-008〜K-027 と子会社 S4（持分比率が期中に変動）はテスト用の追加物件（sampleExtra.js）、
// K-028〜K-051 と子会社 S5・S6 は第2弾の追加物件、K-052 は貸手が所有権移転外ファイナンス・リースとする契約（sampleMore.js）。
import { extraContracts, extraCompany } from './sampleExtra.js';
import { moreContracts, moreCompanies, financeLeaseContracts } from './sampleMore.js';

/** テスト物件の版（物件を追加したら上げる。保存済みのデータに未登録のテスト物件を一度だけ自動で追加するために使う） */
export const TEST_DATA_VERSION = 4; // 4：注記の収集値のテストデータを追加

export function sampleData() {
  return {
    version: 1,
    config: { unit: '千円', fyeMonth: 3, accountNames: {}, testDataVersion: TEST_DATA_VERSION },
    companies: [
      { code: 'P', name: '親会社P', isParent: true, fyeMonth: 3, taxRate: 0.3, nciRatio: 0, taxEffect: true, currency: 'JPY', adoption: { method: 'cumulative', ym: '2027-04' } },
      { code: 'S1', name: '子会社S1（100%）', fyeMonth: 3, taxRate: 0.3, nciRatio: 0, taxEffect: true, currency: 'JPY', adoption: { method: 'cumulative', ym: '2027-04' } },
      { code: 'S2', name: '子会社S2（60%・12月決算）', fyeMonth: 12, taxRate: 0.3, nciRatio: 0.4, taxEffect: true, legacyAccounts: true, splitsCurrent: false, currency: 'JPY', adoption: { method: 'cumulative', ym: '2028-01' }, history: [{ fromYm: '2030-04', taxRate: 0.31, nciRatio: 0.4 }] },
      { code: 'S3', name: '在外子会社S3（80%・US GAAP）', fyeMonth: 3, taxRate: 0.27, nciRatio: 0.2, taxEffect: true, currency: 'JPY', adoption: { method: 'applied', ym: '2019-04' } },
      extraCompany(),
      ...moreCompanies(),
    ],
    contracts: [
      {
        id: 'K-001', name: '本社ビル3階（設例）', lessorCo: 'P', lesseeCo: 'S1', assetClass: 'building',
        commencement: '2027-04', termMonths: 60, frequencyMonths: 12, timing: 'arrears', payment: 1000, freePayments: 0, steps: [],
        terminationYm: null,
        lessee: { model: 'jgaap', rate: 0.03, idc: 0, dept: 'sga', liabilityOverride: null, depMonths: null, transition: { method: 'none' } },
        lessor: { assetId: 'A-01', assetCost: 6000, assetLifeMonths: 120, assetStart: '2027-04', ratio: 1, incClass: 'sales', depClass: 'cogs' },
        actuals: { '2028-03': { L: 3717, rouNet: 3664, inc: 1000 } },
      },
      {
        id: 'K-002', name: '第二工場建屋（フリーレント・前払・初期直接費用）', lessorCo: 'P', lesseeCo: 'S2', assetClass: 'building',
        commencement: '2027-04', termMonths: 36, frequencyMonths: 1, timing: 'advance', payment: 50, freePayments: 3, steps: [{ fromPayment: 25, amount: 55 }],
        terminationYm: null,
        lessee: { model: 'jgaap', rate: 0.025, idc: 120, dept: 'mfg', liabilityOverride: null, depMonths: null, transition: { method: 'none' } },
        lessor: { assetId: 'A-02', assetCost: 30000, assetLifeMonths: 360, assetStart: '2015-04', ratio: 0.5, incClass: 'nonop', depClass: 'nonop' },
        actuals: {},
      },
      {
        id: 'K-003', name: '社用車（短期リース・借手簡便法）', lessorCo: 'S1', lesseeCo: 'P', assetClass: 'vehicle',
        commencement: '2027-10', termMonths: 12, frequencyMonths: 1, timing: 'arrears', payment: 20, freePayments: 0, steps: [],
        terminationYm: null,
        lessee: { model: 'offbalance', rate: 0, idc: 0, dept: 'sga', liabilityOverride: null, depMonths: null, transition: { method: 'none' } },
        lessor: { assetId: 'A-03', assetCost: 900, assetLifeMonths: 72, assetStart: '2027-10', ratio: 1, incClass: 'sales', depClass: 'cogs' },
        actuals: {},
      },
      {
        id: 'K-004', name: '物流倉庫（在外子会社・ASC842オペ）', lessorCo: 'P', lesseeCo: 'S3', assetClass: 'building',
        commencement: '2027-07', termMonths: 48, frequencyMonths: 3, timing: 'arrears', payment: 300, freePayments: 0, steps: [],
        terminationYm: null,
        lessee: { model: 'asc842ol', rate: 0.04, idc: 0, dept: 'sga', liabilityOverride: null, depMonths: null, transition: { method: 'none' } },
        lessor: { assetId: 'A-04', assetCost: 8000, assetLifeMonths: 240, assetStart: '2020-04', ratio: 1, incClass: 'sales', depClass: 'cogs' },
        actuals: {},
      },
      {
        id: 'K-005', name: '本社ビル2階（既存契約・適用初年度の累積的影響方式）', lessorCo: 'P', lesseeCo: 'S1', assetClass: 'building',
        commencement: '2024-04', termMonths: 120, frequencyMonths: 12, timing: 'arrears', payment: 2400, freePayments: 0, steps: [],
        terminationYm: null,
        lessee: { model: 'jgaap', rate: 0.02, idc: 0, dept: 'sga', liabilityOverride: null, depMonths: null, transition: { method: 'none' }, rouTransition: 'eq_liability', transitionRate: 0.02 },
        lessor: { assetId: 'A-05', assetCost: 15000, assetLifeMonths: 300, assetStart: '2024-04', ratio: 1, incClass: 'sales', depClass: 'cogs' },
        actuals: {},
      },
      {
        id: 'K-006', name: '検査装置（中途解約）', lessorCo: 'P', lesseeCo: 'S2', assetClass: 'machine',
        commencement: '2027-04', termMonths: 60, frequencyMonths: 1, timing: 'arrears', payment: 30, freePayments: 0, steps: [],
        terminationYm: '2029-09', terminationPenalty: 60,
        lessee: { model: 'jgaap', rate: 0.03, idc: 0, dept: 'mfg', liabilityOverride: null, depMonths: null, transition: { method: 'none' } },
        lessor: { assetId: 'A-06', assetCost: 2000, assetLifeMonths: 96, assetStart: '2027-04', ratio: 1, incClass: 'sales', depClass: 'cogs' },
        actuals: {},
      },
      {
        id: 'K-007', name: '倉庫設備（条件変更・貸手のリース期間が短い）', lessorCo: 'P', lesseeCo: 'S1', assetClass: 'machine',
        commencement: '2027-04', termMonths: 60, frequencyMonths: 12, timing: 'arrears', payment: 500, freePayments: 0, steps: [],
        terminationYm: null, terminationPenalty: 0,
        modifications: [{ ym: '2029-04', payment: 600, termMonths: 72, rate: 0.035, note: '3年目期首に賃料改定・1年延長' }],
        lessee: { model: 'jgaap', rate: 0.03, idc: 0, dept: 'sga', liabilityOverride: null, depMonths: null, transition: { method: 'none' } },
        lessor: { assetId: 'A-07', assetCost: 3000, assetLifeMonths: 120, assetStart: '2027-04', ratio: 1, incClass: 'sales', depClass: 'cogs', termMonths: 48 },
        actuals: {},
      },
      ...extraContracts(),
      ...moreContracts(),
      ...financeLeaseContracts(),
    ],
    notes: {},
    manualJournals: [],
    locks: [],
    checkNotes: {},
    auditLog: [],
    auditAnchor: '',
  };
}
