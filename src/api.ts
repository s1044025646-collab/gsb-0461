// HTTP API (node:http, 无外部依赖)。默认端口 0 = 自动选择空闲端口。
import * as http from "node:http";
import * as path from "node:path";
import { Service, reportToCsv } from "./service";
import { Store } from "./db";
import { TraverseError } from "./core";

const DATA_DIR = process.env.BOWDITCH_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.BOWDITCH_DB ?? path.join(DATA_DIR, "bowditch.db");

function send(res: http.ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": contentType });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new TraverseError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" || method === "PUT" ? ((await readBody(req)) as Record<string, unknown>) : {};
      const versionParam = url.searchParams.get("version");
      const version = versionParam ? Number(versionParam) : undefined;

      if (method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, { ok: true });
      }
      if (method === "GET" && url.pathname === "/api/observations") {
        return send(res, 200, service.store.listObservations());
      }
      if (method === "POST" && url.pathname === "/api/observations") {
        const obs = service.createObservation(String(body.name ?? "unnamed"), {
          startE: Number(body.startE),
          startN: Number(body.startN),
          edges: body.edges as never,
          maxRelativeClosure: body.maxRelativeClosure == null ? null : Number(body.maxRelativeClosure),
        });
        return send(res, 201, obs);
      }
      if (parts[0] === "api" && parts[1] === "observations" && parts[2]) {
        const id = parts[2];
        const sub = parts[3];
        if (method === "GET" && !sub) {
          const obs = service.mustGet(id, version);
          return send(res, 200, { ...obs, versions: service.store.listVersions(id) });
        }
        if (method === "POST" && sub === "edges") {
          const obs = service.importEdges(id, body.edges as never, body.start as never);
          return send(res, 200, obs);
        }
        if (method === "POST" && sub === "validate") return send(res, 200, service.validate(id, version));
        if (method === "POST" && sub === "adjust") return send(res, 200, service.adjust(id, version));
        if (method === "GET" && sub === "report") return send(res, 200, service.getReport(id, version));
        if (method === "GET" && sub === "compare") return send(res, 200, service.compare(id, version));
        if (method === "GET" && sub === "points") return send(res, 200, service.getPoint(id, Number(parts[4]), version));
        if (method === "GET" && sub === "edges") return send(res, 200, service.getEdge(id, Number(parts[4]), version));
        if (method === "GET" && sub === "export") {
          const { report } = service.getReport(id, version);
          const format = url.searchParams.get("format") ?? "json";
          if (format === "csv") return send(res, 200, reportToCsv(report), "text/csv; charset=utf-8");
          return send(res, 200, report);
        }
      }
      return send(res, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (e) {
      if (e instanceof TraverseError) {
        const status = e.code === "NOT_FOUND" ? 404 : 400;
        return send(res, status, { error: { code: e.code, message: e.message, details: e.details ?? null } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

if (require.main === module) {
  const service = new Service(new Store(DB_PATH));
  const server = createServer(service);
  const requested = process.env.PORT ? Number(process.env.PORT) : 0;
  server.listen(requested, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : requested;
    console.log(`Bowditch API 已启动: http://127.0.0.1:${port}  (数据目录: ${DATA_DIR})`);
  });
}
