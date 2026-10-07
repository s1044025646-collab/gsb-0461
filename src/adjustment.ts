import {
  ADJUSTED_COORD_TOLERANCE,
  RULE_VERSION,
  ValidatedEdge,
  ValidatedObservation,
  azimuthFromDelta,
} from "./geometry.js";

export interface PointResult {
  seq: number;
  code: string;
  /** 该点是否为闭合终点（与起点同点但保留独立编号） */
  isClosure: boolean;
  eOriginal: number;
  nOriginal: number;
  eAdjusted: number;
  nAdjusted: number;
  /** 该坐标由哪些边累计得到（来源链） */
  derivedFromEdges: number[];
}

export interface EdgeResult {
  seq: number;
  code: string;
  fromPoint: string;
  toPoint: string;
  length: number;
  azimuthRaw: number;
  azimuth: number;
  dEOriginal: number;
  dNOriginal: number;
  /** 边长权重 Li/P */
  weight: number;
  cE: number;
  cN: number;
  dEAdjusted: number;
  dNAdjusted: number;
  /** 由调整后增量反算（非复制原观测） */
  lengthAdjusted: number;
  azimuthAdjusted: number | null;
  azimuthAdjustedReason: string | null;
}

export type RawQualityStatus = "CLOSED" | "WITHIN_TOLERANCE" | "EXCEEDS_LIMIT";
export type AdjustStatus = "ADJUSTED_CLOSED" | "ADJUSTED_WITHIN_TOLERANCE" | "ADJUSTMENT_FAILED";

export interface AdjustmentReport {
  ruleVersion: string;
  tolerance: number;
  start: { e: number; n: number };
  closure: {
    fE: number;
    fN: number;
    f: number;
    perimeter: number;
    relativeClosure: number | null;
    closureRatioOneIn: number | null;
    rawQualityStatus: RawQualityStatus;
    maxRelativeClosure: number | null;
    limitPassed: boolean | null;
  };
  correctionSummary: {
    sumCE: number;
    sumCN: number;
    cancelsFE: boolean;
    cancelsFN: boolean;
    residualFE: number;
    residualFN: number;
  };
  adjustment: {
    status: AdjustStatus;
    finalE: number;
    finalN: number;
    residualE: number;
    residualN: number;
    residual: number;
  };
  points: PointResult[];
  edges: EdgeResult[];
}

function round6(x: number): number {
  return Object.is(x, -0) ? 0 : x;
}

/**
 * Bowditch 闭合导线平差。
 * cEi = -fE * Li / P，cNi = -fN * Li / P，两个分量分别按边长权重分配。
 */
export function computeAdjustment(obs: ValidatedObservation): AdjustmentReport {
  const edges: ValidatedEdge[] = obs.edges;
  const n = edges.length;
  const perimeter = edges.reduce((s, e) => s + e.length, 0);

  // 原始坐标累计（按给定顺序，不按名称排序）
  const eOrig = new Array<number>(n + 1);
  const nOrig = new Array<number>(n + 1);
  eOrig[0] = obs.startE;
  nOrig[0] = obs.startN;
  let sumDE = 0;
  let sumDN = 0;
  for (let i = 0; i < n; i++) {
    sumDE += edges[i].dE;
    sumDN += edges[i].dN;
    eOrig[i + 1] = obs.startE + sumDE;
    nOrig[i + 1] = obs.startN + sumDN;
  }

  // 闭合差 = 原始末点 - 起点
  const fE = sumDE;
  const fN = sumDN;
  const f = Math.hypot(fE, fN);

  // 逐边改正与调整后增量
  const edgeResults: EdgeResult[] = [];
  const eAdj = new Array<number>(n + 1);
  const nAdj = new Array<number>(n + 1);
  eAdj[0] = obs.startE;
  nAdj[0] = obs.startN;
  let sumCE = 0;
  let sumCN = 0;
  let adjDE = 0;
  let adjDN = 0;

  for (let i = 0; i < n; i++) {
    const e = edges[i];
    const weight = e.length / perimeter;
    const cE = (-fE * e.length) / perimeter;
    const cN = (-fN * e.length) / perimeter;
    sumCE += cE;
    sumCN += cN;
    const dEA = e.dE + cE;
    const dNA = e.dN + cN;
    adjDE += dEA;
    adjDN += dNA;
    eAdj[i + 1] = obs.startE + adjDE;
    nAdj[i + 1] = obs.startN + adjDN;

    const lengthAdjusted = Math.hypot(dEA, dNA);
    let azAdjusted: number | null = null;
    let azReason: string | null = null;
    const az = azimuthFromDelta(dEA, dNA);
    if (az === undefined) {
      azReason = "调整后东、北增量均为零（零长度边），方位角未定义";
    } else {
      azAdjusted = az;
    }

    edgeResults.push({
      seq: e.seq,
      code: e.code,
      fromPoint: e.fromPoint,
      toPoint: e.toPoint,
      length: e.length,
      azimuthRaw: e.azimuthRaw,
      azimuth: e.azimuth,
      dEOriginal: round6(e.dE),
      dNOriginal: round6(e.dN),
      weight,
      cE: round6(cE),
      cN: round6(cN),
      dEAdjusted: round6(dEA),
      dNAdjusted: round6(dNA),
      lengthAdjusted,
      azimuthAdjusted: azAdjusted,
      azimuthAdjustedReason: azReason,
    });
  }

  const finalE = obs.startE + adjDE;
  const finalN = obs.startN + adjDN;
  const residualE = finalE - obs.startE;
  const residualN = finalN - obs.startN;
  const residual = Math.hypot(residualE, residualN);

  // 原始相对闭合质量
  const relativeClosure = f / perimeter;
  const ratioOneIn = f > 0 ? perimeter / f : null;
  let rawStatus: RawQualityStatus;
  if (f === 0) {
    rawStatus = "CLOSED";
  } else if (f <= obs.tolerance) {
    rawStatus = "WITHIN_TOLERANCE";
  } else {
    rawStatus = "EXCEEDS_LIMIT";
  }
  let limitPassed: boolean | null = null;
  if (obs.maxRelativeClosure !== null) {
    limitPassed = relativeClosure <= obs.maxRelativeClosure;
    // 注意：即使坐标数学上闭合，门槛判断也只针对原始观测；f=0 时 ratio=0，自然通过
  }

  let adjustStatus: AdjustStatus;
  if (residual === 0) {
    adjustStatus = "ADJUSTED_CLOSED";
  } else if (residual <= obs.tolerance) {
    adjustStatus = "ADJUSTED_WITHIN_TOLERANCE";
  } else {
    adjustStatus = "ADJUSTMENT_FAILED";
  }

  const points: PointResult[] = [];
  for (let i = 0; i <= n; i++) {
    points.push({
      seq: i,
      code: i === 0 ? "P0（起点）" : `P${i}`,
      isClosure: i === n,
      eOriginal: round6(eOrig[i]),
      nOriginal: round6(nOrig[i]),
      eAdjusted: round6(eAdj[i]),
      nAdjusted: round6(nAdj[i]),
      derivedFromEdges: Array.from({ length: i }, (_, k) => k + 1),
    });
  }

  const tol = ADJUSTED_COORD_TOLERANCE;

  return {
    ruleVersion: RULE_VERSION,
    tolerance: obs.tolerance,
    start: { e: obs.startE, n: obs.startN },
    closure: {
      fE: round6(fE),
      fN: round6(fN),
      f,
      perimeter,
      relativeClosure,
      closureRatioOneIn: ratioOneIn,
      rawQualityStatus: rawStatus,
      maxRelativeClosure: obs.maxRelativeClosure,
      limitPassed,
    },
    correctionSummary: {
      sumCE: round6(sumCE),
      sumCN: round6(sumCN),
      cancelsFE: Math.abs(sumCE + fE) <= tol,
      cancelsFN: Math.abs(sumCN + fN) <= tol,
      residualFE: round6(sumCE + fE),
      residualFN: round6(sumCN + fN),
    },
    adjustment: {
      status: adjustStatus,
      finalE: round6(finalE),
      finalN: round6(finalN),
      residualE: round6(residualE),
      residualN: round6(residualN),
      residual,
    },
    points,
    edges: edgeResults,
  };
}
