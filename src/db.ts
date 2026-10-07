// SQLite 持久化: 观测(版本化)、冻结报告。使用 Node 内置 node:sqlite。
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { TraverseInput, TraverseResult } from "./core";

export interface ObservationRow {
  id: string;
  version: number;
  name: string;
  input: TraverseInput;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private nextVersion(id: string): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM observations WHERE id = ?")
      .get(id) as { v: number | null };
    return (row.v ?? 0) + 1;
  }

  createObservation(id: string, name: string, input: TraverseInput): ObservationRow {
    const version = 1;
    const createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO observations (id, version, name, input_json, created_at) VALUES (?,?,?,?,?)")
      .run(id, version, name, JSON.stringify(input), createdAt);
    return { id, version, name, input, createdAt };
  }

  // 修改观测 -> 生成新版本
  updateObservation(id: string, name: string, input: TraverseInput): ObservationRow {
    const version = this.nextVersion(id);
    const createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO observations (id, version, name, input_json, created_at) VALUES (?,?,?,?,?)")
      .run(id, version, name, JSON.stringify(input), createdAt);
    return { id, version, name, input, createdAt };
  }

  getObservation(id: string, version?: number): ObservationRow | null {
    const row = (
      version === undefined
        ? this.db
            .prepare("SELECT * FROM observations WHERE id = ? ORDER BY version DESC LIMIT 1")
            .get(id)
        : this.db.prepare("SELECT * FROM observations WHERE id = ? AND version = ?").get(id, version)
    ) as { id: string; version: number; name: string; input_json: string; created_at: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      name: row.name,
      input: JSON.parse(row.input_json) as TraverseInput,
      createdAt: row.created_at,
    };
  }

  listObservations(): { id: string; version: number; name: string; createdAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT o.id, o.version, o.name, o.created_at FROM observations o
         JOIN (SELECT id, MAX(version) v FROM observations GROUP BY id) m
           ON o.id = m.id AND o.version = m.v ORDER BY o.created_at`
      )
      .all() as unknown as { id: string; version: number; name: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, version: r.version, name: r.name, createdAt: r.created_at }));
  }

  listVersions(id: string): number[] {
    const rows = this.db
      .prepare("SELECT version FROM observations WHERE id = ? ORDER BY version")
      .all(id) as unknown as { version: number }[];
    return rows.map((r) => r.version);
  }

  // 冻结报告: 同一 (id, version) 重复请求返回原报告
  getReport(id: string, version: number): TraverseResult | null {
    const row = this.db
      .prepare("SELECT report_json FROM reports WHERE id = ? AND version = ?")
      .get(id, version) as { report_json: string } | undefined;
    return row ? (JSON.parse(row.report_json) as TraverseResult) : null;
  }

  saveReport(id: string, version: number, report: TraverseResult): void {
    this.db
      .prepare("INSERT INTO reports (id, version, report_json, created_at) VALUES (?,?,?,?)")
      .run(id, version, JSON.stringify(report), new Date().toISOString());
  }
}
