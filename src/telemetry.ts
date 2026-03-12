import type { OpenClawPluginApi } from "./types.js";
import { A2AMetricsCollector } from "./internal/metrics.js";

type LoggerLike = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;
type LogLevel = "info" | "warn" | "error";
type TerminalTaskState = "completed" | "failed" | "canceled" | "rejected";

interface HttpMetrics {
  requests_total: number;
  jsonrpc_requests: number;
  rest_requests: number;
  metrics_requests: number;
  outbound_requests: number;
  security_rejections: number;
  last_request_at?: string;
}

interface TaskMetrics {
  queued: number;
  started: number;
  completed: number;
  failed: number;
  canceled: number;
  rejected: number;
  timed_out: number;
  queue_rejections: number;
  active: number;
  queue_depth: number;
  max_active_observed: number;
  max_queue_depth_observed: number;
  total_duration_ms: number;
  finished: number;
  expired: number;
  last_started_at?: string;
  last_finished_at?: string;
  last_cleanup_at?: string;
}

export interface GatewayTelemetrySnapshot {
  protocol: ReturnType<A2AMetricsCollector["getMetrics"]>;
  http: HttpMetrics;
  tasks: TaskMetrics & { average_duration_ms: number };
}

export interface GatewayTelemetryOptions {
  structuredLogs?: boolean;
}

export class GatewayTelemetry {
  private readonly collector = new A2AMetricsCollector();
  private readonly logger: LoggerLike;
  private readonly structuredLogs: boolean;
  private readonly http: HttpMetrics = {
    requests_total: 0,
    jsonrpc_requests: 0,
    rest_requests: 0,
    metrics_requests: 0,
    outbound_requests: 0,
    security_rejections: 0,
  };
  private readonly tasks: TaskMetrics = {
    queued: 0,
    started: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    rejected: 0,
    timed_out: 0,
    queue_rejections: 0,
    active: 0,
    queue_depth: 0,
    max_active_observed: 0,
    max_queue_depth_observed: 0,
    total_duration_ms: 0,
    finished: 0,
    expired: 0,
  };

  constructor(logger: LoggerLike, options: GatewayTelemetryOptions = {}) {
    this.logger = logger;
    this.structuredLogs = options.structuredLogs !== false;
  }

  recordInboundHttp(route: "jsonrpc" | "rest" | "metrics", statusCode: number, durationMs: number): void {
    this.collector.recordReceive();
    this.http.requests_total += 1;
    this.http.last_request_at = new Date().toISOString();

    if (route === "jsonrpc") {
      this.http.jsonrpc_requests += 1;
    } else if (route === "rest") {
      this.http.rest_requests += 1;
    } else {
      this.http.metrics_requests += 1;
    }

    this.log("info", "http.request", {
      route,
      status_code: statusCode,
      duration_ms: durationMs,
    });
  }

  recordOutboundRequest(peer: string, ok: boolean, statusCode: number, durationMs: number): void {
    this.http.outbound_requests += 1;
    if (ok) {
      this.collector.recordSend();
    } else {
      this.collector.recordError();
    }

    this.log(ok ? "info" : "warn", "peer.request", {
      peer,
      ok,
      status_code: statusCode,
      duration_ms: durationMs,
    });
  }

  recordSecurityRejection(surface: "http" | "grpc", reason: string): void {
    this.collector.recordSecurityRejection();
    this.http.security_rejections += 1;
    this.log("warn", "security.rejection", {
      surface,
      reason,
    });
  }

  recordTaskQueued(taskId: string, contextId: string, position: number, queueDepth: number): void {
    this.tasks.queued += 1;
    this.setQueueState(this.tasks.active, queueDepth);
    this.log("info", "task.queued", {
      task_id: taskId,
      context_id: contextId,
      queue_position: position,
      queue_depth: queueDepth,
    });
  }

  recordTaskStart(taskId: string, contextId: string, agentId: string, activeCount: number, queueDepth: number): void {
    this.tasks.started += 1;
    this.tasks.last_started_at = new Date().toISOString();
    this.setQueueState(activeCount, queueDepth);
    this.log("info", "task.started", {
      task_id: taskId,
      context_id: contextId,
      agent_id: agentId,
      active_tasks: activeCount,
      queue_depth: queueDepth,
    });
  }

  recordTaskFinish(
    taskId: string,
    contextId: string,
    state: TerminalTaskState,
    durationMs: number,
    activeCount: number,
    queueDepth: number,
    errorMessage?: string,
  ): void {
    this.tasks.finished += 1;
    this.tasks.total_duration_ms += durationMs;
    this.tasks.last_finished_at = new Date().toISOString();
    this.setQueueState(activeCount, queueDepth);

    if (state === "completed") {
      this.tasks.completed += 1;
    } else if (state === "failed") {
      this.tasks.failed += 1;
      this.collector.recordError();
      if (this.isTimeoutError(errorMessage)) {
        this.tasks.timed_out += 1;
      }
    } else if (state === "canceled") {
      this.tasks.canceled += 1;
    } else if (state === "rejected") {
      this.tasks.rejected += 1;
    }

    this.log(state === "completed" ? "info" : "warn", "task.finished", {
      task_id: taskId,
      context_id: contextId,
      state,
      duration_ms: durationMs,
      active_tasks: activeCount,
      queue_depth: queueDepth,
      error: errorMessage,
    });
  }

  recordQueueRejected(taskId: string, contextId: string, queueDepth: number): void {
    this.tasks.queue_rejections += 1;
    this.tasks.rejected += 1;
    this.setQueueState(this.tasks.active, queueDepth);
    this.log("warn", "task.queue_rejected", {
      task_id: taskId,
      context_id: contextId,
      queue_depth: queueDepth,
    });
  }

  recordTaskExpired(taskId: string, state: string): void {
    this.tasks.expired += 1;
    this.tasks.last_cleanup_at = new Date().toISOString();
    this.log("info", "task.expired", {
      task_id: taskId,
      state,
    });
  }

  snapshot(): GatewayTelemetrySnapshot {
    const averageDuration =
      this.tasks.finished > 0
        ? Number((this.tasks.total_duration_ms / this.tasks.finished).toFixed(2))
        : 0;

    return {
      protocol: this.collector.getMetrics(),
      http: { ...this.http },
      tasks: {
        ...this.tasks,
        average_duration_ms: averageDuration,
      },
    };
  }

  private setQueueState(activeCount: number, queueDepth: number): void {
    this.tasks.active = activeCount;
    this.tasks.queue_depth = queueDepth;
    this.tasks.max_active_observed = Math.max(this.tasks.max_active_observed, activeCount);
    this.tasks.max_queue_depth_observed = Math.max(this.tasks.max_queue_depth_observed, queueDepth);
  }

  private isTimeoutError(errorMessage?: string): boolean {
    return typeof errorMessage === "string" && /timed out/i.test(errorMessage);
  }

  private log(level: LogLevel, event: string, details: Record<string, unknown>): void {
    if (!this.structuredLogs) {
      return;
    }

    const payload = JSON.stringify({
      ts: new Date().toISOString(),
      component: "a2a-gateway",
      event,
      ...details,
    });

    this.logger[level](payload);
  }
}
