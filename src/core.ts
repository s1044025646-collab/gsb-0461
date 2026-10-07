// Bowditch 闭合导线平差核心计算与输入校验。
// 坐标系: E 东 / N 北, 单位米; 方位角: 正北为 0, 顺时针增加, 规范到 [0,360)。

export const RULES_VERSION = "bowditch-1.0.0";

// 公开数值容差: 判断"完全闭合 / 调整后终点回到起点"的阈值。
export const ABS_TOL = 1e-9; // 米, 绝对项
export const REL_TOL = 1e-12; // 相对周长项

// 输入范围限制, 避免数值溢出。
export const MIN_EDGES = 3;
export const MAX_EDGES = 1000;
export const MAX_COORD = 1e9; // |E|,|N| 上限 (米)
export const MAX_LENGTH = 1e6; // 单边长度上限 (米)

export interface EdgeInput {
  length: number;
  azimuth: number; // 度, 任意有限值, 内部规范化
}

export interface TraverseInput {
  startE: number;
  startN: number;
  edges: EdgeInput[];
  maxRelativeClosure?: number | null; // 允许的最大相对闭合差 f/P
}

export type ErrorCode =
  | "INVALID_START"
  | "EDGE_COUNT"
  | "INVALID_LENGTH"
  | "INVALID_AZIMUTH"
  | "INVALID_THRESHOLD"
  | "NOT_FOUND"
  | "BAD_REQUEST";

export class TraverseError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) {
    super(message);
  }
}

export function normalizeAzimuth(deg: number): number {
  let a = deg % 360;
  if (a < 0) a += 360;
  // 避免 -0 与 360 边界
  if (a >= 360 || Object.is(a, -0)) a = 0;
  return a;
}

export function closureTolerance(perimeter: number): number {
  return ABS_TOL + REL_TOL * perimeter;
}

export function validateInput(input: TraverseInput): void {
  const { startE, startN, edges, maxRelativeClosure } = input;
  if (!Number.isFinite(startE) || !Number.isFinite(startN)) {
    throw new TraverseError("INVALID_START", "起点坐标必须为有限数");
  }
  if (Math.abs(startE) > MAX_COORD || Math.abs(startN) > MAX_COORD) {
    throw new TraverseError("INVALID_START", `起点坐标超出允许范围 ±${MAX_COORD} 米`);
  }
  if (!Array.isArray(edges) || edges.length < MIN_EDGES || edges.length > MAX_EDGES) {
    throw new TraverseError("EDGE_COUNT", `边数必须在 ${MIN_EDGES} 到 ${MAX_EDGES} 之间`);
  }
  let perimeter = 0;
  edges.forEach((e, i) => {
    if (!e || !Number.isFinite(e.length) || e.length <= 0) {
      throw new TraverseError("INVALID_LENGTH", `第 ${i + 1} 边长度必须为正且有限`, { index: i });
    }
    if (e.length > MAX_LENGTH) {
      throw new TraverseError("INVALID_LENGTH", `第 ${i + 1} 边长度超过上限 ${MAX_LENGTH} 米`, { index: i });
    }
    if (!Number.isFinite(e.azimuth)) {
      throw new TraverseError("INVALID_AZIMUTH", `第 ${i + 1} 边方位角必须为有限度数`, { index: i });
    }
    perimeter += e.length;
  });
  if (!Number.isFinite(perimeter) || perimeter <= 0) {
    throw new TraverseError("INVALID_LENGTH", "周长非法");
  }
  if (maxRelativeClosure !== undefined && maxRelativeClosure !== null) {
    if (!Number.isFinite(maxRelativeClosure) || maxRelativeClosure <= 0) {
      throw new TraverseError("INVALID_THRESHOLD", "最大相对闭合差必须为正且有限");
    }
  }
}

export interface AdjustedEdge {
  seq: number; // 稳定编号, 从 1 开始
  length: number;
  azimuth: number; // 规范化后的观测方位角
  dE: number;
  dN: number;
  weight: number; // Li/P
  corrE: number; // cEi = -fE*Li/P
  corrN: number;
  adjDE: number;
  adjDN: number;
  adjLength: number; // 由调整后增量重算
  adjAzimuth: number | null; // 由调整后增量重算; 零长度边为 null
  adjAzimuthNote: string | null;
}

export interface AdjustedPoint {
  seq: number; // 0..n, 0 与 n 都是起点(不合并)
  rawE: number;
  rawN: number;
  adjE: number;
  adjN: number;
}

export interface TraverseResult {
  rulesVersion: string;
  tolerance: number;
  start: { E: number; N: number };
  perimeter: number;
  fE: number;
  fN: number;
  f: number;
  relativeClosure: number; // f/P
  relativeRatio: number | null; // P/f, f 为 0 或容差内时为 null
  relativeRatioText: string | null; // "1 : xxx"
  rawStatus: "CLOSED" | "CLOSED_WITHIN_TOLERANCE" | "OPEN";
  quality: "PASS" | "FAIL" | "UNRATED"; // 依据用户提供门槛判定原始观测
  maxRelativeClosure: number | null;
  closurePassed: boolean | null;
  corrSumE: number; // 应等于 -fE
  corrSumN: number;
  adjEndResidualE: number; // 调整后终点-起点, 应在容差内
  adjEndResidualN: number;
  edges: AdjustedEdge[];
  points: AdjustedPoint[];
}

export function computeTraverse(input: TraverseInput): TraverseResult {
  validateInput(input);
  const { startE, startN } = input;
  const maxRel = input.maxRelativeClosure ?? null;

  const n = input.edges.length;
  const lengths = input.edges.map((e) => e.length);
  const azimuths = input.edges.map((e) => normalizeAzimuth(e.azimuth));
  const perimeter = lengths.reduce((s, v) => s + v, 0);
  const tol = closureTolerance(perimeter);

  const dE = azimuths.map((a, i) => lengths[i] * Math.sin((a * Math.PI) / 180));
  const dN = azimuths.map((a, i) => lengths[i] * Math.cos((a * Math.PI) / 180));
  const fE = dE.reduce((s, v) => s + v, 0);
  const fN = dN.reduce((s, v) => s + v, 0);
  const f = Math.hypot(fE, fN);
  const relativeClosure = f / perimeter;

  // Bowditch: 按边长权重分配, 两个分量分别分配
  const corrE = lengths.map((L) => (-fE * L) / perimeter);
  const corrN = lengths.map((L) => (-fN * L) / perimeter);
  const adjDE = dE.map((v, i) => v + corrE[i]);
  const adjDN = dN.map((v, i) => v + corrN[i]);

  const edges: AdjustedEdge[] = lengths.map((L, i) => {
    const aL = Math.hypot(adjDE[i], adjDN[i]);
    let aA: number | null = null;
    let note: string | null = null;
    if (aL <= tol) {
      note = "调整后边退化为零长度, 方位角未定义";
    } else {
      aA = normalizeAzimuth((Math.atan2(adjDE[i], adjDN[i]) * 180) / Math.PI);
    }
    return {
      seq: i + 1,
      length: L,
      azimuth: azimuths[i],
      dE: dE[i],
      dN: dN[i],
      weight: L / perimeter,
      corrE: corrE[i],
      corrN: corrN[i],
      adjDE: adjDE[i],
      adjDN: adjDN[i],
      adjLength: aL,
      adjAzimuth: aA,
      adjAzimuthNote: note,
    };
  });

  const points: AdjustedPoint[] = [];
  let rawE = startE, rawN = startN, adjE = startE, adjN = startN;
  points.push({ seq: 0, rawE, rawN, adjE, adjN });
  for (let i = 0; i < n; i++) {
    rawE += dE[i]; rawN += dN[i];
    adjE += adjDE[i]; adjN += adjDN[i];
    points.push({ seq: i + 1, rawE, rawN, adjE, adjN });
  }

  const corrSumE = corrE.reduce((s, v) => s + v, 0);
  const corrSumN = corrN.reduce((s, v) => s + v, 0);
  const adjEndResidualE = adjE - startE;
  const adjEndResidualN = adjN - startN;

  let rawStatus: TraverseResult["rawStatus"];
  if (f === 0) rawStatus = "CLOSED";
  else if (f <= tol) rawStatus = "CLOSED_WITHIN_TOLERANCE";
  else rawStatus = "OPEN";

  let quality: TraverseResult["quality"] = "UNRATED";
  let closurePassed: boolean | null = null;
  if (maxRel !== null) {
    closurePassed = relativeClosure <= maxRel;
    quality = closurePassed ? "PASS" : "FAIL";
  }

  const showRatio = f > tol;
  const relativeRatio = showRatio ? perimeter / f : null;

  return {
    rulesVersion: RULES_VERSION,
    tolerance: tol,
    start: { E: startE, N: startN },
    perimeter,
    fE, fN, f,
    relativeClosure,
    relativeRatio,
    relativeRatioText: relativeRatio === null ? null : `1 : ${Math.round(relativeRatio)}`,
    rawStatus,
    quality,
    maxRelativeClosure: maxRel,
    closurePassed,
    corrSumE,
    corrSumN,
    adjEndResidualE,
    adjEndResidualN,
    edges,
    points,
  };
}
