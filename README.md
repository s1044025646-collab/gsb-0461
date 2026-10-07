# Bowditch 闭合导线平差后端

本地平面测量闭合导线平差服务：TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无外部服务），提供 HTTP API 与 CLI，Windows 本地直接运行。

## 适用范围与约定

- 仅处理**回到同一起点的闭合导线**；角度视为已处理好的观测量，**不做**测角平差、经纬度投影、地球曲率改正或三维轨迹。
- 坐标为东 `E`、北 `N`，单位米；边长单位米。
- 方位角以**正北为 0、顺时针增加**，输入任意有限度数后规范到 `[0, 360)`。
- 第 i 边增量：`dE = Li·sin(ai)`，`dN = Li·cos(ai)`，按输入顺序累计，不按点名重排；首尾同名点不合并，最后一条边保留。
- 闭合差：`fE = ΣdE`，`fN = ΣdN`，`f = sqrt(fE²+fN²)`，周长 `P = ΣLi`。
- **Bowditch 改正**：按边长权重 `wi = Li/P` 对两个分量分别分配：`cEi = -fE·Li/P`，`cNi = -fN·Li/P`。调整后增量 = 原增量 + 改正，再由起点顺序重建坐标。改正和满足 `ΣcEi = -fE`、`ΣcNi = -fN`。
- 调整后每边的**长度与方位角由调整后增量重新计算**（`atan2(adjDE, adjDN)`），不复制观测值；若调整后边退化为零长度，`adjAzimuth` 为 `null` 并附原因说明。
- 相对闭合差 `f/P`；`f` 大于公开容差时同时给出 `1 : P/f` 比例文本。完全闭合或容差内时比例为 `null`，**不会输出 Infinity**。
- 公开数值容差：`tol = 1e-9 + 1e-12·P`（米）。`rawStatus` 取值：`CLOSED`（f 恰为 0）/ `CLOSED_WITHIN_TOLERANCE` / `OPEN`。
- 用户可提供 `maxRelativeClosure`（允许的最大相对闭合差）。它**只判定原始观测是否合格**（`quality: PASS/FAIL`）；即使调整坐标在数学上闭合，原始超限标记仍然保留。
- 不要求导线为简单多边形，交叉不判错；不计算面积，不做工程合格认证。

## 输入限制

- 边数 3–1000；边长为正且有限，单边 ≤ 1e6 米；起点坐标有限且 |E|,|N| ≤ 1e9 米。
- 错误码：`INVALID_START`、`EDGE_COUNT`、`INVALID_LENGTH`、`INVALID_AZIMUTH`、`INVALID_THRESHOLD`、`NOT_FOUND`、`BAD_REQUEST`。

## 持久化与版本

- SQLite 保存原始观测、规则版本（`bowditch-1.0.0`）、容差、门槛与**冻结报告**。
- 修改观测（导入新边表）自动生成新版本；历史版本报告不可变。
- 同一版本重复平差请求直接返回已冻结报告（幂等）；计算失败不会留下部分结果。
- 重启后可查询历史坐标与原始闭合质量，不依赖内存。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build     # 编译到 dist/ 与 dist-test/
npm test          # 构建并运行全部测试
npm start         # 启动 API，默认自动选择空闲端口（$env:PORT=8080 可指定）
npm run demo      # 运行三组演示数据（四边算例 / 闭合正方形 / 明显超限）
```

数据目录默认为项目内 `data/`（可用环境变量 `BOWDITCH_DATA_DIR`、`BOWDITCH_DB` 覆盖）。

## API 摘要

- `POST /api/observations` 创建观测：`{name, startE, startN, edges:[{length,azimuth}], maxRelativeClosure?}`
- `POST /api/observations/:id/edges` 导入有序边表（生成新版本）
- `POST /api/observations/:id/validate` 检查输入
- `POST /api/observations/:id/adjust` 计算平差（幂等，返回冻结报告）
- `GET  /api/observations/:id/report?version=N` 查看报告
- `GET  /api/observations/:id/points/:seq` / `edges/:seq` 查看测点/边来源
- `GET  /api/observations/:id/compare` 原始与调整结果对比
- `GET  /api/observations/:id/export?format=csv|json` 导出
- `GET  /api/observations` 列表；`GET /api/observations/:id` 详情含版本列表

## CLI 摘要

```powershell
node dist/cli.js create <name> <input.json>
node dist/cli.js import <id> <edges.csv> [startE startN]
node dist/cli.js validate|adjust|report|compare <id> [version]
node dist/cli.js point <id> <seq>
node dist/cli.js edge <id> <seq>
node dist/cli.js export <id> [csv|json] [outfile]
node dist/cli.js list
node dist/cli.js demo
```

`input.json` 示例：`{"startE":0,"startN":0,"maxRelativeClosure":0.0005,"edges":[{"length":100,"azimuth":0},...]}`
边表 CSV 每行 `长度,方位角`（支持 `#` 注释与表头行）。

## 演示算例

边长 100/100/100/101 米、方位角 0/90/180/270：原始闭合差 `fE ≈ -1`、`fN ≈ 0`，`P = 401`。各边东向改正 `100/401, 100/401, 100/401, 101/401` 米，北向改正仅为数值微差（~1e-15）。相对闭合差约 `1:401`，在门槛 `1/2000` 下原始观测判 `FAIL`，但调整预览仍可生成且调整后终点在容差内回到起点。

## 限制

- `node:sqlite` 目前为 Node 实验特性（启动时有 ExperimentalWarning），需 Node ≥ 22.5，建议 Node 24+。
- 双精度浮点下，"完全闭合"以公开容差判定；报告同时保留原始残差便于核对。
- 仅本地单进程使用，未做并发写优化与鉴权。
