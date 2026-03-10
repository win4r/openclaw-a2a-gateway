import { v4 as uuidv4 } from "uuid";

import type { Message, Part, Task } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";

import type { GatewayConfig, OpenClawPluginApi } from "./types.js";

const DEFAULT_AGENT_RESPONSE_TIMEOUT_MS = 300_000;
const GATEWAY_CONNECT_TIMEOUT_MS = 10_000;
const GATEWAY_REQUEST_TIMEOUT_MS = 10_000;
const HOOKS_WAKE_TIMEOUT_MS = 5_000;
const TASK_CONTEXT_CACHE_LIMIT = 10_000;

/**
 * Structured response from OpenClaw Gateway agent dispatch.
 * Carries both text and optional media URLs extracted from agent payloads.
 */
interface AgentResponse {
  text: string;
  mediaUrls: string[];
}

function pickAgentId(requestContext: RequestContext, fallbackAgentId: string): string {
  const msg = requestContext.userMessage as unknown as Record<string, unknown> | undefined;
  const explicit = msg && typeof msg.agentId === "string" ? msg.agentId : "";
  return explicit || fallbackAgentId;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

/**
 * Format an A2A DataPart as human-readable text for the OpenClaw agent.
 *
 * DataPart carries structured JSON data (kind: "data"). Since the Gateway RPC
 * only accepts plain text, we serialize the data with a mimeType hint so the
 * agent can interpret it.
 */
function formatDataPartAsText(obj: Record<string, unknown>): string {
  const data = asObject(obj.data);
  if (!data) {
    // Fallback: stringify the entire obj.data even if it's a primitive/array
    if (obj.data !== undefined && obj.data !== null) {
      const raw = JSON.stringify(obj.data);
      const mimeType = asString(obj.mimeType) || "application/json";
      return `[Data (${mimeType}): ${raw.slice(0, 2000)}]`;
    }
    return "";
  }

  const mimeType = asString(obj.mimeType) || "application/json";
  const raw = JSON.stringify(data);
  // Truncate very large payloads to prevent overwhelming the agent context
  const preview = raw.length > 2000 ? raw.slice(0, 2000) + "…" : raw;
  return `[Data (${mimeType}): ${preview}]`;
}

/**
 * Format an A2A FilePart as human-readable text for the OpenClaw agent.
 *
 * The Gateway RPC `agent` method only accepts a `message: string` parameter,
 * so file parts must be serialized into text. URI-based files include the URL
 * so the agent can reference or fetch them; inline base64 files include a size
 * hint since the raw bytes cannot be forwarded through the text channel.
 */
function formatFilePartAsText(obj: Record<string, unknown>): string {
  const file = asObject(obj.file);
  if (!file) {
    return "";
  }

  // Sanitize name/mimeType: strip control chars and newlines to prevent
  // format injection when embedded in the agent message text.
  const rawName = asString(file.name) || "file";
  const rawMimeType = asString(file.mimeType) || "application/octet-stream";
  const name = rawName.replace(/[\r\n\t\x00-\x1f]/g, "").slice(0, 200);
  const mimeType = rawMimeType.replace(/[\r\n\t\x00-\x1f]/g, "").slice(0, 100);

  // URI-based file
  const uri = asString(file.uri);
  if (uri) {
    return `[Attached: ${name} (${mimeType}) \u2192 ${uri}]`;
  }

  // Base64-encoded inline file
  const bytes = asString(file.bytes);
  if (bytes) {
    const sizeKB = Math.ceil((bytes.length * 3) / 4 / 1024);
    return `[Attached: ${name} (${mimeType}), inline ${sizeKB}KB]`;
  }

  return `[Attached: ${name} (${mimeType})]`;
}

function extractTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTextFragments(entry));
  }

  const obj = asObject(value);
  if (!obj) {
    return [];
  }

  if (obj.kind === "text" && typeof obj.text === "string") {
    const trimmed = obj.text.trim();
    return trimmed ? [trimmed] : [];
  }

  // Handle A2A FilePart: format as human-readable text for the agent
  if (obj.kind === "file") {
    const description = formatFilePartAsText(obj);
    return description ? [description] : [];
  }

  // Handle A2A DataPart: serialize structured data as human-readable text
  if (obj.kind === "data") {
    const description = formatDataPartAsText(obj);
    return description ? [description] : [];
  }

  const parts = Array.isArray(obj.parts) ? obj.parts : [];
  if (parts.length > 0) {
    return parts.flatMap((part) => extractTextFragments(part));
  }

  const content = Array.isArray(obj.content) ? obj.content : [];
  if (content.length > 0) {
    return content.flatMap((entry) => extractTextFragments(entry));
  }

  if (typeof obj.text === "string") {
    const trimmed = obj.text.trim();
    return trimmed ? [trimmed] : [];
  }

  return [];
}

function extractInboundMessageText(message: unknown): string {
  const fragments = extractTextFragments(message);
  if (fragments.length > 0) {
    return fragments.join("\n");
  }

  try {
    return JSON.stringify(message);
  } catch {
    return "A2A inbound message";
  }
}

function extractAgentPayloadText(payload: unknown): string | undefined {
  const fragments = extractTextFragments(payload);
  if (fragments.length === 0) {
    return undefined;
  }

  return fragments.join("\n").trim() || undefined;
}

/**
 * Extract media URLs from a single agent payload entry.
 *
 * OpenClaw Gateway agent payloads carry media via `mediaUrl` (single) and/or
 * `mediaUrls` (array). Both are extracted and de-duplicated.
 */
function extractMediaUrlsFromPayload(payload: unknown): string[] {
  const obj = asObject(payload);
  if (!obj) {
    return [];
  }

  const urls: string[] = [];

  const single = asString(obj.mediaUrl);
  if (single) {
    urls.push(single);
  }

  if (Array.isArray(obj.mediaUrls)) {
    for (const entry of obj.mediaUrls) {
      const url = asString(entry);
      if (url && !urls.includes(url)) {
        urls.push(url);
      }
    }
  }

  return urls;
}

/**
 * Extract structured response (text + media URLs) from the Gateway agent
 * final payload. Returns undefined when no usable content is found.
 */
function extractAgentResponse(payload: unknown): AgentResponse | undefined {
  const body = asObject(payload);
  if (!body) {
    return undefined;
  }

  const result = asObject(body.result);
  const payloads = Array.isArray(result?.payloads) ? result.payloads : [];

  const texts = payloads
    .map((entry) => extractAgentPayloadText(entry))
    .filter((entry): entry is string => Boolean(entry && entry.trim()));

  const mediaUrls: string[] = [];
  for (const entry of payloads) {
    for (const url of extractMediaUrlsFromPayload(entry)) {
      if (!mediaUrls.includes(url)) {
        mediaUrls.push(url);
      }
    }
  }

  if (texts.length > 0 || mediaUrls.length > 0) {
    return {
      text: texts.join("\n\n"),
      mediaUrls,
    };
  }

  return undefined;
}

/**
 * Build A2A Part array from an AgentResponse. Produces TextPart for text
 * content and FilePart entries for each media URL.
 */
function buildResponseParts(response: AgentResponse): Part[] {
  const parts: Part[] = [];

  if (response.text) {
    parts.push({ kind: "text", text: response.text });
  }

  for (const url of response.mediaUrls) {
    parts.push({
      kind: "file",
      file: { uri: url },
    });
  }

  // Ensure at least one part exists (A2A requires non-empty parts array)
  if (parts.length === 0) {
    parts.push({ kind: "text", text: "" });
  }

  return parts;
}

function extractLatestAssistantReply(historyPayload: unknown): string | undefined {
  const body = asObject(historyPayload);
  if (!body) {
    return undefined;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = asObject(messages[i]);
    if (!entry || entry.role !== "assistant") {
      continue;
    }

    const text = extractAgentPayloadText(entry);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface GatewayRuntimeConfig {
  port: number;
  wsUrl: string;
  hooksWakeUrl: string;
  gatewayToken: string;
  gatewayPassword: string;
  hooksToken: string;
}

interface PendingGatewayRequest {
  method: string;
  expectFinal: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WebSocketConstructor {
  new (url: string): GatewayWebSocket;
}

interface GatewayWebSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: (event: unknown) => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "close", listener: (event: unknown) => void): void;
  removeEventListener(type: "open", listener: (event: unknown) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener(type: "close", listener: (event: unknown) => void): void;
}

class GatewayRpcConnection {
  private readonly wsUrl: string;
  private readonly gatewayToken: string;
  private readonly gatewayPassword: string;
  private readonly pending: Map<string, PendingGatewayRequest>;
  private socket: GatewayWebSocket | null;
  private messageListener: ((event: { data: unknown }) => void) | null;
  private closeListener: ((event: unknown) => void) | null;

  private connectChallengeTimer: ReturnType<typeof setTimeout> | null;
  private connectChallengeResolver: ((nonce: string) => void) | null;
  private connectChallengeRejecter: ((error: Error) => void) | null;

  constructor(config: GatewayRuntimeConfig) {
    this.wsUrl = config.wsUrl;
    this.gatewayToken = config.gatewayToken;
    this.gatewayPassword = config.gatewayPassword;
    this.pending = new Map();
    this.socket = null;
    this.messageListener = null;
    this.closeListener = null;

    this.connectChallengeTimer = null;
    this.connectChallengeResolver = null;
    this.connectChallengeRejecter = null;
  }

  async connect(): Promise<void> {
    const ctor = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!ctor) {
      throw new Error("WebSocket runtime is unavailable");
    }

    const socket = new ctor(this.wsUrl);
    this.socket = socket;
    this.messageListener = (event) => {
      this.handleMessage(event);
    };
    this.closeListener = () => {
      const error = new Error("gateway connection closed");
      this.rejectConnectChallenge(error);
      this.rejectAllPending(error);
    };

    socket.addEventListener("message", this.messageListener);
    socket.addEventListener("close", this.closeListener);

    const challengePromise = this.awaitConnectChallenge();

    try {
      await new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };

      const settle = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (error) {
          this.rejectConnectChallenge(error);
          reject(error);
          return;
        }
        resolve();
      };

      const onOpen = () => {
        settle();
      };

      const onError = () => {
        settle(new Error("failed to open gateway websocket"));
      };

      const onClose = () => {
        settle(new Error("gateway websocket closed during connect"));
      };

      const timer = setTimeout(() => {
        settle(new Error("gateway websocket connect timed out"));
      }, GATEWAY_CONNECT_TIMEOUT_MS);

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      });

      // OpenClaw Gateway uses a challenge event before accepting connect.
      await challengePromise;
    } catch (error) {
      await challengePromise.catch(() => {});
      throw error;
    }

    await this.request("connect", this.buildConnectParams(), GATEWAY_CONNECT_TIMEOUT_MS, false);
  }

  async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    expectFinal: boolean,
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      throw new Error("gateway websocket is not connected");
    }

    const id = uuidv4();
    const frame = {
      type: "req" as const,
      id,
      method,
      params,
    };

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        expectFinal,
        timer,
        resolve,
        reject,
      });

      try {
        socket.send(JSON.stringify(frame));
      } catch (error: unknown) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;

    if (socket) {
      if (this.messageListener) {
        socket.removeEventListener("message", this.messageListener);
      }
      if (this.closeListener) {
        socket.removeEventListener("close", this.closeListener);
      }
      this.messageListener = null;
      this.closeListener = null;
      socket.close();
    }

    const error = new Error("gateway websocket connection closed");
    this.rejectConnectChallenge(error);
    this.rejectAllPending(error);
  }

  private awaitConnectChallenge(): Promise<void> {
    if (this.connectChallengeRejecter) {
      this.connectChallengeRejecter(new Error("gateway connect challenge wait superseded"));
    }

    this.clearConnectChallengeWait();

    return new Promise<void>((resolve, reject) => {
      this.connectChallengeResolver = () => {
        this.clearConnectChallengeWait();
        resolve();
      };

      this.connectChallengeRejecter = (error) => {
        this.clearConnectChallengeWait();
        reject(error);
      };

      // OpenClaw Gateway typically emits a connect.challenge event shortly after the socket opens.
      // Use a bounded timeout so we fail fast (and can fall back) if the gateway isn't reachable.
      const timeoutMs = 2_000;
      this.connectChallengeTimer = setTimeout(() => {
        this.connectChallengeRejecter?.(new Error("gateway connect challenge timed out"));
      }, timeoutMs);
    });
  }

  private clearConnectChallengeWait(): void {
    if (this.connectChallengeTimer) {
      clearTimeout(this.connectChallengeTimer);
    }
    this.connectChallengeTimer = null;
    this.connectChallengeResolver = null;
    this.connectChallengeRejecter = null;
  }

  private rejectConnectChallenge(error: Error): void {
    if (this.connectChallengeRejecter) {
      this.connectChallengeRejecter(error);
      return;
    }

    this.clearConnectChallengeWait();
  }

  private buildConnectParams(): Record<string, unknown> {
    const auth: Record<string, string> = {};
    if (this.gatewayToken) {
      auth.token = this.gatewayToken;
    }
    if (this.gatewayPassword) {
      auth.password = this.gatewayPassword;
    }

    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "cli",
        version: "a2a-gateway-plugin",
        platform: process.platform,
        mode: "cli",
        instanceId: uuidv4(),
      },
      role: "operator",
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
    };

    if (Object.keys(auth).length > 0) {
      params.auth = auth;
    }

    return params;
  }

  private handleMessage(event: { data: unknown }): void {
    const raw = typeof event.data === "string" ? event.data : "";
    if (!raw) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = asObject(parsed);
    if (!frame) {
      return;
    }

    if (frame.type === "event") {
      if (frame.event === "connect.challenge") {
        const payload = asObject(frame.payload);
        const nonce = asString(payload?.nonce)?.trim() || "";
        if (nonce && this.connectChallengeResolver) {
          this.connectChallengeResolver(nonce);
        }
      }
      return;
    }

    if (frame.type !== "res") {
      return;
    }

    const id = asString(frame.id);
    if (!id) {
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    if (pending.expectFinal) {
      const payload = asObject(frame.payload);
      if (payload?.status === "accepted") {
        return;
      }
    }

    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (frame.ok === true) {
      pending.resolve(frame.payload);
      return;
    }

    const errorBody = asObject(frame.error);
    const message = asString(errorBody?.message) || `gateway method failed: ${pending.method}`;
    pending.reject(new Error(message));
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Bridges A2A inbound messages to OpenClaw agent dispatch.
 *
 * - Dispatches to an OpenClaw agent via Gateway RPC (agent server method)
 * - On success: publishes a complete Task with "completed" state and artifacts
 * - On dispatch failure: keeps legacy fallback text and attempts `/hooks/wake`
 */
export class OpenClawAgentExecutor implements AgentExecutor {
  private readonly api: OpenClawPluginApi;
  private readonly defaultAgentId: string;
  private readonly agentResponseTimeoutMs: number;
  private readonly taskContextByTaskId: Map<string, string>;

  constructor(api: OpenClawPluginApi, config: GatewayConfig) {
    this.api = api;
    this.defaultAgentId = config.routing.defaultAgentId;

    const configured = config.timeouts?.agentResponseTimeoutMs;
    this.agentResponseTimeoutMs =
      typeof configured === "number" && Number.isFinite(configured) && configured >= 1000
        ? configured
        : DEFAULT_AGENT_RESPONSE_TIMEOUT_MS;

    this.taskContextByTaskId = new Map();
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const agentId = pickAgentId(requestContext, this.defaultAgentId);
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    this.rememberTaskContext(taskId, contextId);

    // Publish initial "working" state so the task is trackable during async dispatch
    const workingTask: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "working",
        timestamp: new Date().toISOString(),
      },
    };
    eventBus.publish(workingTask);

    let agentResponse: AgentResponse;

    try {
      agentResponse = await this.dispatchViaGatewayRpc(agentId, requestContext.userMessage, contextId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.api.logger.error(`a2a-gateway: agent dispatch failed: ${errorMessage}`);
      await this.tryHooksWakeFallback(agentId, taskId, contextId, requestContext.userMessage);

      // Return failed task status so the caller knows dispatch did not succeed.
      const failedMessage: Message = {
        kind: "message",
        messageId: uuidv4(),
        role: "agent",
        parts: [{ kind: "text", text: `Agent dispatch failed: ${errorMessage}` }],
        contextId,
      };

      const failedTask: Task = {
        kind: "task",
        id: taskId,
        contextId,
        status: {
          state: "failed",
          message: failedMessage,
          timestamp: new Date().toISOString(),
        },
      };

      eventBus.publish(failedTask);
      eventBus.finished();
      return;
    }

    // Publish completed Task with artifact (text + optional file parts)
    const responseParts = buildResponseParts(agentResponse);

    const responseMessage: Message = {
      kind: "message",
      messageId: uuidv4(),
      role: "agent",
      parts: responseParts,
      contextId,
    };

    const completedTask: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "completed",
        message: responseMessage,
        timestamp: new Date().toISOString(),
      },
      artifacts: [
        {
          artifactId: uuidv4(),
          parts: responseParts,
        },
      ],
    };

    eventBus.publish(completedTask);
    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const contextId = this.taskContextByTaskId.get(taskId);
    if (!contextId) {
      this.api.logger.warn(
        `a2a-gateway: cancelTask missing contextId for task ${taskId}; skipping cancel publish`,
      );
      eventBus.finished();
      return;
    }

    const canceledTask: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "canceled",
        timestamp: new Date().toISOString(),
      },
    };
    eventBus.publish(canceledTask);
    this.taskContextByTaskId.delete(taskId);
    eventBus.finished();
  }


  private rememberTaskContext(taskId: string, contextId: string): void {
    if (this.taskContextByTaskId.has(taskId)) {
      this.taskContextByTaskId.delete(taskId);
    }
    this.taskContextByTaskId.set(taskId, contextId);
    if (this.taskContextByTaskId.size > TASK_CONTEXT_CACHE_LIMIT) {
      const oldestTaskId = this.taskContextByTaskId.keys().next().value;
      if (oldestTaskId) {
        this.taskContextByTaskId.delete(oldestTaskId);
      }
    }
  }


  private async dispatchViaGatewayRpc(
    agentId: string,
    userMessage: unknown,
    contextId: string,
  ): Promise<AgentResponse> {
    const messageText = extractInboundMessageText(userMessage);
    const gatewayConfig = this.resolveGatewayRuntimeConfig();
    const gateway = new GatewayRpcConnection(gatewayConfig);

    await gateway.connect();

    try {
      // Derive a deterministic session key from A2A contextId for:
      // 1. Session reuse across messages in the same A2A context (conversation continuity)
      // 2. Isolation between different A2A contexts (no cross-contamination)
      // The gateway `agent` RPC auto-creates the session if it doesn't exist.
      const sessionKey = `agent:${agentId}:a2a:${contextId}`;

      const runId = uuidv4();
      const agentParams: Record<string, unknown> = {
        agentId,
        message: messageText,
        deliver: false,
        idempotencyKey: runId,
        sessionKey,
      };

      const finalPayload = await gateway.request(
        "agent",
        agentParams,
        this.agentResponseTimeoutMs,
        true,
      );
      const finalBody = asObject(finalPayload);
      const status = asString(finalBody?.status);
      if (status && status !== "ok") {
        const summary = asString(finalBody?.summary) || "Agent run did not complete";
        throw new Error(summary);
      }

      const agentResponse = extractAgentResponse(finalPayload);
      if (agentResponse) {
        return agentResponse;
      }

      // sessionKey is always available (deterministic from contextId),
      // so we can always try to retrieve the latest assistant reply from history.
      const historyPayload = await gateway.request(
        "chat.history",
        { sessionKey, limit: 50 },
        GATEWAY_REQUEST_TIMEOUT_MS,
        false,
      );
      const historyText = extractLatestAssistantReply(historyPayload);
      if (historyText) {
        return { text: historyText, mediaUrls: [] };
      }

      throw new Error("No assistant response text returned by gateway");
    } finally {
      gateway.close();
    }
  }

  private resolveGatewayRuntimeConfig(): GatewayRuntimeConfig {
    const config = asObject(this.api.config) || {};
    const gateway = asObject(config.gateway) || {};
    const gatewayAuth = asObject(gateway.auth) || {};
    const hooks = asObject(config.hooks) || {};
    const gatewayTls = asObject(gateway.tls) || {};

    const port = asFiniteNumber(gateway.port) || 18_789;
    const tlsEnabled = gatewayTls.enabled === true;
    const scheme = tlsEnabled ? "wss" : "ws";

    return {
      port,
      wsUrl: `${scheme}://localhost:${port}`,
      hooksWakeUrl: `http://localhost:${port}/hooks/wake`,
      gatewayToken: asString(gatewayAuth.token) || "",
      gatewayPassword: asString(gatewayAuth.password) || "",
      hooksToken: asString(hooks.token) || "",
    };
  }

  private async tryHooksWakeFallback(
    agentId: string,
    taskId: string,
    contextId: string,
    userMessage: unknown,
  ): Promise<void> {
    const config = this.resolveGatewayRuntimeConfig();
    if (!config.hooksToken) {
      return;
    }

    const text = extractInboundMessageText(userMessage);
    const wakeText = `[A2A_INBOUND] agentId=${agentId} taskId=${taskId} contextId=${contextId} message=${text}`;

    try {
      await fetch(config.hooksWakeUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.hooksToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: wakeText }),
        signal: AbortSignal.timeout(HOOKS_WAKE_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.api.logger.warn(`a2a-gateway: hooks/wake fallback failed (${message})`);
    }
  }
}
