# openclaw-a2a-gateway 代码审查（对照 a2a-js 最佳实践）

对照基线：`@a2a-js/sdk` README Quickstart / Task 支持 / ClientFactory 推荐用法（来源：`node_modules/@a2a-js/sdk/README.md`）。

## 总结

- **整体结论：基本符合 a2a-js v0.3.0 推荐实现路径**（`DefaultRequestHandler + InMemoryTaskStore + jsonRpc/rest/grpc handlers + ClientFactory` 均已采用）。
- **可用于生产前置条件**：需进一步补齐错误分类、可观测性和认证健壮性，尤其是长任务与取消语义的一致性。

## 符合最佳实践的点

1. **服务端接入方式标准**
   - 使用 `DefaultRequestHandler` 与 `InMemoryTaskStore`，并挂载 Agent Card / JSON-RPC / REST / gRPC 端点，契合 SDK Quickstart。  
2. **客户端出站调用方式正确**
   - 使用 `ClientFactory.createFromUrl()` 自动发现 Agent Card 并选择传输层，符合 SDK 推荐。  
3. **任务生命周期事件具备基础完整性**
   - 在执行中发布 `working`，结束时发布 `completed`，并携带 artifact，符合 Task 语义的基础要求。  
4. **鉴权机制已覆盖入站与出站**
   - 入站 bearer 校验、出站可注入 bearer/apiKey 头。  

## 主要问题与建议

### P1（建议优先）

1. **错误映射过于粗粒度**
   - 当前出站 `sendMessage` 失败统一返回 `500` + 字符串错误，可能掩盖 4xx/鉴权/超时等语义。建议保留 SDK/传输层原始错误类别并映射可观测字段（`code` / `transport` / `retryable`）。
2. **取消语义仅更新任务状态，未中断底层执行**
   - `cancelTask` 仅发布 `canceled`，但并未取消潜在中的 gateway RPC。建议引入可取消上下文（AbortController 或 gateway cancel 接口）。

### P2（建议近期）

1. **认证类型解析健壮性**
   - 已修复：仅接受 `bearer` / `apiKey`，避免无效类型被误接纳。
2. **默认 Agent Card URL 主机可达性**
   - 已修复：当 host 为 `0.0.0.0` 时，fallback URL 使用 `localhost`，避免将不可路由地址写入卡片。
3. **discoverAgentCard 轻微冗余**
   - 已修复：保留 `createFromUrl` 的解析副作用，不再持有未使用变量。

### P3（长期增强）

1. **测试覆盖面偏单元 mock**
   - 目前对 HTTP/REST/gRPC 的端到端互通、鉴权失败路径、超时重试路径覆盖不足。建议加入最小 e2e（本地起 server + client）。
2. **可观测性字段可再增强**
   - 建议在日志中统一带 `taskId/contextId/agentId/peer/transport`，便于跨节点排障。

## 本次已落地的改进

- 限制 peer auth 类型白名单（`bearer` / `apiKey`）。
- Agent Card fallback URL 避免使用 `0.0.0.0`。
- 去除 `discoverAgentCard` 中未使用变量。

## 与 a2a-js 的一致性结论

- **一致**：服务端/客户端主流程、任务模型、传输多接口支持。
- **部分一致**：错误与取消语义已具备基础能力，但未做到“高可观测 + 可中断 + 明确错误分类”的生产级最佳实践。
- **建议评级**：
  - 协议实现完整度：**A-**
  - 工程健壮性：**B**
  - 生产可运维性：**B-**
