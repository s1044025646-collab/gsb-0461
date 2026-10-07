import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeTraverse,
  normalizeAzimuth,
  validateInput,
  TraverseError,
  TraverseInput,
} from "../src/core";
import { Store } from "../src/db";
import { Service, reportToCsv } from "../src/service";

const demoInput: TraverseInput = {
  startE: 0,
  startN: 0,
  edges: [
    { length: 100, azimuth: 0 },
    { length: 100, azimuth: 90 },
    { length: 100, azimuth: 180 },
    { length: 101, azimuth: 270 },
  ],
  maxRelativeClosure: 1 / 2000,
};

test("演示算例: 闭合差与按边长分配的改正", () => {
  const r = computeTraverse(demoInput);
  assert.ok(Math.abs(r.fE - -1) < 1e-9, `fE=${r.fE}`);
  assert.ok(Math.abs(r.fN) < 1e-9);
  assert.ok(Math.abs(r.f - 1) < 1e-9);
  assert.equal(r.perimeter, 401);
  const expected = [100 / 401, 100 / 401, 100 / 401, 101 / 401];
  r.edges.forEach((e, i) => {
    assert.ok(Math.abs(e.corrE - expected[i]) < 1e-12, `edge ${i} corrE=${e.corrE}`);
    assert.ok(Math.abs(e.corrN) < 1e-9);
    assert.ok(Math.abs(e.weight - e.length / 401) < 1e-15);
  });
  assert.ok(Math.abs(r.corrSumE + r.fE) < 1e-9);
  assert.ok(Math.abs(r.corrSumN + r.fN) < 1e-9);
  assert.ok(Math.abs(r.adjEndResidualE) <= r.tolerance);
  assert.ok(Math.abs(r.adjEndResidualN) <= r.tolerance);
  assert.equal(r.quality, "FAIL");
  assert.equal(r.closurePassed, false);
});

test("完全闭合正方形: CLOSED, 零改正, 不输出 Infinity", () => {
  const r = computeTraverse({
    startE: 5,
    startN: -7,
    edges: [
      { length: 100, azimuth: 0 },
      { length: 100, azimuth: 90 },
      { length: 100, azimuth: 180 },
      { length: 100, azimuth: 270 },
    ],
    maxRelativeClosure: 1 / 2000,
  });
  assert.ok(r.rawStatus === "CLOSED" || r.rawStatus === "CLOSED_WITHIN_TOLERANCE");
  assert.ok(r.f <= r.tolerance);
  assert.equal(r.relativeRatio, null);
  assert.equal(r.relativeRatioText, null);
  assert.ok(!JSON.stringify(r).includes("Infinity"));
  for (const e of r.edges) {
    assert.ok(Math.abs(e.corrE) <= r.tolerance);
    assert.ok(Math.abs(e.corrN) <= r.tolerance);
    assert.ok(Math.abs(e.adjLength - 100) < 1e-9);
  }
  assert.equal(r.quality, "PASS");
});

test("调整后边长与方位角由调整后增量重算", () => {
  const r = computeTraverse(demoInput);
  for (const e of r.edges) {
    const L = Math.hypot(e.adjDE, e.adjDN);
    assert.ok(Math.abs(e.adjLength - L) < 1e-12);
    const az = normalizeAzimuth((Math.atan2(e.adjDE, e.adjDN) * 180) / Math.PI);
    assert.ok(Math.abs((e.adjAzimuth ?? 0) - az) < 1e-9);
    assert.notEqual(e.adjLength, e.length);
  }
});

test("坐标平移不改变闭合差与改正", () => {
  const a = computeTraverse(demoInput);
  const b = computeTraverse({ ...demoInput, startE: 12345.6, startN: -987.6 });
  assert.ok(Math.abs(a.fE - b.fE) < 1e-9);
  assert.ok(Math.abs(a.fN - b.fN) < 1e-9);
  a.edges.forEach((e, i) => {
    assert.ok(Math.abs(e.corrE - b.edges[i].corrE) < 1e-9);
    assert.ok(Math.abs(e.corrN - b.edges[i].corrN) < 1e-9);
  });
  assert.equal(b.points[0].adjE, 12345.6);
});

test("整体旋转: 闭合差向量同步旋转, 模长不变", () => {
  const rot = (deg: number): TraverseInput => ({
    startE: 0,
    startN: 0,
    edges: demoInput.edges.map((e) => ({ length: e.length, azimuth: e.azimuth + deg })),
  });
  const r0 = computeTraverse(rot(0));
  const r37 = computeTraverse(rot(37));
  assert.ok(Math.abs(r0.f - r37.f) < 1e-9);
  const rad = (37 * Math.PI) / 180;
  const fE2 = r0.fE * Math.cos(rad) + r0.fN * Math.sin(rad);
  const fN2 = -r0.fE * Math.sin(rad) + r0.fN * Math.cos(rad);
  assert.ok(Math.abs(r37.fE - fE2) < 1e-9, `${r37.fE} vs ${fE2}`);
  assert.ok(Math.abs(r37.fN - fN2) < 1e-9);
});

test("长度同比放大: 相对闭合差不变, 改正同比放大", () => {
  const k = 2.5;
  const a = computeTraverse(demoInput);
  const b = computeTraverse({
    ...demoInput,
    edges: demoInput.edges.map((e) => ({ length: e.length * k, azimuth: e.azimuth })),
  });
  assert.ok(Math.abs(a.relativeClosure - b.relativeClosure) < 1e-12);
  a.edges.forEach((e, i) => {
    assert.ok(Math.abs(e.corrE * k - b.edges[i].corrE) < 1e-9);
  });
});

test("方位角跨周规范化", () => {
  assert.equal(normalizeAzimuth(360), 0);
  assert.equal(normalizeAzimuth(-90), 270);
  assert.equal(normalizeAzimuth(450), 90);
  assert.equal(normalizeAzimuth(-0), 0);
  const a = computeTraverse(demoInput);
  const b = computeTraverse({
    ...demoInput,
    edges: demoInput.edges.map((e) => ({ length: e.length, azimuth: e.azimuth + 720 })),
  });
  assert.ok(Math.abs(a.fE - b.fE) < 1e-9);
});

test("非法输入校验", () => {
  assert.throws(
    () => validateInput({ startE: NaN, startN: 0, edges: demoInput.edges }),
    (e: unknown) => e instanceof TraverseError && e.code === "INVALID_START"
  );
  assert.throws(
    () => validateInput({ startE: 0, startN: 0, edges: [{ length: 1, azimuth: 0 }] }),
    (e: unknown) => e instanceof TraverseError && e.code === "EDGE_COUNT"
  );
  const badLen = { startE: 0, startN: 0, edges: [...demoInput.edges] };
  badLen.edges[1] = { length: 0, azimuth: 90 };
  assert.throws(() => validateInput(badLen), (e: unknown) => e instanceof TraverseError && e.code === "INVALID_LENGTH");
  const badAz = { startE: 0, startN: 0, edges: [...demoInput.edges] };
  badAz.edges[0] = { length: 100, azimuth: Infinity };
  assert.throws(() => validateInput(badAz), (e: unknown) => e instanceof TraverseError && e.code === "INVALID_AZIMUTH");
  assert.throws(
    () => validateInput({ ...demoInput, maxRelativeClosure: -1 }),
    (e: unknown) => e instanceof TraverseError && e.code === "INVALID_THRESHOLD"
  );
});

test("调整后边字段一致性(零长度边方位角为 null 且带原因)", () => {
  const r = computeTraverse({
    startE: 0,
    startN: 0,
    edges: [
      { length: 100, azimuth: 0 },
      { length: 100, azimuth: 180 },
      { length: 50, azimuth: 90 },
    ],
  });
  for (const e of r.edges) {
    if (e.adjAzimuth === null) assert.ok(e.adjAzimuthNote);
    else assert.equal(e.adjAzimuthNote, null);
  }
});

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bowditch-")), "test.db");
}

test("持久化: 平差幂等、修改生成新版本、历史版本不变", () => {
  const svc = new Service(new Store(tmpDb()));
  const obs = svc.createObservation("t1", demoInput);
  const a1 = svc.adjust(obs.id);
  const a2 = svc.adjust(obs.id);
  assert.equal(a1.frozen, false);
  assert.equal(a2.frozen, true);
  assert.deepEqual(a1.report, a2.report);
  const obs2 = svc.importEdges(obs.id, [
    { length: 100, azimuth: 0 },
    { length: 100, azimuth: 90 },
    { length: 100, azimuth: 180 },
    { length: 100, azimuth: 270 },
  ]);
  assert.equal(obs2.version, 2);
  const r2 = svc.adjust(obs.id).report;
  assert.ok(r2.f <= r2.tolerance);
  const r1 = svc.getReport(obs.id, 1).report;
  assert.ok(Math.abs(r1.f - 1) < 1e-9);
  assert.deepEqual(svc.store.listVersions(obs.id), [1, 2]);
  svc.store.close();
});

test("重启后可查询旧报告(不依赖内存)", () => {
  const db = tmpDb();
  const svc1 = new Service(new Store(db));
  const obs = svc1.createObservation("restart", demoInput);
  svc1.adjust(obs.id);
  svc1.store.close();
  const svc2 = new Service(new Store(db));
  const { report } = svc2.getReport(obs.id);
  assert.ok(Math.abs(report.f - 1) < 1e-9);
  assert.equal(report.quality, "FAIL");
  const p = svc2.getPoint(obs.id, 4);
  assert.ok(Math.abs(p.point.adjE) <= report.tolerance);
  svc2.store.close();
});

test("导出 CSV 后可重算核对", () => {
  const svc = new Service(new Store(tmpDb()));
  const obs = svc.createObservation("csv", demoInput);
  const { report } = svc.adjust(obs.id);
  const csv = reportToCsv(report);
  const lines = csv.trim().split(/\r?\n/);
  const edgeLines = lines.filter((l) => l.startsWith("edge,"));
  assert.equal(edgeLines.length, 4);
  let sumCorrE = 0, sumCorrN = 0, sumAdjDE = 0, sumAdjDN = 0;
  for (const l of edgeLines) {
    const c = l.split(",");
    sumCorrE += Number(c[7]);
    sumCorrN += Number(c[8]);
    sumAdjDE += Number(c[9]);
    sumAdjDN += Number(c[10]);
  }
  assert.ok(Math.abs(sumCorrE + report.fE) < 1e-9);
  assert.ok(Math.abs(sumCorrN + report.fN) < 1e-9);
  assert.ok(Math.abs(sumAdjDE) < 1e-9);
  assert.ok(Math.abs(sumAdjDN) < 1e-9);
  const json = JSON.stringify(report);
  assert.ok(!/Infinity|NaN/.test(json));
  svc.store.close();
});

test("独立向量求和核对闭合差", () => {
  const r = computeTraverse(demoInput);
  let fE = 0, fN = 0;
  for (const e of demoInput.edges) {
    const a = (normalizeAzimuth(e.azimuth) * Math.PI) / 180;
    fE += e.length * Math.sin(a);
    fN += e.length * Math.cos(a);
  }
  assert.ok(Math.abs(r.fE - fE) < 1e-12);
  assert.ok(Math.abs(r.fN - fN) < 1e-12);
});

test("超限观测仍可生成调整预览但保留 FAIL 标记", () => {
  const r = computeTraverse({
    startE: 0,
    startN: 0,
    edges: [
      { length: 100, azimuth: 0 },
      { length: 100, azimuth: 90 },
      { length: 100, azimuth: 150 },
      { length: 100, azimuth: 270 },
    ],
    maxRelativeClosure: 1 / 2000,
  });
  assert.equal(r.quality, "FAIL");
  assert.equal(r.rawStatus, "OPEN");
  assert.ok(Math.abs(r.adjEndResidualE) <= r.tolerance);
  assert.ok(Math.abs(r.adjEndResidualN) <= r.tolerance);
});
