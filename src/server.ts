import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { AppError } from "./errors.js";
import { Store } from "./storage.js";
import { edgesCsv, pointsCsv, reportJson, summaryCsv } from "./exporters.js";

interface RouteContext {
  store: Store;
  surveyId?: string;
  query?: Record<string, string>;
  body?: unknown;
}

type Handler = (ctx: RouteContext) => Promise<{ status?: number; body?: unknown }> | { status?: number; body?: unknown };

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new AppError("PAYLOAD_TOO_LARGE", "请求体超过 5 MB 限制", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AppError("INVALID_JSON", "请求体不是合法 JSON", 400));
      }
    });
    req.on("error", reject);
  });
}

export function createApp(store: Store): Server {
  const routes: Route[] = [
    { method: "GET", pattern: /^\/health$/, handler: () => ({ body: { ok: true } }) },
    {
      method: "POST",
      pattern: /^\/surveys$/,
      handler: (ctx) => {
        const r = store.createSurvey(ctx.body as never);
        return { status: 201, body: { survey: r.survey, version: stripReport(r.version) } };
      },
    },
    { method: "GET", pattern: /^\/surveys$/, handler: () => ({ body: { surveys: store.listSurveys() } }) },
    {
      method: "POST",
      pattern: /^\/surveys\/([^/]+)\/versions$/,
      handler: (ctx, m) => {
        const v = store.addVersion(m[1], ctx.body as never, ctx.query?.note);
        return { status: 201, body: { version: stripReport(v) } };
      },
    },
    {
      method: "GET",
      pattern: /^\/surveys\/([^/]+)\/versions$/,
      handler: (_ctx, m) => ({ body: { versions: store.listVersions(m[1]).map(stripReport) } }),
    },
    {
      method: "POST",
      pattern: /^\/surveys\/([^/]+)\/validate$/,
      handler: (ctx, m) => {
        // 只检查输入：临时校验，不落库
        const { validateObservation } = require("./geometry.js") as typeof import("./geometry.js");
        const v = validateObservation(ctx.body as never);
        return { body: { valid: true, edges: v.edges.length, normalizedAzimuths: v.edges.map((e) => e.azimuth), perimeterPreview: v.edges.reduce((s, e) => s + e.length, 0) } };
      },
    },
    {
      method: "POST",
      pattern: /^\/surveys\/([^/]+)\/adjust$/,
      handler: (_ctx, m) => {
        const r = store.computeReport(m[1]);
        return { body: { version: stripReport(r.version), reused: r.reused, report: r.report } };
      },
    },
    {
      method: "GET",
      pattern: /^\/surveys\/([^/]+)\/report$/,
      handler: (ctx, m) => {
        const versionNo = ctx.query?.version ? Number(ctx.query.version) : undefined;
        const r = store.computeReport(m[1], versionNo);
        const format = ctx.query?.format ?? "json";
        if (format === "csv") {
          const section = ctx.query?.section ?? "edges";
          const csv = section === "points" ? pointsCsv(r.report) : section === "summary" ? summaryCsv(r.report) : edgesCsv(r.report);
          return { body: { __csv: csv, __filename: `${m[1]}_v${r.version.versionNo}_${section}.csv` } };
        }
        return { body: { version: stripReport(r.version), reused: r.reused, report: r.report } };
      },
    },
    {
      method: "GET",
      pattern: /^\/surveys\/([^/]+)\/edges\/(\d+)$/,
      handler: (ctx, m) => {
        const versionNo = ctx.query?.version ? Number(ctx.query.version) : undefined;
        return { body: store.getEdgeSource(m[1], Number(m[2]), versionNo) };
      },
    },
    {
      method: "GET",
      pattern: /^\/surveys\/([^/]+)\/points\/(\d+)$/,
      handler: (ctx, m) => {
        const versionNo = ctx.query?.version ? Number(ctx.query.version) : undefined;
        return { body: store.getPointSource(m[1], Number(m[2]), versionNo) };
      },
    },
    {
      method: "GET",
      pattern: /^\/surveys\/([^/]+)\/compare$/,
      handler: (ctx, m) => {
        const versionNo = ctx.query?.version ? Number(ctx.query.version) : undefined;
        const { report } = store.computeReport(m[1], versionNo);
        return { body: { original: originalView(report), adjusted: adjustedView(report) } };
      },
    },
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      const query = Object.fromEntries(url.searchParams);
      let body: unknown;
      if (req.method === "POST" || req.method === "PUT") body = await readBody(req);

      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = pathname.match(route.pattern);
        if (!match) continue;
        const result = await route.handler({ store, query, body }, match as unknown as RegExpMatchArray);
        sendResult(res, result, query.format === "csv");
        return;
      }
      sendError(res, new AppError("NOT_FOUND", `无此路由：${req.method} ${pathname}`, 404));
    } catch (e) {
      sendError(res, e as Error);
    }
  });
}

function stripReport(v: import("./storage.js").VersionRecord) {
  const { report, ...rest } = v;
  return { ...rest, hasFrozenReport: report !== null };
}

function originalView(r: import("./adjustment.js").AdjustmentReport) {
  return {
    points: r.points.map((p) => ({ seq: p.seq, code: p.code, e: p.eOriginal, n: p.nOriginal })),
    edges: r.edges.map((e) => ({ seq: e.seq, code: e.code, dE: e.dEOriginal, dN: e.dNOriginal, length: e.length, azimuth: e.azimuth })),
    closure: r.closure,
  };
}

function adjustedView(r: import("./adjustment.js").AdjustmentReport) {
  return {
    points: r.points.map((p) => ({ seq: p.seq, code: p.code, e: p.eAdjusted, n: p.nAdjusted })),
    edges: r.edges.map((e) => ({ seq: e.seq, code: e.code, dE: e.dEAdjusted, dN: e.dNAdjusted, length: e.lengthAdjusted, azimuth: e.azimuthAdjusted, azimuthReason: e.azimuthAdjustedReason })),
    adjustment: r.adjustment,
    correctionSummary: r.correctionSummary,
  };
}

function sendResult(res: ServerResponse, result: { status?: number; body?: unknown }, asCsv: boolean): void {
  const status = result.status ?? 200;
  const b = result.body as { __csv?: string; __filename?: string } | undefined;
  if (asCsv && b && typeof b.__csv === "string") {
    res.writeHead(status, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${b.__filename ?? "export.csv"}"`,
    });
    res.end("\uFEFF" + b.__csv);
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(result.body === undefined ? "" : reportJson(result.body as never));
}

function sendError(res: ServerResponse, e: Error): void {
  if (e instanceof AppError) {
    res.writeHead(e.httpStatus, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: e.code, message: e.message, details: e.details ?? null } }));
    return;
  }
  res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: e.message } }));
}

export async function listenFree(app: Server, preferredPort?: number): Promise<number> {
  const tryPorts = preferredPort ? [preferredPort] : [0];
  for (const p of tryPorts) {
    try {
      await new Promise<void>((resolve, reject) => {
        app.once("error", reject);
        app.listen(p, "127.0.0.1", resolve);
      });
      const addr = app.address() as AddressInfo;
      return addr.port;
    } catch (e) {
      if (preferredPort) throw e;
    }
  }
  throw new Error("无法绑定端口");
}
