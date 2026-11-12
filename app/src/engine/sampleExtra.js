// テスト用の追加物件（20件：K-008〜K-027）。金額単位：千円。
// 会社の組合せ（親→子、子→親、子どうし、在外子会社、持分比率が期中に変わる子会社 S4）、
// 会計モデル（日本基準・ASC842 オペ・短期／少額の簡便法）、支払の頻度・前払／後払、段階賃料、フリーレント、
// 条件変更、中途解約、初期直接費用、適用前からの既存契約（経過措置）、長期契約を網羅する。

const lessee = (o = {}) => ({ model: 'jgaap', rate: 0.03, idc: 0, dept: 'sga', liabilityOverride: null, depMonths: null, transition: { method: 'none' }, ...o });
const lessor = (id, o = {}) => ({ assetId: id, assetCost: 0, assetLifeMonths: 0, assetStart: null, ratio: 1, incClass: 'sales', depClass: 'cogs', ...o });
const k = (id, name, lessorCo, lesseeCo, assetClass, o) => ({
  id, name, lessorCo, lesseeCo, assetClass, freePayments: 0, steps: [], terminationYm: null, terminationPenalty: 0, actuals: {}, ...o,
});

export function extraContracts() {
  return [
    k('K-008', '研究棟（S4・期中に持分比率が変動）', 'P', 'S4', 'building', {
      commencement: '2027-04', termMonths: 120, frequencyMonths: 1, timing: 'arrears', payment: 80,
      lessee: lessee({ rate: 0.025 }), lessor: lessor('A-08', { assetCost: 20000, assetLifeMonths: 360, assetStart: '2010-04' }),
    }),
    k('K-009', '生産設備（S4→S1・四半期払い）', 'S4', 'S1', 'machine', {
      commencement: '2027-07', termMonths: 60, frequencyMonths: 3, timing: 'arrears', payment: 240,
      lessee: lessee({ rate: 0.03, dept: 'mfg' }), lessor: lessor('A-09', { assetCost: 4000, assetLifeMonths: 96, assetStart: '2027-07' }),
    }),
    k('K-010', '営業車両一式（S1→S4・前払・月払い）', 'S1', 'S4', 'vehicle', {
      commencement: '2027-10', termMonths: 48, frequencyMonths: 1, timing: 'advance', payment: 15,
      lessee: lessee({ rate: 0.028 }), lessor: lessor('A-10', { assetCost: 650, assetLifeMonths: 72, assetStart: '2027-10' }),
    }),
    k('K-011', '物流センター（P→S4・段階賃料・フリーレント）', 'P', 'S4', 'building', {
      commencement: '2028-01', termMonths: 180, frequencyMonths: 1, timing: 'advance', payment: 120, freePayments: 6,
      steps: [{ fromPayment: 61, amount: 130 }, { fromPayment: 121, amount: 140 }],
      lessee: lessee({ rate: 0.022, idc: 300 }), lessor: lessor('A-11', { assetCost: 30000, assetLifeMonths: 420, assetStart: '2028-01', incClass: 'nonop', depClass: 'nonop' }),
    }),
    k('K-012', '店舗用地（P→S1・土地・長期）', 'P', 'S1', 'land', {
      commencement: '2027-04', termMonths: 240, frequencyMonths: 12, timing: 'arrears', payment: 600,
      lessee: lessee({ rate: 0.02 }), lessor: lessor('A-12', { assetCost: 9000, assetLifeMonths: 0, assetStart: '2000-04' }),
    }),
    k('K-013', '本社サーバー機器（S1→P・半年払い）', 'S1', 'P', 'tool', {
      commencement: '2027-04', termMonths: 60, frequencyMonths: 6, timing: 'arrears', payment: 90,
      lessee: lessee({ rate: 0.03 }), lessor: lessor('A-13', { assetCost: 800, assetLifeMonths: 60, assetStart: '2027-04' }),
    }),
    k('K-014', '事務機器（S4→P・少額リース）', 'S4', 'P', 'tool', {
      commencement: '2027-06', termMonths: 36, frequencyMonths: 1, timing: 'arrears', payment: 2,
      lessee: lessee({ model: 'offbalance', offKind: 'low', rate: 0 }), lessor: lessor('A-14', { assetCost: 60, assetLifeMonths: 60, assetStart: '2027-06' }),
    }),
    k('K-015', '展示会場（P→S4・短期リース）', 'P', 'S4', 'building', {
      commencement: '2028-02', termMonths: 10, frequencyMonths: 1, timing: 'advance', payment: 25,
      lessee: lessee({ model: 'offbalance', offKind: 'short', rate: 0 }), lessor: lessor('A-15', { assetCost: 3000, assetLifeMonths: 300, assetStart: '2005-04', ratio: 0.2 }),
    }),
    k('K-016', '米国倉庫（P→S3・ASC842 オペ・月払い）', 'P', 'S3', 'building', {
      commencement: '2027-10', termMonths: 84, frequencyMonths: 1, timing: 'arrears', payment: 70,
      lessee: lessee({ model: 'asc842ol', rate: 0.045 }), lessor: lessor('A-16', { assetCost: 12000, assetLifeMonths: 300, assetStart: '2015-04' }),
    }),
    k('K-017', '検査ライン（S3→S4・条件変更）', 'S3', 'S4', 'machine', {
      commencement: '2027-04', termMonths: 72, frequencyMonths: 3, timing: 'arrears', payment: 150,
      modifications: [{ ym: '2029-10', payment: 120, termMonths: 84, rate: 0.032, note: '稼働率低下による賃料減額・1年延長' }],
      lessee: lessee({ rate: 0.03, dept: 'mfg' }), lessor: lessor('A-17', { assetCost: 2500, assetLifeMonths: 120, assetStart: '2027-04' }),
    }),
    k('K-018', '社員寮（P→S2・旧科目・12月決算）', 'P', 'S2', 'building', {
      commencement: '2028-01', termMonths: 60, frequencyMonths: 1, timing: 'arrears', payment: 40,
      lessee: lessee({ rate: 0.025 }), lessor: lessor('A-18', { assetCost: 7000, assetLifeMonths: 300, assetStart: '2012-04' }),
    }),
    k('K-019', '物流トラック（S2→S4・中途解約）', 'S2', 'S4', 'vehicle', {
      commencement: '2027-04', termMonths: 60, frequencyMonths: 1, timing: 'arrears', payment: 12,
      terminationYm: '2030-06', terminationPenalty: 30,
      lessee: lessee({ rate: 0.03 }), lessor: lessor('A-19', { assetCost: 500, assetLifeMonths: 72, assetStart: '2027-04' }),
    }),
    k('K-020', '研究機器（P→S4・初期直接費用・年払い前払）', 'P', 'S4', 'machine', {
      commencement: '2028-04', termMonths: 60, frequencyMonths: 12, timing: 'advance', payment: 400,
      lessee: lessee({ rate: 0.03, idc: 80, dept: 'mfg' }), lessor: lessor('A-20', { assetCost: 1800, assetLifeMonths: 84, assetStart: '2028-04' }),
    }),
    k('K-021', '旧本社倉庫（既存契約・適用初年度の累積的影響方式）', 'P', 'S4', 'building', {
      commencement: '2023-04', termMonths: 120, frequencyMonths: 12, timing: 'arrears', payment: 900,
      lessee: lessee({ rate: 0.02, rouTransition: 'eq_liability', transitionRate: 0.021 }), lessor: lessor('A-21', { assetCost: 11000, assetLifeMonths: 360, assetStart: '2023-04' }),
    }),
    k('K-022', '工場用地（S1→S2・土地）', 'S1', 'S2', 'land', {
      commencement: '2028-04', termMonths: 120, frequencyMonths: 12, timing: 'advance', payment: 200,
      lessee: lessee({ rate: 0.022 }), lessor: lessor('A-22', { assetCost: 4000, assetLifeMonths: 0, assetStart: '2001-04' }),
    }),
    k('K-023', 'クリーンルーム（S4→S3・ASC842 オペ）', 'S4', 'S3', 'machine', {
      commencement: '2028-07', termMonths: 60, frequencyMonths: 3, timing: 'arrears', payment: 180,
      lessee: lessee({ model: 'asc842ol', rate: 0.05 }), lessor: lessor('A-23', { assetCost: 3000, assetLifeMonths: 120, assetStart: '2028-07' }),
    }),
    k('K-024', '営業所（S1→S4・既存契約・遡及測定）', 'S1', 'S4', 'building', {
      commencement: '2025-10', termMonths: 96, frequencyMonths: 1, timing: 'arrears', payment: 30,
      lessee: lessee({ rate: 0.025, rouTransition: 'retrospective', transitionRate: 0.025 }), lessor: lessor('A-24', { assetCost: 5000, assetLifeMonths: 300, assetStart: '2010-10', ratio: 0.4 }),
    }),
    k('K-025', '複合機（P→S1・少額リース・後払い）', 'P', 'S1', 'tool', {
      commencement: '2027-04', termMonths: 60, frequencyMonths: 1, timing: 'arrears', payment: 1,
      lessee: lessee({ model: 'offbalance', offKind: 'low', rate: 0 }), lessor: lessor('A-25', { assetCost: 50, assetLifeMonths: 60, assetStart: '2027-04' }),
    }),
    k('K-026', '本社ビル4階（P→S4・条件変更と中途解約）', 'P', 'S4', 'building', {
      commencement: '2027-07', termMonths: 96, frequencyMonths: 3, timing: 'advance', payment: 210,
      modifications: [{ ym: '2029-07', payment: 230, termMonths: null, rate: 0.028, note: '賃料改定' }],
      terminationYm: '2032-12', terminationPenalty: 150,
      lessee: lessee({ rate: 0.025 }), lessor: lessor('A-26', { assetCost: 16000, assetLifeMonths: 360, assetStart: '2008-04', ratio: 0.3 }),
    }),
    k('K-027', '発電設備（S4→P・長期・半年払い）', 'S4', 'P', 'machine', {
      commencement: '2028-10', termMonths: 180, frequencyMonths: 6, timing: 'arrears', payment: 500,
      lessee: lessee({ rate: 0.024, dept: 'mfg' }), lessor: lessor('A-27', { assetCost: 9000, assetLifeMonths: 240, assetStart: '2028-10' }),
    }),
  ];
}

/** 持分比率が期中に変わる子会社 S4（2027/4/1 80% 取得、2027/6/30 10% 追加取得、2029/11/20 20% 売却、2031/3/31 10% 追加取得） */
export function extraCompany() {
  return {
    code: 'S4', name: '子会社S4（持分比率が期中に変動）', fyeMonth: 3, taxRate: 0.3, nciRatio: 0.2, taxEffect: true, currency: 'JPY',
    adoption: { method: 'cumulative', ym: '2027-04' },
    ownership: [
      { date: '2027-04-01', ratio: 0.8, kind: 'acquire', deemed: 'nearest_month_end', memo: '株式の80%を取得（支配獲得）' },
      { date: '2027-06-30', ratio: 0.9, kind: 'add', deemed: 'nearest_month_end', memo: '10%を追加取得' },
      { date: '2029-11-20', ratio: 0.7, kind: 'sell', deemed: 'nearest_quarter_end', memo: '20%を一部売却（支配は継続）。みなし日は前後いずれか近い四半期末（12月末）' },
      { date: '2031-03-31', ratio: 0.8, kind: 'add', deemed: 'nearest_month_end', memo: '10%を追加取得（期末日）' },
    ],
  };
}
