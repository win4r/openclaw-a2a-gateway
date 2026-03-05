# OpenClaw A2A Gateway - 测试报告

> 测试人：AliceLJY（小试AI公众号）
> 测试日期：2026-03-05
> 插件版本：1.0.0（commit master + 本地修复）
> OpenClaw 版本：2026.3.2（全部节点）

## 测试环境

### 四节点拓扑

| 节点 | 位置 | 容器/服务 | A2A 端口 | AI 模型 | Tailscale IP |
|------|------|----------|---------|---------|-------------|
| **AntiBot** | 本地 Docker | `openclaw-antigravity` | 18800 | Sonnet 4.6 | 100.123.101.117 |
| **XiaoshiAI** | 本地 Docker | `openclaw-twin` | 18801 | Codex gpt-5.2 | 100.123.101.117 |
| **Ruizhi** | 本地 Docker | `openclaw-gateway` | 18802 | Gemini 3 Pro CLI | 100.123.101.117 |
| **AWS-bot** | AWS EC2 | systemd 原生 | 18800 | Codex gpt-5.2 | 100.90.128.4 |

### 网络

- 本地 Docker 三节点通过宿主机端口映射（18800/18801/18802）
- AWS 通过 Tailscale mesh 网络（100.x.x.x）与本地互通
- 所有节点配置 Bearer token 双向认证

## 最终测试结果矩阵

### 修复后全量测试（12/12 通过）

| # | 发送方 | 接收方 | 场景 | 结果 | 响应内容 |
|---|--------|--------|------|------|----------|
| 1 | AWS-bot | AntiBot | 跨机器 | ✅ | "AntiBot。✅" |
| 2 | AWS-bot | XiaoshiAI | 跨机器 | ✅ | "小试AI（数字分身）" |
| 3 | AWS-bot | Ruizhi | 跨机器 | ✅ | "我是睿智。[完毕]"（修复后） |
| 4 | AntiBot | XiaoshiAI | 同机跨容器 | ✅ | "小试AI（数字分身）" |
| 5 | AntiBot | Ruizhi | 同机跨容器 | ✅ | "我是睿智。[完毕]"（修复后） |
| 6 | XiaoshiAI | AntiBot | 同机跨容器 | ✅ | "AntiBot。✅" |
| 7 | Ruizhi | AntiBot | 同机跨容器 | ✅ | "AntiBot。✅" |
| 8 | Ruizhi | XiaoshiAI | 同机跨容器 | ✅ | "小试AI（数字分身）" |
| 9 | AntiBot | AWS-bot | 跨机器 | ✅ | "AWS-bot" |
| 10 | 错误 token 认证 | — | 安全 | ✅ | 正确拒绝（JSON-RPC error -32603） |
| 11 | agentId 路由（→coder） | AntiBot | 路由 | ✅ | "My agent ID is coder" |
| 12 | Agent Card 发现 | 全部 4 节点 | 发现 | ✅ | 双向可达 |

## 发现的问题与解决方案

### Bug 1：executor scopes 不足（已修复，PR #2）

| 项目 | 内容 |
|------|------|
| **严重程度** | High |
| **文件** | `src/executor.ts:368` |
| **现象** | `sessions.resolve` → "missing scope: operator.read"；`agent` dispatch → "missing scope: operator.write" |
| **根因** | `buildConnectParams()` 请求的 scopes 只有 `["operator.admin", "operator.approvals", "operator.pairing"]`，缺少 `operator.read` 和 `operator.write` |
| **修复** | 添加 `operator.read` 和 `operator.write` 到 scopes 数组 |
| **补充说明** | 在无 `--allow-unconfigured` 的 Gateway 上，scope 还取决于 `paired.json` / `device-auth.json` 中的设备配置。建议 README 注明 Gateway 需用 `--allow-unconfigured` 或确保设备 scope 包含 `operator.read`/`operator.write` |

### Bug 2：agent dispatch 超时——30s 硬编码不够（已修复）

| 项目 | 内容 |
|------|------|
| **严重程度** | Medium |
| **文件** | `src/executor.ts:8`、`src/types.ts:55`、`index.ts:107` |
| **现象** | 使用 Gemini 3 Pro CLI 的 agent 响应超过 30s → dispatch 超时 → fallback "no agent dispatch available" |
| **根因** | `AGENT_RESPONSE_TIMEOUT_MS = 30_000` 硬编码，无法适应不同模型的响应速度 |
| **修复** | 新增 `config.timeouts.agentResponseMs` 可配置项，默认仍为 30s，用户可按模型需求调大 |
| **配置示例** | `openclaw config set plugins.entries.a2a-gateway.config.timeouts '{"agentResponseMs":90000}'` |
| **验证** | 配 90s 后 Ruizhi（Gemini CLI）成功响应 |

### 踩坑：docker cp 文件权限问题

| 项目 | 内容 |
|------|------|
| **严重程度** | 运维注意事项 |
| **现象** | `docker cp` 复制文件进容器后，文件 uid=501（宿主机），OpenClaw 安全检查拒绝加载（expected uid=1000 or root） |
| **解决** | `docker exec -u root <容器> chown -R node:node <插件目录>`，或直接改宿主机 volume mount 目录的文件 |
| **建议** | 更新插件代码应通过 `git pull`（容器内）而不是 `docker cp`，避免 uid 问题 |

### 文档建议

1. README 应说明 Gateway 需要 `--allow-unconfigured`（或设备 scope 包含 `operator.read`/`operator.write`）
2. 同机多 bot 场景：需要文档说明不同端口映射策略（容器内都用 18800，宿主机映射到不同端口）
3. `AGENT_RESPONSE_TIMEOUT_MS` 现已改为可配置，建议加入 Configuration Reference 表

## 代码变更摘要

### `src/executor.ts`

```diff
-const AGENT_RESPONSE_TIMEOUT_MS = 30_000;
+const DEFAULT_AGENT_RESPONSE_TIMEOUT_MS = 30_000;

 // buildConnectParams()
-      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
+      scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],

 // constructor
+  private readonly agentResponseTimeoutMs: number;
+  this.agentResponseTimeoutMs = config.timeouts?.agentResponseMs ?? DEFAULT_AGENT_RESPONSE_TIMEOUT_MS;

 // dispatchViaGatewayRpc
-        AGENT_RESPONSE_TIMEOUT_MS,
+        this.agentResponseTimeoutMs,
```

### `src/types.ts`

```diff
 export interface GatewayConfig {
   ...
+  timeouts?: {
+    agentResponseMs?: number;
+  };
 }
```

### `index.ts` (parseConfig)

```diff
+  const timeouts = asObject(config.timeouts);
+  const agentResponseMs = asNumber(timeouts.agentResponseMs, 0);
   return {
     ...
+    timeouts: agentResponseMs > 0 ? { agentResponseMs } : undefined,
   };
```

## 配置备忘

### Token 清单

| 节点 | A2A inbound token |
|------|------------------|
| AntiBot | `<redacted>` |
| XiaoshiAI | `<redacted>` |
| Ruizhi | `<redacted>` |
| AWS-bot | `<redacted>` |

### 端口映射

| 宿主机端口 | 容器端口 | 用途 |
|-----------|---------|------|
| 18800 | 18800 | AntiBot A2A |
| 18801 | 18800 | XiaoshiAI A2A |
| 18802 | 18800 | Ruizhi A2A |
