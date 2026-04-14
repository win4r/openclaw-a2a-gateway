import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { Message, Part, Task } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";

import type { GatewayConfig, OpenClawPluginApi } from "./types.js";
import {
  validateMimeType,
  validateUriSchemeAndIp,
  checkFileSize,
  decodedBase64Size,
  sanitizeUriForLog,
} from "./file-security.js";

const DEFAULT_AGENT_RESPONSE_TIMEOUT_MS = 300_000;
const GATEWAY_CONNECT_TIMEOUT_MS = 10_000;
const GATEWAY_REQUEST_TIMEOUT_MS = 10_000;
const HOOKS_WAKE_TIMEOUT_MS = 5_000;
const TASK_CONTEXT_CACHE_LIMIT = 10_000;

/**
 * Interval for SSE heartbeat events during agent dispatch.
 * Keeps the SSE connection alive and signals clients the task is still working.
 */
const STREAMING_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Maximum number of messages retained in task history.
 * Prevents unbounded growth in long-running conversations.
 * The SDK's tasks/get historyLength param can further trim on read.
 */
const MAX_HISTORY_MESSAGES = 200;

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
    const sizeKB = Math.ceil(decodedBase64Size(bytes) / 1024);
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
 * File extensions that indicate a URL points to a downloadable file rather
 * than a regular web page. Only URLs ending with one of these extensions
 * (case-insensitive) are promoted to FileParts.
 */
const FILE_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg",
  ".csv", ".json", ".xml", ".yaml", ".yml",
  ".zip", ".gz", ".tar", ".rar", ".7z",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".txt", ".md", ".rtf",
  ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".aac", ".webm", ".avi", ".mov",
]);

/**
 * Extract file URLs from agent text content. Captures:
 * 1. Markdown links: `[text](url)` → the url portion
 * 2. Bare URLs: `https?://...` not already inside markdown link parentheses
 *
 * Only URLs that end with a recognized file extension are returned.
 * Results are deduplicated and any URLs already present in `existingUrls`
 * are excluded to avoid duplicate FileParts.
 */
export function extractUrlsFromText(text: string, existingUrls: string[] = []): string[] {
  const existingSet = new Set(existingUrls);
  const seen = new Set<string>();
  const result: string[] = [];

  // 1. Extract markdown link URLs: [text](url)
  const mdLinkRe = /\[(?:[^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdLinkRe.exec(text)) !== null) {
    const url = match[1];
    if (!seen.has(url)) {
      seen.add(url);
    }
  }

  // 2. Extract bare URLs not inside markdown link parentheses.
  // We replace markdown links first to avoid double-matching.
  const textWithoutMdLinks = text.replace(/\[(?:[^\]]*)\]\(https?:\/\/[^)]+\)/g, "");
  const bareUrlRe = /https?:\/\/[^\s<>"')\]]+/g;
  while ((match = bareUrlRe.exec(textWithoutMdLinks)) !== null) {
    const url = match[0];
    if (!seen.has(url)) {
      seen.add(url);
    }
  }

  // Filter to file URLs only and exclude already-known media URLs
  for (const url of seen) {
    // Extract the path portion (before query string / fragment)
    const pathPart = url.split("?")[0].split("#")[0];
    const dotIdx = pathPart.lastIndexOf(".");
    if (dotIdx === -1) continue;

    const ext = pathPart.slice(dotIdx).toLowerCase();
    if (FILE_EXTENSIONS.has(ext) && !existingSet.has(url)) {
      result.push(url);
    }
  }

  return result;
}

/**
 * Build A2A Part array from an AgentResponse. Produces TextPart for text
 * content, FilePart entries for each media URL, and additional FileParts
 * for file URLs discovered in the text content.
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

  // Extract file URLs from text that are not already in mediaUrls
  if (response.text) {
    const textUrls = extractUrlsFromText(response.text, response.mediaUrls);
    for (const url of textUrls) {
      parts.push({
        kind: "file",
        file: { uri: url },
      });
    }
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

/**
 * Lazily generated Ed25519 device identity for this plugin instance.
 * Persisted in-memory for the lifetime of the process so all connections
 * from this gateway share the same device id and auto-pair only once.
 */
let cachedDeviceIdentity: { publicKey: string; privateKey: crypto.KeyObject; deviceId: string } | null = null;

function getOrCreateDeviceIdentity(): { publicKey: string; privateKey: crypto.KeyObject; deviceId: string } {
  if (cachedDeviceIdentity) return cachedDeviceIdentity;

  // Try to load OpenClaw's own device identity first (so the gateway recognises us as a paired device).
  const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  const deviceJsonPath = path.join(openclawHome, "identity", "device.json");
  try {
    const raw = fs.readFileSync(deviceJsonPath, "utf-8");
    const json = JSON.parse(raw) as { deviceId?: string; publicKeyPem?: string; privateKeyPem?: string };
    if (json.deviceId && json.publicKeyPem && json.privateKeyPem) {
      const privateKey = crypto.createPrivateKey(json.privateKeyPem);
      const publicKey = crypto.createPublicKey(json.publicKeyPem);
      const publicKeyRaw = publicKey.export({ type: "spki", format: "der" });
      const rawBytes = publicKeyRaw.subarray(12);
      const publicKeyB64Url = rawBytes.toString("base64url");
      cachedDeviceIdentity = { publicKey: publicKeyB64Url, privateKey, deviceId: json.deviceId };
      return cachedDeviceIdentity;
    }
  } catch {
    // Fall through to ephemeral key generation
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" });
  // Ed25519 SPKI DER has a 12-byte header; the raw 32-byte key starts at offset 12
  const rawBytes = publicKeyRaw.subarray(12);
  const publicKeyB64Url = rawBytes.toString("base64url");
  const deviceId = crypto
    .createHash("sha256")
    .update(rawBytes)
    .digest("hex");

  cachedDeviceIdentity = { publicKey: publicKeyB64Url, privateKey, deviceId };
  return cachedDeviceIdentity;
}

export class GatewayRpcConnection {
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
  private challengeNonce: string;

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
    this.challengeNonce = "";
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

    try {
      const connectResult = await this.request("connect", this.buildConnectParams(true), GATEWAY_CONNECT_TIMEOUT_MS, false);

      // Verify scopes were preserved — OpenClaw ≥2026.3.13 may silently
      // downgrade scopes when the device identity is not recognized (e.g.
      // cross-machine setups where device.json belongs to a different host).
      if (this.isOperatorWriteMissing(connectResult)) {
        this.challengeNonce = "";
        await this.reconnect();

        // If token-only reconnect also lacks operator.write, surface a clear error
        // so the user knows device pairing is required.
        return;
      }
    } catch (connectError: unknown) {
      const msg = connectError instanceof Error ? connectError.message : String(connectError);
      // On older gateways (≤2026.3.11), sending a device identity may trigger
      // "pairing required" if silent auto-pairing is not supported.
      // Also match variants introduced in later gateway versions.
      if (
        msg.includes("pairing required") ||
        msg.includes("device identity required") ||
        msg.includes("device not paired") ||
        msg.includes("unknown device") ||
        msg.includes("identity verification failed")
      ) {
        this.challengeNonce = "";
        await this.reconnect();
        return;
      }
      throw connectError;
    }
  }

  /**
   * Reconnect without device identity (fallback for gateways that reject unpaired devices).
   */
  private async reconnect(): Promise<void> {
    this.close();

    const ctor = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!ctor) throw new Error("WebSocket runtime is unavailable");

    const socket = new ctor(this.wsUrl);
    this.socket = socket;
    this.messageListener = (event) => { this.handleMessage(event); };
    this.closeListener = () => {
      const error = new Error("gateway connection closed");
      this.rejectConnectChallenge(error);
      this.rejectAllPending(error);
    };
    socket.addEventListener("message", this.messageListener);
    socket.addEventListener("close", this.closeListener);

    const challengePromise = this.awaitConnectChallenge();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        if (error) { this.rejectConnectChallenge(error); reject(error); return; }
        resolve();
      };
      const onOpen = () => settle();
      const onError = () => settle(new Error("failed to open gateway websocket"));
      const onClose = () => settle(new Error("gateway websocket closed during connect"));
      const timer = setTimeout(() => settle(new Error("gateway websocket connect timed out")), GATEWAY_CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });

    await challengePromise;
    const reconnectResult = await this.request("connect", this.buildConnectParams(false), GATEWAY_CONNECT_TIMEOUT_MS, false);

    // If token-only auth also fails to preserve scopes, the gateway requires
    // a paired device identity.  Surface a clear error so the operator knows
    // what to do rather than getting a cryptic "missing scope" later.
    if (this.isOperatorWriteMissing(reconnectResult)) {
      throw new Error(
        "Gateway connected but operator.write scope was not granted. "
        + "On OpenClaw ≥2026.3.13, cross-machine connections require a paired "
        + "device identity. Run 'openclaw pair' on the gateway host or copy "
        + "~/.openclaw/identity/device.json from the gateway machine."
      );
    }
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
      this.connectChallengeResolver = (nonce: string) => {
        this.challengeNonce = nonce;
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

  private buildConnectParams(includeDevice: boolean = true): Record<string, unknown> {
    const auth: Record<string, string> = {};
    if (this.gatewayToken) {
      auth.token = this.gatewayToken;
    }
    if (this.gatewayPassword) {
      auth.password = this.gatewayPassword;
    }

    const role = "operator";
    const scopes = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];

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
      role,
      scopes,
    };

    if (Object.keys(auth).length > 0) {
      params.auth = auth;
    }

    // Build device identity so the gateway preserves requested scopes.
    // Without this, OpenClaw ≥2026.3.13 clears scopes for connections
    // that lack a device identity, causing "missing scope: operator.write".
    // See: https://github.com/win4r/openclaw-a2a-gateway/issues/29
    const nonce = this.challengeNonce;
    if (includeDevice && nonce) {
      const identity = getOrCreateDeviceIdentity();
      const signedAtMs = Date.now();

      // Build the v3 signature payload — must match buildDeviceAuthPayloadV3 in OpenClaw core
      const payloadParts = [
        "v3",
        identity.deviceId,
        "cli",                          // clientId
        "cli",                          // clientMode
        role,
        scopes.join(","),
        String(signedAtMs),
        auth.token || "",               // token from shared auth
        nonce,
        process.platform,               // platform
        "",                             // deviceFamily (empty)
      ];
      const payload = payloadParts.join("|");

      const signature = crypto.sign(null, Buffer.from(payload), identity.privateKey);
      const signatureB64Url = signature.toString("base64url");

      params.device = {
        id: identity.deviceId,
        publicKey: identity.publicKey,
        signedAt: signedAtMs,
        nonce,
        signature: signatureB64Url,
      };
    }

    return params;
  }

  /**
   * Check whether the connect response indicates that operator.write was
   * not granted.  Returns true only when the response explicitly lists
   * granted scopes AND operator.write is absent — i.e. a silent downgrade.
   * If the response does not contain scope information (older gateways)
   * we conservatively return false (assume scopes are fine).
   */
  private isOperatorWriteMissing(connectResult: unknown): boolean {
    const obj = asObject(connectResult);
    if (!obj) return false;
    const scopes = obj.scopes;
    if (!Array.isArray(scopes)) return false;
    return !scopes.includes("operator.write");
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

// ---------------------------------------------------------------------------
// WebSocket connection pool — reuses GatewayRpcConnection across dispatches
// ---------------------------------------------------------------------------

export interface WsPoolConfig {
  /** Maximum idle time (ms) before a pooled connection is evicted. Default: 300_000 (5 min) */
  idleTimeoutMs?: number;
  /** Interval (ms) between heartbeat pings on an idle connection. Default: 60_000 (1 min) */
  heartbeatIntervalMs?: number;
  /** Maximum number of reconnection attempts before giving up on a connection. Default: 2 */
  maxReconnectAttempts?: number;
}

export interface WsPoolStats {
  connections: number;
  idleConnections: number;
  activeConnections: number;
  hitRate: number;
  totalAcquires: number;
  totalReuses: number;
  totalReconnects: number;
}

interface PooledConnection {
  conn: GatewayRpcConnection;
  key: string;
  lastUsedAt: number;
  isActive: boolean;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  evictionTimer: ReturnType<typeof setTimeout> | null;
  reconnectCount: number;
}

/**
 * Pool that shares GatewayRpcConnection instances keyed by (wsUrl + token + password).
 *
 * Without pooling, every `dispatchViaGatewayRpc()` call creates a fresh WebSocket
 * connection: TCP handshake + WS upgrade + Ed25519 challenge + `connect` RPC ≈ 100–200 ms
 * of pure overhead on localhost, much more over the network.  By reusing a persistent
 * connection, subsequent dispatches skip all of that and send the `agent` RPC frame
 * directly on the existing socket.
 *
 * The pool also provides:
 * - **Heartbeat** — periodic `echo` RPC to keep the connection alive during idle periods.
 * - **Auto-reconnect** — transparently recreates a dropped connection before the next dispatch.
 * - **Idle eviction** — gracefully closes connections that have been idle longer than
 *   `idleTimeoutMs`, freeing resources on both the client and the gateway.
 */
export class GatewayRpcConnectionPool {
  private readonly pool = new Map<string, PooledConnection>();
  private readonly idleTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private destroyed = false;

  private totalAcquires = 0;
  private totalReuses = 0;
  private totalReconnects = 0;

  constructor(config: WsPoolConfig = {}) {
    this.idleTimeoutMs = config.idleTimeoutMs ?? 300_000;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 60_000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 2;
  }

  /**
   * Acquire a connected GatewayRpcConnection for the given config.
   *
   * - If a healthy pooled connection exists for the key, it is returned immediately (hot path).
   * - If the pooled connection is dead, it is evicted and a fresh one is created + connected.
   * - If no pooled connection exists, a new one is created + connected.
   *
   * Callers MUST call `release()` when done so the connection returns to the pool.
   */
  async acquire(config: GatewayRuntimeConfig): Promise<GatewayRpcConnection> {
    if (this.destroyed) {
      throw new Error("GatewayRpcConnectionPool has been destroyed");
    }

    const key = this.buildKey(config);
    this.totalAcquires++;

    const existing = this.pool.get(key);

    // Hot path: reuse healthy connection
    if (existing && existing.conn && existing.conn["socket"]?.readyState === 1) {
      existing.isActive = true;
      existing.lastUsedAt = Date.now();
      this.stopHeartbeat(existing);
      this.resetEviction(existing);
      this.totalReuses++;
      return existing.conn;
    }

    // Cold path: evict dead connection, create fresh one
    if (existing) {
      this.evictConnection(existing);
    }

    const conn = await this.createAndConnect(config, 0);
    const entry: PooledConnection = {
      conn,
      key,
      lastUsedAt: Date.now(),
      isActive: true,
      heartbeatTimer: null,
      evictionTimer: null,
      reconnectCount: 0,
    };
    this.pool.set(key, entry);
    this.resetEviction(entry);
    return conn;
  }

  /**
   * Return a connection to the pool. After release, the connection may be
   * reused by the next acquire() call for the same key.
   */
  release(config: GatewayRuntimeConfig): void {
    if (this.destroyed) return;

    const key = this.buildKey(config);
    const entry = this.pool.get(key);
    if (!entry) return;

    entry.isActive = false;
    entry.lastUsedAt = Date.now();
    this.startHeartbeat(entry);
    this.resetEviction(entry);
  }

  getStats(): WsPoolStats {
    let idle = 0;
    let active = 0;
    for (const entry of this.pool.values()) {
      if (entry.isActive) active++;
      else idle++;
    }
    return {
      connections: this.pool.size,
      idleConnections: idle,
      activeConnections: active,
      hitRate: this.totalAcquires > 0 ? this.totalReuses / this.totalAcquires : 0,
      totalAcquires: this.totalAcquires,
      totalReuses: this.totalReuses,
      totalReconnects: this.totalReconnects,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const entry of this.pool.values()) {
      this.stopHeartbeat(entry);
      this.stopEviction(entry);
      try {
        entry.conn.close();
      } catch {
        // best-effort close during teardown
      }
    }
    this.pool.clear();
  }

  // -- Internal helpers -------------------------------------------------------

  private buildKey(config: GatewayRuntimeConfig): string {
    return `${config.wsUrl}::${config.gatewayToken}::${config.gatewayPassword}`;
  }

  private async createAndConnect(config: GatewayRuntimeConfig, attempt: number): Promise<GatewayRpcConnection> {
    const conn = new GatewayRpcConnection(config);
    try {
      await conn.connect();
      return conn;
    } catch (error) {
      if (attempt < this.maxReconnectAttempts) {
        this.totalReconnects++;
        // Exponential backoff: 100ms, 200ms, 400ms…
        const delay = 100 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        return this.createAndConnect(config, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Check connection health. If the socket is dead, attempt a transparent reconnect.
   * Returns true if the connection is healthy (or was successfully reconnected).
   */
  private async ensureHealthy(entry: PooledConnection, config: GatewayRuntimeConfig): Promise<boolean> {
    if (entry.conn["socket"]?.readyState === 1) {
      return true;
    }

    // Connection is dead — reconnect
    if (entry.reconnectCount >= this.maxReconnectAttempts) {
      return false;
    }

    try {
      entry.conn.close();
    } catch {
      // ignore close errors on dead socket
    }

    entry.reconnectCount++;
    this.totalReconnects++;

    try {
      const conn = await this.createAndConnect(config, 0);
      entry.conn = conn;
      entry.lastUsedAt = Date.now();
      entry.reconnectCount = 0; // reset on successful reconnect
      return true;
    } catch {
      return false;
    }
  }

  private evictConnection(entry: PooledConnection): void {
    this.stopHeartbeat(entry);
    this.stopEviction(entry);
    try {
      entry.conn.close();
    } catch {
      // best-effort
    }
    this.pool.delete(entry.key);
  }

  private startHeartbeat(entry: PooledConnection): void {
    this.stopHeartbeat(entry);
    entry.heartbeatTimer = setInterval(() => {
      // Send a lightweight ping to keep the connection alive.
      // We use the `request` method with a minimal method — if the socket
      // is dead, the pending request will timeout and we'll learn about it.
      if (entry.conn["socket"]?.readyState !== 1) {
        // Socket is not open — stop heartbeat, let eviction or next acquire handle it
        this.stopHeartbeat(entry);
        return;
      }
      try {
        // Fire-and-forget heartbeat: we don't await the result.
        // A successful ping means the gateway is responsive.
        entry.conn.request("echo", { t: Date.now() }, 5_000, false).catch(() => {
          // Heartbeat failed — the connection is likely dead.
          // The next acquire() will detect and reconnect.
        });
      } catch {
        // Synchronous send error — socket is dead
        this.stopHeartbeat(entry);
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(entry: PooledConnection): void {
    if (entry.heartbeatTimer !== null) {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
    }
  }

  private resetEviction(entry: PooledConnection): void {
    this.stopEviction(entry);
    entry.evictionTimer = setTimeout(() => {
      if (!entry.isActive) {
        this.evictConnection(entry);
      }
    }, this.idleTimeoutMs);
  }

  private stopEviction(entry: PooledConnection): void {
    if (entry.evictionTimer !== null) {
      clearTimeout(entry.evictionTimer);
      entry.evictionTimer = null;
    }
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
  private readonly security: GatewayConfig["security"];
  private readonly taskContextByTaskId: Map<string, string>;
  private readonly wsPool: GatewayRpcConnectionPool;

  constructor(api: OpenClawPluginApi, config: GatewayConfig) {
    this.api = api;
    this.defaultAgentId = config.routing.defaultAgentId;
    this.security = config.security;

    const configured = config.timeouts?.agentResponseTimeoutMs;
    this.agentResponseTimeoutMs =
      typeof configured === "number" && Number.isFinite(configured) && configured >= 1000
        ? configured
        : DEFAULT_AGENT_RESPONSE_TIMEOUT_MS;

    this.taskContextByTaskId = new Map();
    this.wsPool = new GatewayRpcConnectionPool();
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const agentId = pickAgentId(requestContext, this.defaultAgentId);
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    this.rememberTaskContext(taskId, contextId);

    // Carry forward conversation history from previous rounds (if any).
    // The SDK's ResultManager replaces currentTask with { ...taskEvent }, so
    // omitting history would wipe out prior messages.
    //
    // IMPORTANT: The SDK's _createRequestContext already appends the current
    // user message to task.history before calling execute(). The ResultManager
    // then checks messageId to avoid double-adding. We rely on this dedup —
    // do NOT manually strip the current message from existingHistory.
    const rawHistory = requestContext.task?.history ?? [];
    const existingHistory = rawHistory.length > MAX_HISTORY_MESSAGES
      ? rawHistory.slice(-MAX_HISTORY_MESSAGES)
      : rawHistory;

    // Publish initial "working" state so the task is trackable during async dispatch
    const workingTask: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "working",
        timestamp: new Date().toISOString(),
      },
      history: existingHistory,
    };
    eventBus.publish(workingTask);

    // Validate inbound FileParts before dispatching to the agent
    const fileValidationError = this.validateInboundFileParts(requestContext.userMessage);
    if (fileValidationError) {
      this.api.logger.warn(`a2a-gateway: inbound file validation failed: ${fileValidationError}`);
      const rejectedMessage: Message = {
        kind: "message",
        messageId: uuidv4(),
        role: "agent",
        parts: [{ kind: "text", text: `File validation failed: ${fileValidationError}` }],
        contextId,
      };
      const rejectedTask: Task = {
        kind: "task",
        id: taskId,
        contextId,
        status: {
          state: "failed",
          message: rejectedMessage,
          timestamp: new Date().toISOString(),
        },
        history: existingHistory,
      };
      eventBus.publish(rejectedTask);
      eventBus.finished();
      return;
    }

    let agentResponse: AgentResponse;

    // Emit periodic heartbeat events while the agent is working.
    // This keeps SSE connections alive and signals that the task is still in progress.
    const heartbeat = setInterval(() => {
      const heartbeatTask: Task = {
        kind: "task",
        id: taskId,
        contextId,
        status: {
          state: "working",
          timestamp: new Date().toISOString(),
        },
        history: existingHistory,
      };
      eventBus.publish(heartbeatTask);
    }, STREAMING_HEARTBEAT_INTERVAL_MS);

    try {
      agentResponse = await this.dispatchViaGatewayRpc(agentId, requestContext.userMessage, contextId);
    } catch (err: unknown) {
      clearInterval(heartbeat);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const truncatedError = errorMessage.length > 500 ? errorMessage.slice(0, 500) + "..." : errorMessage;
      this.api.logger.error(`a2a-gateway: agent dispatch failed: ${truncatedError}`);
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
        history: existingHistory,
      };

      eventBus.publish(failedTask);
      eventBus.finished();
      return;
    }

    clearInterval(heartbeat);

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
      history: existingHistory,
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

  // cancelTask intentionally omits history: it only receives taskId (no
  // RequestContext), so loading history would require a TaskStore reference
  // that the executor doesn't hold. Cancellation is a terminal state where
  // consumers care about status, not conversation history.
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
    const gateway = await this.wsPool.acquire(gatewayConfig);

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
      this.wsPool.release(gatewayConfig);
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

  /**
   * Validate inbound FileParts for scheme/IP safety, MIME, and size.
   *
   * Inbound validation is lighter than outbound (a2a_send_file):
   * - Scheme + IP-literal check only (no DNS resolution — we don't fetch the URL)
   * - MIME whitelist
   * - Inline size limit
   */
  private validateInboundFileParts(userMessage: unknown): string | null {
    const parts = this.extractFileParts(userMessage);
    if (parts.length === 0) return null;

    for (const part of parts) {
      const file = asObject(part.file);
      if (!file) continue;

      const uri = asString(file.uri);
      const mimeType = asString(file.mimeType);
      const bytes = asString(file.bytes);

      // URI-based file: scheme + IP literal check + MIME
      if (uri) {
        const schemeCheck = validateUriSchemeAndIp(uri);
        if (schemeCheck) {
          return `URI blocked: ${sanitizeUriForLog(uri)} — ${schemeCheck}`;
        }
        if (mimeType && !validateMimeType(mimeType, this.security.allowedMimeTypes)) {
          return `MIME type rejected: "${mimeType}"`;
        }
      }

      // Inline base64 file: size + MIME check
      if (bytes) {
        const decodedSize = decodedBase64Size(bytes);
        const sizeCheck = checkFileSize(decodedSize, this.security.maxInlineFileSizeBytes);
        if (!sizeCheck.ok) {
          return `Inline file too large: ${sizeCheck.reason}`;
        }
        if (mimeType && !validateMimeType(mimeType, this.security.allowedMimeTypes)) {
          return `MIME type rejected: "${mimeType}"`;
        }
      }
    }

    return null;
  }

  private extractFileParts(value: unknown): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = [];
    if (!value || typeof value !== "object") return results;

    const obj = value as Record<string, unknown>;
    if (obj.kind === "file" && obj.file) {
      results.push(obj);
      return results;
    }

    const parts = Array.isArray(obj.parts) ? obj.parts : [];
    for (const p of parts) {
      if (p && typeof p === "object") {
        const part = p as Record<string, unknown>;
        if (part.kind === "file" && part.file) {
          results.push(part);
        }
      }
    }

    return results;
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
