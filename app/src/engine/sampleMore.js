// テスト用の追加物件（第2弾：K-028〜K-051 の24件）と子会社 S5・S6。金額単位：千円。
// 第1弾（sampleExtra.js：K-008〜K-027）で網羅していないパターンを補う：
//  当初リース負債の取込値、償却月数の指定、法人税法上のリース取引、範囲縮小（期間短縮）、複数回の条件変更、
//  ASC842 の条件変更＋中途解約、短期リースの中途解約、後払のフリーレント、支払額の手修正、実績との突合、
//  同じ貸手資産を2契約で按分、償却済み・取得原価なしの貸手資産、適用時の割引率の相違、在外子会社が貸手、
//  完全遡及の会社、繰延税金資産の計上割合・税率変更、個別で税効果なしの会社、12月決算の子会社の持分変動
//  （決算日・適用開始月の指定・四半期末のみなし日）、適用開始前に終了した契約、1か月の契約、少額リースの条件変更。

const lessee = (o = {}) => ({ model: 'jgaap', rate: 0.03, idc: 0, dept: 'sga', liabilityOverride: null, depMonths: null, transition: { method: 'none' }, ...o });
const lessor = (id, o = {}) => ({ assetId: id, assetCost: 0, assetLifeMonths: 0, assetStart: null, ratio: 1, incClass: 'sales', depClass: 'cogs', ...o });
const k = (id, name, lessorCo, lesseeCo, assetClass, o) => ({
  id, name, lessorCo, lesseeCo, assetClass, freePayments: 0, steps: [], terminationYm: null, terminationPenalty: 0, actuals: {}, ...o,
});

export function moreCompanies() {
  return [
    {
      code: 'S5', name: '子会社S5（12月決算・持分変動・個別税効果なし）', fyeMonth: 12, taxRate: 0.3, nciRatio: 0.3, taxEffect: false, currency: 'JPY',
      adoption: { method: 'cumulative', ym: '2028-01' },
      ownership: [
        { date: '2026-12-31', ratio: 0.7, kind: 'acquire', deemed: 'nearest_fy_end', memo: '70%を取得（決算日に取得）' },
        { date: '2028-08-10', ratio: 0.6, kind: 'sell', deemed: 'month', effYm: '2028-10', memo: '10%を売却。資本連結に合わせて2028年10月から適用（適用開始月を指定）' },
        { date: '2030-02-14', ratio: 0.75, kind: 'add', deemed: 'nearest_quarter_end', memo: '15%を追加取得。前後の四半期末が等距離のため前の12月末をみなし日とする' },
      ],
    },
    {
      code: 'S6', name: '子会社S6（完全遡及・繰延税金資産50%・税率変更）', fyeMonth: 3, taxRate: 0.35, nciRatio: 0.25, taxEffect: true, dtaRatio: 0.5, currency: 'JPY',
      adoption: { method: 'retrospective', ym: '2027-04' },
      history: [{ fromYm: '2029-04', taxRate: 0.32, nciRatio: 0.25 }],
    },
  ];
}

export function moreContracts() {
  return [
    k('K-028', '加工機（当初リース負債の取込値）', 'P', 'S5', 'machine', {
      commencement: '2028-01', termMonths: 60, frequencyMonths: 1, timing: 'arrears', payment: 40,
      lessee: lessee({ rate: 0.03, dept: 'mfg', liabilityOverride: 2230 }), lessor: lessor('A-28', { assetCost: 2600, assetLifeMonths: 96, assetStart: '2028-01' }),
    }),
    k('K-029', '試験設備（償却月数をリース期間より短く指定）', 'S5', 'S1', 'machine', {
      commencement: '2028-04', termMonths: 60, frequencyMonths: 3, timing: 'arrears', payment: 120,
      lessee: lessee({ rate: 0.028, depMonths: 48, dept: 'mfg' }), lessor: lessor('A-29', { assetCost: 2000, assetLifeMonths: 72, assetStart: '2028-04' }),
    }),
    k('K-030', '研修センター（完全遡及の会社・既存契約・前払）', 'P', 'S6', 'building', {
      commencement: '2024-10', termMonths: 96, frequencyMonths: 1, timing: 'advance', payment: 60,
      lessee: lessee({ rate: 0.025 }), lessor: lessor('A-30', { assetCost: 9000, assetLifeMonths: 360, assetStart: '2009-04' }),
    }),
    k('K-031', '営業用トラック（法人税法上のリース取引）', 'S6', 'P', 'vehicle', {
      commencement: '2027-07', termMonths: 60, frequencyMonths: 1, timing: 'arrears', payment: 18,
      lessee: lessee({ rate: 0.03, taxLease: true }), lessor: lessor('A-31', { assetCost: 950, assetLifeMonths: 60, assetStart: '2027-07' }),
    }),
    k('K-032', '梱包ライン（範囲縮小：期間を短縮）', 'P', 'S1', 'machine', {
      commencement: '2027-04', termMonths: 72, frequencyMonths: 3, timing: 'arrears', payment: 90,
      modifications: [{ ym: '2029-04', payment: null, termMonths: 48, rate: null, note: '工場統合により2年短縮（範囲の縮小）' }],
      lessee: lessee({ rate: 0.03, dept: 'mfg' }), lessor: lessor('A-32', { assetCost: 1800, assetLifeMonths: 96, assetStart: '2027-04' }),
    }),
    k('K-033', '倉庫棟（複数回の条件変更）', 'P', 'S2', 'building', {
      commencement: '2028-01', termMonths: 60, frequencyMonths: 1, timing: 'arrears', payment: 70,
      modifications: [
        { ym: '2028-10', payment: 75, termMonths: null, rate: 0.03, note: '賃料改定' },
        { ym: '2030-04', payment: 80, termMonths: 84, rate: 0.032, note: '賃料改定と2年延長' },
      ],
      lessee: lessee({ rate: 0.025 }), lessor: lessor('A-33', { assetCost: 12000, assetLifeMonths: 360, assetStart: '2010-04' }),
    }),
    k('K-034', '米国工場設備（ASC842・条件変更のあと中途解約）', 'P', 'S3', 'machine', {
      commencement: '2027-07', termMonths: 72, frequencyMonths: 3, timing: 'advance', payment: 200,
      modifications: [{ ym: '2029-07', payment: 220, termMonths: null, rate: 0.05, note: '賃料改定' }],
      terminationYm: '2031-06', terminationPenalty: 100,
      lessee: lessee({ model: 'asc842ol', rate: 0.045 }), lessor: lessor('A-34', { assetCost: 4000, assetLifeMonths: 120, assetStart: '2027-07' }),
    }),
    k('K-035', '計測器（短期リースを中途解約）', 'S1', 'S3', 'tool', {
      commencement: '2028-01', termMonths: 11, frequencyMonths: 1, timing: 'arrears', payment: 8,
      terminationYm: '2028-06', terminationPenalty: 5,
      lessee: lessee({ model: 'offbalance', offKind: 'short', rate: 0 }), lessor: lessor('A-35', { assetCost: 120, assetLifeMonths: 60, assetStart: '2028-01' }),
    }),
    k('K-036', '冷凍倉庫（後払のフリーレント・四半期払い）', 'S2', 'S1', 'building', {
      commencement: '2028-04', termMonths: 60, frequencyMonths: 3, timing: 'arrears', payment: 150, freePayments: 2,
      lessee: lessee({ rate: 0.027 }), lessor: lessor('A-36', { assetCost: 6000, assetLifeMonths: 300, assetStart: '2016-04' }),
    }),
    k('K-037', '本社ビル5階（支払額の手修正）', 'P', 'S1', 'building', {
      commencement: '2027-04', termMonths: 36, frequencyMonths: 1, timing: 'arrears', payment: 50,
      paymentOverrides: [{ ym: '2028-01', amount: 30, reason: '空調工事期間の賃料減額（合意書）' }, { ym: '2028-02', amount: 30, reason: '空調工事期間の賃料減額（合意書）' }],
      lessee: lessee({ rate: 0.025 }), lessor: lessor('A-37', { assetCost: 8000, assetLifeMonths: 300, assetStart: '2012-04', ratio: 0.1 }),
    }),
    k('K-038', '物流センター別棟（個別の帳簿残高との突合）', 'P', 'S6', 'building', {
      commencement: '2027-04', termMonths: 60, frequencyMonths: 3, timing: 'arrears', payment: 120,
      lessee: lessee({ rate: 0.03 }), lessor: lessor('A-38', { assetCost: 5000, assetLifeMonths: 300, assetStart: '2014-04' }),
      // 実績は個別帳簿の残高（アプリの計算値と一致する例。CHK-10 で突合）
      actuals: { '2027-12': { L: 1909, cur: 428 }, '2028-03': { L: 1803, rouNet: 1777, inc: 480, R: 0 } },
    }),
    k('K-039', '共用倉庫A区画（同じ貸手資産を2契約で按分・60%）', 'P', 'S1', 'building', {
      commencement: '2027-10', termMonths: 48, frequencyMonths: 1, timing: 'arrears', payment: 36,
      lessee: lessee({ rate: 0.025 }), lessor: lessor('A-39', { assetCost: 10000, assetLifeMonths: 360, assetStart: '2011-04', ratio: 0.6 }),
    }),
    k('K-040', '共用倉庫B区画（同じ貸手資産を2契約で按分・40%）', 'P', 'S5', 'building', {
      commencement: '2028-01', termMonths: 36, frequencyMonths: 1, timing: 'arrears', payment: 24,
      lessee: lessee({ rate: 0.026 }), lessor: lessor('A-39', { assetCost: 10000, assetLifeMonths: 360, assetStart: '2011-04', ratio: 0.4 }),
    }),
    k('K-041', '旧工場（貸手資産は償却済み）', 'P', 'S1', 'building', {
      commencement: '2027-04', termMonths: 36, frequencyMonths: 12, timing: 'advance', payment: 150,
      lessee: lessee({ rate: 0.02, dept: 'mfg' }), lessor: lessor('A-41', { assetCost: 4000, assetLifeMonths: 240, assetStart: '1995-04' }),
    }),
    k('K-042', '駐車場（貸手は転借・資産の取得原価なし）', 'P', 'S6', 'land', {
      commencement: '2027-04', termMonths: 60, frequencyMonths: 1, timing: 'arrears', payment: 5,
      lessee: lessee({ rate: 0.02 }), lessor: lessor('', { assetCost: 0 }),
    }),
    k('K-043', '事務所什器（既存契約・適用時の割引率が契約時と異なる）', 'S1', 'S2', 'tool', {
      commencement: '2025-07', termMonths: 60, frequencyMonths: 1, timing: 'arrears', payment: 10,
      lessee: lessee({ rate: 0.04, rouTransition: 'eq_liability', transitionRate: 0.025 }), lessor: lessor('A-43', { assetCost: 520, assetLifeMonths: 72, assetStart: '2025-07' }),
    }),
    k('K-044', '国内倉庫（在外子会社が貸手・営業外・貸手のリース期間が短い）', 'S3', 'P', 'building', {
      commencement: '2027-10', termMonths: 60, frequencyMonths: 1, timing: 'arrears', payment: 45,
      lessee: lessee({ rate: 0.026 }), lessor: lessor('A-44', { assetCost: 7000, assetLifeMonths: 300, assetStart: '2017-10', incClass: 'nonop', depClass: 'nonop', termMonths: 48 }),
    }),
    k('K-045', '検査棟（四半期払い前払・違約金なしの中途解約）', 'P', 'S5', 'building', {
      commencement: '2028-07', termMonths: 60, frequencyMonths: 3, timing: 'advance', payment: 100,
      terminationYm: '2031-12', terminationPenalty: 0,
      lessee: lessee({ rate: 0.028 }), lessor: lessor('A-45', { assetCost: 6000, assetLifeMonths: 300, assetStart: '2013-04' }),
    }),
    k('K-046', '物流機器（持分が変動する子会社どうし・半年払い前払）', 'S5', 'S4', 'machine', {
      commencement: '2028-04', termMonths: 72, frequencyMonths: 6, timing: 'advance', payment: 260,
      lessee: lessee({ rate: 0.03, dept: 'mfg' }), lessor: lessor('A-46', { assetCost: 2900, assetLifeMonths: 96, assetStart: '2028-04' }),
    }),
    k('K-047', '催事用設備（1か月の短期リース）', 'P', 'S1', 'tool', {
      commencement: '2028-12', termMonths: 1, frequencyMonths: 1, timing: 'advance', payment: 15,
      lessee: lessee({ model: 'offbalance', offKind: 'short', rate: 0 }), lessor: lessor('A-47', { assetCost: 300, assetLifeMonths: 60, assetStart: '2026-04' }),
    }),
    k('K-048', '仮設事務所（適用開始前に終了した契約）', 'P', 'S2', 'building', {
      commencement: '2025-04', termMonths: 24, frequencyMonths: 1, timing: 'arrears', payment: 20,
      lessee: lessee({ rate: 0.02 }), lessor: lessor('A-48', { assetCost: 1500, assetLifeMonths: 120, assetStart: '2020-04' }),
    }),
    k('K-049', '工場本棟（年払い前払・段階賃料・初期直接費用・製造部門・長期）', 'P', 'S1', 'building', {
      commencement: '2027-04', termMonths: 120, frequencyMonths: 12, timing: 'advance', payment: 1200,
      steps: [{ fromPayment: 4, amount: 1260 }, { fromPayment: 8, amount: 1320 }],
      lessee: lessee({ rate: 0.022, idc: 200, dept: 'mfg' }), lessor: lessor('A-49', { assetCost: 40000, assetLifeMonths: 480, assetStart: '2027-04' }),
    }),
    k('K-050', '社員寮（持分変動の子会社が貸手・前払フリーレント・段階賃料）', 'S4', 'S6', 'building', {
      commencement: '2027-10', termMonths: 48, frequencyMonths: 1, timing: 'advance', payment: 22, freePayments: 1,
      steps: [{ fromPayment: 25, amount: 24 }],
      lessee: lessee({ rate: 0.025 }), lessor: lessor('A-50', { assetCost: 3000, assetLifeMonths: 300, assetStart: '2015-10' }),
    }),
    k('K-051', 'タブレット端末（少額リースの条件変更）', 'P', 'S1', 'tool', {
      commencement: '2027-04', termMonths: 48, frequencyMonths: 1, timing: 'arrears', payment: 3,
      modifications: [{ ym: '2029-04', payment: 4, termMonths: null, rate: null, note: '台数追加' }],
      lessee: lessee({ model: 'offbalance', offKind: 'low', rate: 0 }), lessor: lessor('A-51', { assetCost: 140, assetLifeMonths: 48, assetStart: '2027-04' }),
    }),
  ];
}
