import { AppError } from "./errors.js";

/** 规则版本：任何核心算法/校验口径变更都应提升此版本号。 */
export const RULE_VERSION = "bowditch-2026.1";

/** 调整后终点与起点允许的最大坐标差（米），公开数值容差。 */
export const ADJUSTED_COORD_TOLERANCE = 1e-6;

/** 输入校验范围（防止数值溢出）。 */
export const LIMITS = {
  minEdges: 3,
  maxEdges: 1000,
  minLength: 0,
  lengthExclusive: true, // 边长必须严格为正
  maxLength: 1e7,
  maxAbsCoord: 1e9,
  maxAbsAngle: 1e9,
} as const;

export interface EdgeInput {
  /** 稳定边号（用户提供时使用，否则按顺序生成） */
  code?: string;
  /** 边长（米），必须正且有限 */
  length: number;
  /** 方位角（度），正北为零、顺时针；任意有限度数 */
  azimuth: number;
}

export interface ObservationInput {
  name?: string;
  startE: number;
  startN: number;
  edges: EdgeInput[];
  /** 允许的最大相对闭合差 f/P（如 1/2000 传 0.0005）；null 表示不设门槛 */
  maxRelativeClosure?: number | null;
  /** 坐标闭合公开容差（米），缺省 ADJUSTED_COORD_TOLERANCE */
  tolerance?: number;
}

/** 将任意有限角度规范到 [0,360)。 */
export function normalizeAzimuth(deg: number): number {
  if (!Number.isFinite(deg)) {
    throw new AppError("INVALID_AZIMUTH", `方位角必须为有限数值，收到 ${String(deg)}`);
  }
  if (Math.abs(deg) > LIMITS.maxAbsAngle) {
    throw new AppError(
      "AZIMUTH_OUT_OF_RANGE",
      `方位角绝对值不得超过 ${LIMITS.maxAbsAngle} 度，收到 ${deg}`,
    );
  }
  let a = deg % 360;
  if (a < 0) a += 360;
  // 处理 -0 与浮点残留
  if (Object.is(a, -0) || (a === 0 && Object.is(1 / deg, -Infinity))) a = 0;
  return a === 360 ? 0 : a;
}

const EPS = 1e-12;

/** 由增量反算方位角（度，[0,360)）；零向量返回 undefined。 */
export function azimuthFromDelta(dE: number, dN: number): number | undefined {
  if (Math.abs(dE) <= EPS && Math.abs(dN) <= EPS) return undefined;
  // atan2 的参数：东向对应 x，北向对应 y；正北为零、顺时针
  let a = (Math.atan2(dE, dN) * 180) / Math.PI;
  if (a < 0) a += 360;
  return a >= 360 ? a - 360 : a;
}

export interface ValidatedEdge {
  seq: number;
  code: string;
  /** 测点号：边 i 从点 P(i-1) 到点 P(i) */
  fromPoint: string;
  toPoint: string;
  length: number;
  azimuthRaw: number;
  azimuth: number;
  dE: number;
  dN: number;
}

export interface ValidatedObservation {
  name: string;
  startE: number;
  startN: number;
  edges: ValidatedEdge[];
  maxRelativeClosure: number | null;
  tolerance: number;
}

function finiteNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `字段 ${field} 必须为有限数值，收到 ${JSON.stringify(v)}`,
      400,
      { field },
    );
  }
  return v;
}

/** 输入检查：边数、边长、方位角、起点坐标、门槛与容差。 */
export function validateObservation(input: ObservationInput): ValidatedObservation {
  const errors: { field: string; message: string }[] = [];

  let startE = NaN;
  let startN = NaN;
  try {
    startE = finiteNumber(input.startE, "startE");
  } catch (e) {
    errors.push({ field: "startE", message: (e as Error).message });
  }
  try {
    startN = finiteNumber(input.startN, "startN");
  } catch (e) {
    errors.push({ field: "startN", message: (e as Error).message });
  }
  if (Number.isFinite(startE) && Math.abs(startE) > LIMITS.maxAbsCoord) {
    errors.push({ field: "startE", message: `起点东坐标绝对值不得超过 ${LIMITS.maxAbsCoord} 米` });
  }
  if (Number.isFinite(startN) && Math.abs(startN) > LIMITS.maxAbsCoord) {
    errors.push({ field: "startN", message: `起点北坐标绝对值不得超过 ${LIMITS.maxAbsCoord} 米` });
  }

  if (!Array.isArray(input.edges)) {
    errors.push({ field: "edges", message: "edges 必须为有序数组" });
  } else if (input.edges.length < LIMITS.minEdges || input.edges.length > LIMITS.maxEdges) {
    errors.push({
      field: "edges",
      message: `边数必须在 ${LIMITS.minEdges} 到 ${LIMITS.maxEdges} 之间，收到 ${input.edges.length}`,
    });
  }

  let tolerance = ADJUSTED_COORD_TOLERANCE;
  if (input.tolerance !== undefined) {
    const t = finiteNumber(input.tolerance, "tolerance");
    if (!(t > 0) || t > 1) {
      errors.push({ field: "tolerance", message: "tolerance 必须为 (0, 1] 米之间的正数" });
    } else {
      tolerance = t;
    }
  }

  let maxRelativeClosure: number | null = null;
  if (input.maxRelativeClosure !== undefined && input.maxRelativeClosure !== null) {
    const m = finiteNumber(input.maxRelativeClosure, "maxRelativeClosure");
    if (!(m > 0) || m >= 1) {
      errors.push({ field: "maxRelativeClosure", message: "maxRelativeClosure 必须为 (0, 1) 之间的正数（如 1/2000=0.0005）" });
    } else {
      maxRelativeClosure = m;
    }
  }

  const edges: ValidatedEdge[] = [];
  if (Array.isArray(input.edges)) {
    const usedCodes = new Set<string>();
    input.edges.forEach((raw, idx) => {
      const seq = idx + 1;
      const fieldPrefix = `edges[${idx}]`;
      let length: number;
      let azimuthRaw: number;
      try {
        length = finiteNumber(raw?.length, `${fieldPrefix}.length`);
        if (!(length > 0)) {
          errors.push({ field: `${fieldPrefix}.length`, message: `第 ${seq} 边边长必须严格为正，收到 ${raw?.length}` });
        } else if (length > LIMITS.maxLength) {
          errors.push({ field: `${fieldPrefix}.length`, message: `第 ${seq} 边边长不得超过 ${LIMITS.maxLength} 米` });
        }
      } catch (e) {
        errors.push({ field: `${fieldPrefix}.length`, message: (e as Error).message });
        length = NaN;
      }
      try {
        azimuthRaw = finiteNumber(raw?.azimuth, `${fieldPrefix}.azimuth`);
        normalizeAzimuth(azimuthRaw);
      } catch (e) {
        errors.push({ field: `${fieldPrefix}.azimuth`, message: (e as Error).message });
        azimuthRaw = NaN;
      }

      const code = raw?.code != null && String(raw.code).trim() !== "" ? String(raw.code) : `E${seq}`;
      if (usedCodes.has(code)) {
        errors.push({ field: `${fieldPrefix}.code`, message: `边编号重复：${code}` });
      }
      usedCodes.add(code);

      if (Number.isFinite(length) && Number.isFinite(azimuthRaw)) {
        const azimuth = normalizeAzimuth(azimuthRaw);
        const rad = (azimuth * Math.PI) / 180;
        edges.push({
          seq,
          code,
          fromPoint: `P${seq - 1}`,
          toPoint: `P${seq}`,
          length,
          azimuthRaw,
          azimuth,
          dE: length * Math.sin(rad),
          dN: length * Math.cos(rad),
        });
      }
    });
  }

  if (errors.length > 0) {
    throw new AppError("VALIDATION_ERROR", `输入校验失败：${errors.length} 个问题`, 400, errors);
  }

  return {
    name: input.name?.trim() || "未命名导线",
    startE,
    startN,
    edges,
    maxRelativeClosure,
    tolerance,
  };
}
