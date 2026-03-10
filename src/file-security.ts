/**
 * A2A Gateway — File security: SSRF protection, MIME whitelist, size limits, log sanitization.
 *
 * All functions are pure or async-pure with no side effects beyond DNS resolution
 * and HTTP HEAD requests. Uses only Node.js built-in modules.
 */

import dns from "node:dns";
import net from "node:net";
import path from "node:path";

import type { FileSecurityConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface FileSecurityResult {
  ok: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Private IP detection
// ---------------------------------------------------------------------------

/**
 * Check whether an IP address belongs to a private/reserved range.
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 (::ffff:x.x.x.x).
 */
export function isPrivateIp(ip: string): boolean {
  // Handle IPv4-mapped IPv6
  const mappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (mappedMatch) {
    return isPrivateIpv4(mappedMatch[1]);
  }

  if (net.isIPv4(ip)) {
    return isPrivateIpv4(ip);
  }

  if (net.isIPv6(ip)) {
    return isPrivateIpv6(ip);
  }

  // Not a valid IP — treat as private (fail-closed)
  return true;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return true; // Malformed -> fail-closed
  }
  const [a, b] = parts;

  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;

  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = normalizeIpv6(ip);

  // ::1 (loopback)
  if (normalized === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
  // :: (unspecified)
  if (normalized === "0000:0000:0000:0000:0000:0000:0000:0000") return true;

  const firstSegment = parseInt(normalized.slice(0, 4), 16);

  // fc00::/7 (unique local)
  if ((firstSegment & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local)
  if ((firstSegment & 0xffc0) === 0xfe80) return true;

  // ::ffff:0:0/96 — IPv4-mapped IPv6 (check embedded IPv4)
  if (normalized.startsWith("0000:0000:0000:0000:0000:ffff:")) {
    const tail = normalized.slice(30); // e.g. "0a00:0001"
    const [hi, lo] = tail.split(":").map((s) => parseInt(s, 16));
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIpv4(ipv4);
  }

  return false;
}

function normalizeIpv6(ip: string): string {
  // Expand :: shorthand
  const halves = ip.split("::");
  let segments: string[];

  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    segments = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    segments = ip.split(":");
  }

  return segments.map((s) => s.padStart(4, "0").toLowerCase()).join(":");
}

// ---------------------------------------------------------------------------
// URI validation (SSRF protection)
// ---------------------------------------------------------------------------

/**
 * Synchronous URI check: scheme + IP literal only (no DNS resolution).
 * For inbound messages where we don't fetch the URL ourselves.
 * Returns null if OK, or a rejection reason string.
 */
export function validateUriSchemeAndIp(uri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return "Invalid URI";
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return `Blocked scheme: ${scheme.replace(":", "")}`;
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return "URI has no hostname";
  }

  // Only check IP literals (not hostnames — we don't DNS-resolve for inbound)
  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    return `Blocked private IP: ${hostname}`;
  }

  return null;
}

type DnsResolveFn = (hostname: string) => Promise<{ address: string }>;

const defaultResolveFn: DnsResolveFn = (hostname: string) =>
  dns.promises.lookup(hostname, { family: 0 });

/**
 * Validate a URI for SSRF safety.
 * - Only http/https schemes allowed
 * - Resolves hostname via DNS, blocks private IPs
 * - Checks hostname against allowlist (if configured)
 * - Optional resolveFn for testing
 */
export async function validateUri(
  uri: string,
  config: FileSecurityConfig,
  resolveFn: DnsResolveFn = defaultResolveFn,
): Promise<FileSecurityResult> {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, reason: "Invalid URI" };
  }

  // Scheme check
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return { ok: false, reason: `Blocked scheme: ${scheme.replace(":", "")}` };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return { ok: false, reason: "URI has no hostname" };
  }

  // Allowlist check (if configured)
  if (config.fileUriAllowlist.length > 0) {
    const allowed = config.fileUriAllowlist.some((pattern) => matchHostname(hostname, pattern));
    if (!allowed) {
      return { ok: false, reason: `Hostname "${hostname}" not in URI allowlist` };
    }
  }

  // If hostname is already an IP literal, check directly
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      return { ok: false, reason: `Blocked private IP: ${hostname}` };
    }
    return { ok: true };
  }

  // DNS resolution -> check resolved IP
  try {
    const { address } = await resolveFn(hostname);
    if (isPrivateIp(address)) {
      return { ok: false, reason: `Hostname "${hostname}" resolves to private IP ${address}` };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `DNS resolution failed for "${hostname}": ${msg}` };
  }

  return { ok: true };
}

function matchHostname(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();

  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) || h === p.slice(2);
  }

  return h === p;
}

// ---------------------------------------------------------------------------
// MIME validation
// ---------------------------------------------------------------------------

/**
 * Check if a MIME type matches any of the allowed patterns.
 * Supports wildcard subtype: "image/*" matches "image/png".
 */
export function validateMimeType(mimeType: string, allowedPatterns: string[]): boolean {
  const normalized = mimeType.toLowerCase().trim();

  for (const pattern of allowedPatterns) {
    const p = pattern.toLowerCase().trim();

    // Exact match
    if (normalized === p) return true;

    // Wildcard subtype: "image/*" matches "image/png"
    if (p.endsWith("/*")) {
      const prefix = p.slice(0, -1); // "image/"
      if (normalized.startsWith(prefix)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// File size checks
// ---------------------------------------------------------------------------

export function checkFileSize(sizeBytes: number, maxBytes: number): FileSecurityResult {
  if (sizeBytes > maxBytes) {
    const sizeMB = (sizeBytes / 1_048_576).toFixed(1);
    const maxMB = (maxBytes / 1_048_576).toFixed(1);
    return { ok: false, reason: `File size ${sizeMB}MB exceeds limit ${maxMB}MB` };
  }
  return { ok: true };
}

/**
 * Send an HTTP HEAD request to check Content-Length.
 * Fail-open: if HEAD fails or no Content-Length header, returns ok.
 */
export async function checkUriContentLength(
  uri: string,
  maxBytes: number,
): Promise<FileSecurityResult> {
  try {
    const response = await fetch(uri, {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    const cl = response.headers.get("content-length");
    if (cl) {
      const size = parseInt(cl, 10);
      if (Number.isFinite(size) && size > maxBytes) {
        const sizeMB = (size / 1_048_576).toFixed(1);
        const maxMB = (maxBytes / 1_048_576).toFixed(1);
        return { ok: false, reason: `File size ${sizeMB}MB exceeds limit ${maxMB}MB` };
      }
    }
  } catch {
    // Fail-open: cannot determine size, allow the request
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// MIME type detection (extension-based)
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
};

/** Detect MIME type from file path extension. */
export function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Log sanitization
// ---------------------------------------------------------------------------

/** Truncate a URI for safe logging. */
export function sanitizeUriForLog(uri: string, maxLength = 200): string {
  if (uri.length <= maxLength) return uri;
  return uri.slice(0, maxLength) + "...";
}

/**
 * Create a log-safe copy of a FilePart: strip base64 bytes, truncate URI.
 * Never mutates the original.
 */
export function sanitizeFilePartForLog(part: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...part };
  const file = part.file;
  if (file && typeof file === "object") {
    const fileCopy = { ...(file as Record<string, unknown>) };
    if ("bytes" in fileCopy) {
      fileCopy.bytes = "[REDACTED]";
    }
    if (typeof fileCopy.uri === "string") {
      fileCopy.uri = sanitizeUriForLog(fileCopy.uri);
    }
    clone.file = fileCopy;
  }
  return clone;
}
