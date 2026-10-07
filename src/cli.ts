// CLI: create / import / validate / adjust / report / point / edge / compare / export / list / demo
import * as fs from "node:fs";
import * as path from "node:path";
import { Service, reportToCsv } from "./service";
import { Store } from "./db";
import { EdgeInput, TraverseInput } from "./core";

const DATA_DIR = process.env.BOWDITCH_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.BOWDITCH_DB ?? path.join(DATA_DIR, "bowditch.db");

function out(x: unknown): void {
  console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
}

function parseEdgesCsv(file: string): EdgeInput[] {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const edges: EdgeInput[] = [];
  for (const line of lines) {
    const cells = line.split(/[,\t;]/).map((c) => c.trim());
    if (/length|边长/i.test(cells[0])) continue; // 表头
    const length = Number(cells[cells.length - 2]);
    const azimuth = Number(cells[cells.length - 1]);
    edges.push({ length, azimuth });
  }
  return edges;
}

function parseInputJson(file: string): TraverseInput {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    startE: Number(j.startE),
    startN: Number(j.startN),
    edges: j.edges,
    maxRelativeClosure: j.maxRelativeClosure == null ? null : Number(j.maxRelativeClosure),
  };
}

function runDemo(service: Service): void {
  console.log("=== 演示 1: 四边导线 100/100/100/101, 方位角 0/90/180/270 ===");
  const o1 = service.createObservation("demo-4edge", {
    startE: 0, startN: 0,
    edges: [
      { length: 100, azimuth: 0 },
      { length: 100, azimuth: 90 },
      { length: 100, azimuth: 180 },
      { length: 101, azimuth: 270 },
    ],
    maxRelativeClosure: 1 / 2000,
  });
  const r1 = service.adjust(o1.id).report;
  console.log(`fE=${r1.fE} fN=${r1.fN} f=${r1.f} P=${r1.perimeter} 相对闭合差=${r1.relativeClosure} (${r1.relativeRatioText})`);
  console.log(`原始状态=${r1.rawStatus} 质量=${r1.quality}`);
  for (const e of r1.edges) {
    console.log(`边${e.seq}: corrE=${e.corrE.toFixed(6)} corrN=${e.corrN.toExponential(2)} 调整后 L=${e.adjLength.toFixed(6)} az=${e.adjAzimuth?.toFixed(6)}`);
  }

  console.log("\n=== 演示 2: 完全闭合正方形 (100m x 4) ===");
  const o2 = service.createObservation("demo-square", {
    startE: 1000, startN: 2000,
    edges: [
      { length: 100, azimuth: 0 },
      { length: 100, azimuth: 90 },
      { length: 100, azimuth: 180 },
      { length: 100, azimuth: 270 },
    ],
    maxRelativeClosure: 1 / 2000,
  });
  const r2 = service.adjust(o2.id).report;
  console.log(`f=${r2.f} 状态=${r2.rawStatus} 质量=${r2.quality} 改正和 corrE=${r2.corrSumE} corrN=${r2.corrSumN}`);

  console.log("\n=== 演示 3: 明显超限 (第三条边方位角错误导致大闭合差) ===");
  const o3 = service.createObservation("demo-overlimit", {
    startE: 0, startN: 0,
    edges: [
      { length: 100, azimuth: 0 },
      { length: 100, azimuth: 90 },
      { length: 100, azimuth: 150 },
      { length: 100, azimuth: 270 },
    ],
    maxRelativeClosure: 1 / 2000,
  });
  const r3 = service.adjust(o3.id).report;
  console.log(`f=${r3.f.toFixed(4)} 相对闭合差=1:${Math.round(r3.relativeRatio ?? 0)} 状态=${r3.rawStatus} 质量=${r3.quality}`);
  console.log(`调整后终点残差: dE=${r3.adjEndResidualE.toExponential(2)} dN=${r3.adjEndResidualN.toExponential(2)} (数学上仍闭合, 但原始观测超限标记保留)`);
  console.log(`\n演示数据 ID: ${o1.id} / ${o2.id} / ${o3.id}`);
}

function main(): void {
  const [, , cmd, ...args] = process.argv;
  const service = new Service(new Store(DB_PATH));
  try {
    switch (cmd) {
      case "create": {
        // create <name> <input.json>
        const obs = service.createObservation(args[0] ?? "unnamed", parseInputJson(args[1]));
        return out(obs);
      }
      case "import": {
        // import <id> <edges.csv> [startE startN]
        const edges = parseEdgesCsv(args[1]);
        const start = args[2] !== undefined ? { E: Number(args[2]), N: Number(args[3]) } : undefined;
        return out(service.importEdges(args[0], edges, start));
      }
      case "validate":
        return out(service.validate(args[0], args[1] ? Number(args[1]) : undefined));
      case "adjust":
        return out(service.adjust(args[0], args[1] ? Number(args[1]) : undefined));
      case "report":
        return out(service.getReport(args[0], args[1] ? Number(args[1]) : undefined));
      case "point":
        return out(service.getPoint(args[0], Number(args[1])));
      case "edge":
        return out(service.getEdge(args[0], Number(args[1])));
      case "compare":
        return out(service.compare(args[0], args[1] ? Number(args[1]) : undefined));
      case "export": {
        // export <id> [csv|json] [outfile]
        const { report } = service.getReport(args[0]);
        const format = args[1] ?? "json";
        const content = format === "csv" ? reportToCsv(report) : JSON.stringify(report, null, 2);
        if (args[2]) {
          fs.writeFileSync(args[2], content, "utf8");
          return out(`已导出到 ${args[2]}`);
        }
        return out(content);
      }
      case "list":
        return out(service.store.listObservations());
      case "demo":
        return runDemo(service);
      default:
        console.log(`用法: node dist/cli.js <命令>
  create <name> <input.json>     创建观测
  import <id> <edges.csv> [E N]  导入有序边表(生成新版本)
  validate <id> [version]        检查输入
  adjust <id> [version]          计算平差(幂等, 冻结报告)
  report <id> [version]          查看冻结报告
  point <id> <seq>               查看测点来源
  edge <id> <seq>                查看边来源
  compare <id> [version]         对比原始与调整结果
  export <id> [csv|json] [file]  导出
  list                           列出观测
  demo                           运行演示`);
    }
  } finally {
    service.store.close();
  }
}

main();
