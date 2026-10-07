// 业务层: 创建/导入/校验/平差/查询/对比/导出, API 与 CLI 共用。
import { randomUUID } from "node:crypto";
import {
  computeTraverse,
  validateInput,
  TraverseError,
  TraverseInput,
  TraverseResult,
  EdgeInput,
} from "./core";
import { Store, ObservationRow } from "./db";

export class Service {
  constructor(public store: Store) {}

  createObservation(name: string, input: TraverseInput): ObservationRow {
    validateInput(input);
    return this.store.createObservation(randomUUID(), name ?? "unnamed", input);
  }

  importEdges(id: string, edges: EdgeInput[], start?: { E: number; N: number }): ObservationRow {
    const obs = this.mustGet(id);
    const input: TraverseInput = {
      startE: start?.E ?? obs.input.startE,
      startN: start?.N ?? obs.input.startN,
      edges,
      maxRelativeClosure: obs.input.maxRelativeClosure ?? null,
    };
    validateInput(input);
    return this.store.updateObservation(id, obs.name, input);
  }

  validate(id: string, version?: number): { valid: boolean; errors: string[] } {
    const obs = this.mustGet(id, version);
    try {
      validateInput(obs.input);
      return { valid: true, errors: [] };
    } catch (e) {
      if (e instanceof TraverseError) return { valid: false, errors: [`${e.code}: ${e.message}`] };
      throw e;
    }
  }

  // 平差: 幂等, 同一版本重复请求返回冻结报告
  adjust(id: string, version?: number): { observation: ObservationRow; report: TraverseResult; frozen: boolean } {
    const obs = this.mustGet(id, version);
    const existing = this.store.getReport(obs.id, obs.version);
    if (existing) return { observation: obs, report: existing, frozen: true };
    const report = computeTraverse(obs.input);
    this.store.saveReport(obs.id, obs.version, report);
    return { observation: obs, report, frozen: false };
  }

  getReport(id: string, version?: number): { observation: ObservationRow; report: TraverseResult } {
    const obs = this.mustGet(id, version);
    const report = this.store.getReport(obs.id, obs.version);
    if (!report) throw new TraverseError("NOT_FOUND", "该版本尚无冻结报告, 请先执行平差");
    return { observation: obs, report };
  }

  getPoint(id: string, seq: number, version?: number) {
    const { observation, report } = this.getReport(id, version);
    const p = report.points.find((x) => x.seq === seq);
    if (!p) throw new TraverseError("NOT_FOUND", `测点 ${seq} 不存在`);
    return { observation: { id: observation.id, version: observation.version }, point: p };
  }

  getEdge(id: string, seq: number, version?: number) {
    const { observation, report } = this.getReport(id, version);
    const e = report.edges.find((x) => x.seq === seq);
    if (!e) throw new TraverseError("NOT_FOUND", `边 ${seq} 不存在`);
    return { observation: { id: observation.id, version: observation.version }, edge: e };
  }

  compare(id: string, version?: number) {
    const { observation, report } = this.getReport(id, version);
    return {
      id: observation.id,
      version: observation.version,
      rawStatus: report.rawStatus,
      quality: report.quality,
      closure: { fE: report.fE, fN: report.fN, f: report.f, relative: report.relativeClosure, ratio: report.relativeRatioText },
      edges: report.edges.map((e) => ({
        seq: e.seq,
        raw: { length: e.length, azimuth: e.azimuth, dE: e.dE, dN: e.dN },
        correction: { corrE: e.corrE, corrN: e.corrN, weight: e.weight },
        adjusted: { dE: e.adjDE, dN: e.adjDN, length: e.adjLength, azimuth: e.adjAzimuth, azimuthNote: e.adjAzimuthNote },
      })),
      points: report.points,
    };
  }

  mustGet(id: string, version?: number): ObservationRow {
    const obs = this.store.getObservation(id, version);
    if (!obs) throw new TraverseError("NOT_FOUND", `观测 ${id}${version ? ` v${version}` : ""} 不存在`);
    return obs;
  }
}

export function reportToCsv(report: TraverseResult): string {
  const lines: string[] = [];
  lines.push("section,seq,length,azimuth,dE,dN,weight,corrE,corrN,adjDE,adjDN,adjLength,adjAzimuth,note");
  for (const e of report.edges) {
    lines.push(
      ["edge", e.seq, e.length, e.azimuth, e.dE, e.dN, e.weight, e.corrE, e.corrN, e.adjDE, e.adjDN, e.adjLength, e.adjAzimuth ?? "", e.adjAzimuthNote ?? ""].join(",")
    );
  }
  lines.push("section,seq,rawE,rawN,adjE,adjN");
  for (const p of report.points) {
    lines.push(["point", p.seq, p.rawE, p.rawN, p.adjE, p.adjN].join(","));
  }
  lines.push("section,key,value");
  lines.push(`summary,perimeter,${report.perimeter}`);
  lines.push(`summary,fE,${report.fE}`);
  lines.push(`summary,fN,${report.fN}`);
  lines.push(`summary,f,${report.f}`);
  lines.push(`summary,relativeClosure,${report.relativeClosure}`);
  lines.push(`summary,relativeRatio,${report.relativeRatioText ?? ""}`);
  lines.push(`summary,rawStatus,${report.rawStatus}`);
  lines.push(`summary,quality,${report.quality}`);
  return lines.join("\r\n") + "\r\n";
}
