import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError, notFound } from "./errors.js";
import { RULE_VERSION, ValidatedObservation, validateObservation, ObservationInput } from "./geometry.js";
import { AdjustmentReport, computeAdjustment } from "./adjustment.js";

export interface SurveyRecord {
  id: string;
  name: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface VersionRecord {
  id: number;
  surveyId: string;
  versionNo: number;
  inputHash: string;
  ruleVersion: string;
  tolerance: number;
  maxRelativeClosure: number | null;
  startE: number;
  startN: number;
  createdAt: string;
  note: string | null;
  report: AdjustmentReport | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS surveys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        current_version INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        tolerance REAL NOT NULL,
        max_relative_closure REAL,
        start_e REAL NOT NULL,
        start_n REAL NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(survey_id, version_no)
      );
      CREATE TABLE IF NOT EXISTS edges (
        version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        code TEXT NOT NULL,
        length REAL NOT NULL,
        azimuth_raw REAL NOT NULL,
        PRIMARY KEY (version_id, seq)
      );
      CREATE TABLE IF NOT EXISTS reports (
        version_id INTEGER PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private static hashInput(obs: ValidatedObservation): string {
    const canonical = JSON.stringify({
      v: RULE_VERSION,
      s: [obs.startE, obs.startN],
      t: obs.tolerance,
      m: obs.maxRelativeClosure,
      e: obs.edges.map((e) => [e.seq, e.code, e.length, e.azimuthRaw]),
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  createSurvey(input: ObservationInput): { survey: SurveyRecord; version: VersionRecord } {
    const obs = validateObservation(input);
    const id = createHash("sha1")
      .update(`${Date.now()}:${Math.random()}:${obs.name}`)
      .digest("hex")
      .slice(0, 12);
    const now = new Date().toISOString();
    const tx = this.db.prepare(
      `INSERT INTO surveys (id, name, current_version, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    );
    tx.run(id, obs.name, now, now);
    const version = this.insertVersion(id, 1, obs, "初始观测");
    const survey = this.getSurveyOrThrow(id);
    return { survey, version };
  }

  /** 修改任一观测都会生成新版本（旧版本与冻结报告保持不变）。 */
  addVersion(surveyId: string, input: ObservationInput, note?: string): VersionRecord {
    const survey = this.getSurveyOrThrow(surveyId);
    const obs = validateObservation(input);
    const nextNo = survey.currentVersion + 1;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE surveys SET name = ?, current_version = ?, updated_at = ? WHERE id = ?").run(
      obs.name,
      nextNo,
      now,
      surveyId,
    );
    return this.insertVersion(surveyId, nextNo, obs, note ?? "观测修订");
  }

  private insertVersion(surveyId: string, versionNo: number, obs: ValidatedObservation, note: string): VersionRecord {
    const hash = Store.hashInput(obs);
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      `INSERT INTO versions
       (survey_id, version_no, input_hash, rule_version, tolerance, max_relative_closure, start_e, start_n, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = ins.run(
      surveyId,
      versionNo,
      hash,
      RULE_VERSION,
      obs.tolerance,
      obs.maxRelativeClosure,
      obs.startE,
      obs.startN,
      note,
      now,
    );
    const versionId = Number(info.lastInsertRowid);
    const edgeIns = this.db.prepare(
      "INSERT INTO edges (version_id, seq, code, length, azimuth_raw) VALUES (?, ?, ?, ?, ?)",
    );
    for (const e of obs.edges) {
      edgeIns.run(versionId, e.seq, e.code, e.length, e.azimuthRaw);
    }
    return this.getVersionById(versionId)!;
  }

  getSurveyOrThrow(id: string): SurveyRecord {
    const row = this.db
      .prepare("SELECT id, name, current_version AS currentVersion, created_at AS createdAt, updated_at AS updatedAt FROM surveys WHERE id = ?")
      .get(id) as SurveyRecord | undefined;
    if (!row) notFound(`导线 ${id}`);
    return row;
  }

  listSurveys(): SurveyRecord[] {
    return this.db
      .prepare("SELECT id, name, current_version AS currentVersion, created_at AS createdAt, updated_at AS updatedAt FROM surveys ORDER BY created_at")
      .all() as SurveyRecord[];
  }

  resolveVersion(surveyId: string, versionNo?: number): VersionRecord {
    this.getSurveyOrThrow(surveyId);
    const no = versionNo ?? this.getSurveyOrThrow(surveyId).currentVersion;
    const v = this.db.prepare("SELECT * FROM versions WHERE survey_id = ? AND version_no = ?").get(surveyId, no);
    if (!v) notFound(`版本 v${no}`);
    return this.hydrateVersion(v as Record<string, unknown>);
  }

  listVersions(surveyId: string): VersionRecord[] {
    this.getSurveyOrThrow(surveyId);
    const rows = this.db
      .prepare("SELECT * FROM versions WHERE survey_id = ? ORDER BY version_no")
      .all(surveyId) as Record<string, unknown>[];
    return rows.map((r) => this.hydrateVersion(r));
  }

  private hydrateVersion(row: Record<string, unknown>): VersionRecord {
    const reportRow = this.db.prepare("SELECT report_json AS j FROM reports WHERE version_id = ?").get(row.id) as
      | { j: string }
      | undefined;
    return {
      id: Number(row.id),
      surveyId: String(row.survey_id),
      versionNo: Number(row.version_no),
      inputHash: String(row.input_hash),
      ruleVersion: String(row.rule_version),
      tolerance: Number(row.tolerance),
      maxRelativeClosure: row.max_relative_closure == null ? null : Number(row.max_relative_closure),
      startE: Number(row.start_e),
      startN: Number(row.start_n),
      createdAt: String(row.created_at),
      note: row.note == null ? null : String(row.note),
      report: reportRow ? (JSON.parse(reportRow.j) as AdjustmentReport) : null,
    };
  }

  private getVersionById(id: number): VersionRecord | null {
    const row = this.db.prepare("SELECT * FROM versions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.hydrateVersion(row) : null;
  }

  loadValidatedObservation(version: VersionRecord): ValidatedObservation {
    const edgeRows = this.db
      .prepare("SELECT code, length, azimuth_raw AS azimuthRaw FROM edges WHERE version_id = ? ORDER BY seq")
      .all(version.id) as { code: string; length: number; azimuthRaw: number }[];
    const survey = this.getSurveyOrThrow(version.surveyId);
    return validateObservation({
      name: survey.name,
      startE: version.startE,
      startN: version.startN,
      tolerance: version.tolerance,
      maxRelativeClosure: version.maxRelativeClosure,
      edges: edgeRows.map((r) => ({ code: r.code, length: r.length, azimuth: r.azimuthRaw })),
    });
  }

  /**
   * 计算并冻结报告。重复请求返回原报告；写入在事务内完成，
   * 失败回滚，不留下“部分改正已发布”的结果。
   */
  computeReport(surveyId: string, versionNo?: number): { version: VersionRecord; report: AdjustmentReport; reused: boolean } {
    const version = this.resolveVersion(surveyId, versionNo);
    if (version.report) return { version, report: version.report, reused: true };

    const obs = this.loadValidatedObservation(version);
    const report = computeAdjustment(obs);
    const json = JSON.stringify(report);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const existing = this.db.prepare("SELECT report_json AS j FROM reports WHERE version_id = ?").get(version.id) as
        | { j: string }
        | undefined;
      if (existing) {
        this.db.exec("ROLLBACK");
        return { version, report: JSON.parse(existing.j) as AdjustmentReport, reused: true };
      }
      this.db
        .prepare("INSERT INTO reports (version_id, report_json, created_at) VALUES (?, ?, ?)")
        .run(version.id, json, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw new AppError("REPORT_PERSIST_FAILED", `报告冻结失败：${(e as Error).message}`, 500);
    }
    return { version, report, reused: false };
  }

  /** 查询边/点来源：返回某边的原始观测与累计链。 */
  getEdgeSource(surveyId: string, edgeSeq: number, versionNo?: number) {
    const { report } = this.computeReport(surveyId, versionNo);
    const edge = report.edges.find((e) => e.seq === edgeSeq);
    if (!edge) notFound(`第 ${edgeSeq} 边`);
    return {
      report,
      edge,
      fromPoint: report.points[edge.seq - 1],
      toPoint: report.points[edge.seq],
    };
  }

  getPointSource(surveyId: string, pointSeq: number, versionNo?: number) {
    const { report } = this.computeReport(surveyId, versionNo);
    const point = report.points.find((p) => p.seq === pointSeq);
    if (!point) notFound(`点 P${pointSeq}`);
    return { report, point };
  }
}
