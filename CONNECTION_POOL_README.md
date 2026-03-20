# Connection Pool for A2A Gateway

## 概述

連接池是 A2A Gateway 的性能優化功能，通過復用 HTTP 連接來降低延遲和資源開銷。

## 性能提升

### 預期效果

| 指標 | 當前 | 優化後 | 提升 |
|------|------|--------|------|
| 平均延遲 | 192ms | 115ms | ↓40% |
| 活躍連接數 | 100 | 30 | ↓70% |
| 連接創建/銷毀開銷 | 100 | 30 | ↓70% |
| 吞吐量 | 50 msg/s | 85 msg/s | ↑70% |

## 使用方法

### 1. 使用 PooledA2AClient

```typescript
import { PooledA2AClient } from "./src/pooled-client.js";

// 創建客戶端
const client = new PooledA2AClient({
  poolConfig: {
    maxConnections: 10,
    connectionTtlMs: 300000, // 5 minutes
    idleCheckIntervalMs: 60000, // 1 minute
  }
});

// 發送消息（自動使用連接池）
const result = await client.sendMessage(peer, message, {
  healthManager,
  retryConfig,
  log: console.log
});

// 查看連接池統計
const stats = client.getPoolStats();
console.log(stats);

// 銷毀連接池
client.destroy();
```

### 2. 直接使用 ConnectionPool

```typescript
import { ConnectionPool } from "./src/connection-pool.js";

const pool = new ConnectionPool({
  maxConnections: 10,
  connectionTtlMs: 300000,
  idleCheckIntervalMs: 60000,
});

// 獲取連接
const connection = await pool.acquire("http://localhost:18800");

// 使用連接...

// 釋放連接
pool.release(connection.id);

// 查看統計
const stats = pool.getStats();
console.log(stats);

// 清理
pool.destroy();
```

## 配置選項

```typescript
interface ConnectionPoolConfig {
  maxConnections?: number;        // 最大連接數（默認：10）
  connectionTtlMs?: number;       // 連接 TTL（默認：300000ms = 5分鐘）
  idleCheckIntervalMs?: number;   // 空閒檢查間隔（默認：60000ms = 1分鐘）
}
```

## 運行測試

```bash
# 運行單元測試
npm test -- tests/connection-pool.test.ts

# 運行 Benchmark
node tests/connection-pool.benchmark.ts
```

## 架構

### 核心組件

1. **ConnectionPool**: 連接池管理器
   - 管理連接的創建、復用、釋放
   - 自動清理過期連接
   - 限制最大連接數

2. **PooledA2AClient**: 增強版客戶端
   - 集成連接池功能
   - 自動管理連接獲取和釋放
   - 保持向後兼容性

3. **測試和 Benchmark**: 驗證功能和性能

### 工作流程

```
1. 客戶端請求連接
   ↓
2. 連接池檢查是否有可用連接
   ↓
3. 如果有可用連接 → 復用
   如果沒有 → 創建新連接
   ↓
4. 使用連接發送請求
   ↓
5. 釋放連接回池
   ↓
6. 連接池定期清理過期連接
```

## 風險控制

### 連接超時
- 連接超時：5秒
- 連接池清理：5分鐘
- 最多連接數：10個

### 錯誤處理
- 連接失敗自動重試（最多3次）
- 連接泄漏防護（自動清理機制）
- 資源限制（避免資源耗盡）

## 已知限制

1. 當前版本僅支持 HTTP 連接池
2. gRPC 連接目前不使用連接池
3. 每個端點有獨立的連接池

## 未來優化

1. 支持 gRPC 連接池
2. 支持跨端點連接復用
3. 支持連接預熱
4. 支持動態調整連接池大小

## 貢獻者

- zycaskevin

## 相關 Issue

- Issue #32: 性能優化建議：消息體積壓縮 60%，延遲降低 50-60%
