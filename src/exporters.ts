import { AdjustmentReport } from "./adjustment.js";

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: (string | number | null)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function edgesCsv(report: AdjustmentReport): string {
  const rows: (string | number | null)[][] = [
    [
      "seq", "edge_code", "from_point", "to_point", "length_m", "azimuth_raw_deg", "azimuth_norm_deg",
      "dE_original_m", "dN_original_m", "weight_L_over_P", "cE_m", "cN_m",
      "dE_adjusted_m", "dN_adjusted_m", "length_adjusted_m", "azimuth_adjusted_deg", "azimuth_adjusted_reason",
    ],
  ];
  for (const e of report.edges) {
    rows.push([
      e.seq, e.code, e.fromPoint, e.toPoint, e.length, e.azimuthRaw, e.azimuth,
      e.dEOriginal, e.dNOriginal, e.weight, e.cE, e.cN,
      e.dEAdjusted, e.dNAdjusted, e.lengthAdjusted, e.azimuthAdjusted, e.azimuthAdjustedReason,
    ]);
  }
  return toCsv(rows);
}

export function pointsCsv(report: AdjustmentReport): string {
  const rows: (string | number | null)[][] = [
    ["seq", "point_code", "is_closure", "E_original_m", "N_original_m", "E_adjusted_m", "N_adjusted_m", "derived_from_edges"],
  ];
  for (const p of report.points) {
    rows.push([
      p.seq, p.code, p.isClosure ? 1 : 0,
      p.eOriginal, p.nOriginal, p.eAdjusted, p.nAdjusted,
      p.derivedFromEdges.join(" "),
    ]);
  }
  return toCsv(rows);
}

export function summaryCsv(report: AdjustmentReport): string {
  const c = report.closure;
  const a = report.adjustment;
  const s = report.correctionSummary;
  return toCsv([
    ["key", "value"],
    ["rule_version", report.ruleVersion],
    ["tolerance_m", report.tolerance],
    ["fE_m", c.fE],
    ["fN_m", c.fN],
    ["closure_f_m", c.f],
    ["perimeter_P_m", c.perimeter],
    ["relative_closure_f_over_P", c.relativeClosure],
    ["ratio_one_in_P_over_f", c.closureRatioOneIn],
    ["raw_quality_status", c.rawQualityStatus],
    ["max_relative_closure", c.maxRelativeClosure],
    ["limit_passed_original_only", c.limitPassed],
    ["sum_cE_m", s.sumCE],
    ["sum_cN_m", s.sumCN],
    ["cE_cancels_fE", s.cancelsFE ? 1 : 0],
    ["cN_cancels_fN", s.cancelsFN ? 1 : 0],
    ["adjustment_status", a.status],
    ["adjusted_residual_m", a.residual],
  ]);
}

export function reportJson(report: AdjustmentReport): string {
  return JSON.stringify(report, null, 2);
}
