/**
 * Unit tests for src/file-security.ts
 *
 * Covers: isPrivateIp, validateUri, validateMimeType, checkFileSize,
 * detectMimeType, sanitizeUriForLog, sanitizeFilePartForLog.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPrivateIp,
  validateUri,
  validateUriSchemeAndIp,
  validateMimeType,
  checkFileSize,
  decodedBase64Size,
  detectMimeType,
  sanitizeUriForLog,
  sanitizeFilePartForLog,
} from "../src/file-security.js";
import type { FileSecurityConfig } from "../src/types.js";

function defaultConfig(overrides?: Partial<FileSecurityConfig>): FileSecurityConfig {
  return {
    allowedMimeTypes: ["image/*", "application/pdf", "text/plain", "text/csv", "application/json", "audio/*", "video/*"],
    maxFileSizeBytes: 52_428_800,
    maxInlineFileSizeBytes: 10_485_760,
    fileUriAllowlist: [],
    ...overrides,
  };
}

// Mock DNS resolver
const mockResolve = (ip: string) => async (_hostname: string) => ({ address: ip });

// ---------------------------------------------------------------------------
// isPrivateIp
// ---------------------------------------------------------------------------

describe("isPrivateIp", () => {
  it("blocks 127.0.0.1 (loopback)", () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
  });

  it("blocks 10.0.0.1 (class A private)", () => {
    assert.equal(isPrivateIp("10.0.0.1"), true);
  });

  it("blocks 172.16.0.1 (class B private)", () => {
    assert.equal(isPrivateIp("172.16.0.1"), true);
  });

  it("blocks 192.168.1.1 (class C private)", () => {
    assert.equal(isPrivateIp("192.168.1.1"), true);
  });

  it("blocks 169.254.1.1 (link-local)", () => {
    assert.equal(isPrivateIp("169.254.1.1"), true);
  });

  it("blocks 0.0.0.0", () => {
    assert.equal(isPrivateIp("0.0.0.0"), true);
  });

  it("blocks ::1 (IPv6 loopback)", () => {
    assert.equal(isPrivateIp("::1"), true);
  });

  it("blocks fc00::1 (IPv6 unique local)", () => {
    assert.equal(isPrivateIp("fc00::1"), true);
  });

  it("blocks fe80::1 (IPv6 link-local)", () => {
    assert.equal(isPrivateIp("fe80::1"), true);
  });

  it("blocks ::ffff:127.0.0.1 (IPv4-mapped IPv6)", () => {
    assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  });

  it("blocks ::ffff:10.0.0.1 (IPv4-mapped IPv6 private)", () => {
    assert.equal(isPrivateIp("::ffff:10.0.0.1"), true);
  });

  it("allows 8.8.8.8 (public IPv4)", () => {
    assert.equal(isPrivateIp("8.8.8.8"), false);
  });

  it("allows 2607:f8b0:4004:800::200e (public IPv6)", () => {
    assert.equal(isPrivateIp("2607:f8b0:4004:800::200e"), false);
  });

  it("blocks 172.31.255.255 (end of 172.16/12 range)", () => {
    assert.equal(isPrivateIp("172.31.255.255"), true);
  });

  it("allows 172.32.0.1 (outside 172.16/12 range)", () => {
    assert.equal(isPrivateIp("172.32.0.1"), false);
  });
});

// ---------------------------------------------------------------------------
// validateUriSchemeAndIp (inbound — IPv6 bracket handling)
// ---------------------------------------------------------------------------

describe("validateUriSchemeAndIp", () => {
  it("blocks http://[::1]/x (IPv6 loopback with brackets)", () => {
    const result = validateUriSchemeAndIp("http://[::1]/x");
    assert.notEqual(result, null);
    assert.match(result!, /private IP/i);
  });

  it("blocks http://[::ffff:127.0.0.1]/x (IPv4-mapped IPv6 with brackets)", () => {
    const result = validateUriSchemeAndIp("http://[::ffff:127.0.0.1]/x");
    assert.notEqual(result, null);
    assert.match(result!, /private IP/i);
  });

  it("allows http://[2607:f8b0::1]/x (public IPv6 with brackets)", () => {
    const result = validateUriSchemeAndIp("http://[2607:f8b0::1]/x");
    assert.equal(result, null);
  });

  it("blocks file:// scheme", () => {
    const result = validateUriSchemeAndIp("file:///etc/passwd");
    assert.notEqual(result, null);
    assert.match(result!, /Blocked scheme/);
  });

  it("allows normal hostname (no DNS check)", () => {
    const result = validateUriSchemeAndIp("https://example.com/file.txt");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// decodedBase64Size
// ---------------------------------------------------------------------------

describe("decodedBase64Size", () => {
  it("handles no padding", () => {
    // "YWJj" decodes to "abc" = 3 bytes
    assert.equal(decodedBase64Size("YWJj"), 3);
  });

  it("handles single padding", () => {
    // "YQ==" decodes to "a" = 1 byte
    assert.equal(decodedBase64Size("YQ=="), 1);
  });

  it("handles double padding", () => {
    // "YWI=" decodes to "ab" = 2 bytes
    assert.equal(decodedBase64Size("YWI="), 2);
  });

  it("handles empty string", () => {
    assert.equal(decodedBase64Size(""), 0);
  });
});

// ---------------------------------------------------------------------------
// validateUri
// ---------------------------------------------------------------------------

describe("validateUri", () => {
  it("rejects file:// scheme", async () => {
    const result = await validateUri("file:///etc/passwd", defaultConfig());
    assert.equal(result.ok, false);
    assert.match(result.reason!, /Blocked scheme/);
  });

  it("rejects ftp:// scheme", async () => {
    const result = await validateUri("ftp://evil.com/file", defaultConfig());
    assert.equal(result.ok, false);
    assert.match(result.reason!, /Blocked scheme/);
  });

  it("rejects invalid URI", async () => {
    const result = await validateUri("not-a-url", defaultConfig());
    assert.equal(result.ok, false);
    assert.match(result.reason!, /Invalid URI/);
  });

  it("rejects private IP in URL", async () => {
    const result = await validateUri("http://127.0.0.1/file.txt", defaultConfig());
    assert.equal(result.ok, false);
    assert.match(result.reason!, /private IP/i);
  });

  it("rejects hostname resolving to private IP", async () => {
    const result = await validateUri(
      "https://evil.com/file.txt",
      defaultConfig(),
      mockResolve("10.0.0.1"),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason!, /private IP/i);
  });

  it("allows valid public URL", async () => {
    const result = await validateUri(
      "https://cdn.example.com/image.png",
      defaultConfig(),
      mockResolve("93.184.216.34"),
    );
    assert.equal(result.ok, true);
  });

  it("enforces URI allowlist", async () => {
    const config = defaultConfig({ fileUriAllowlist: ["*.trusted.com"] });
    const result = await validateUri(
      "https://evil.com/file.txt",
      config,
      mockResolve("93.184.216.34"),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason!, /not in URI allowlist/);
  });

  it("allows hostname matching allowlist wildcard", async () => {
    const config = defaultConfig({ fileUriAllowlist: ["*.trusted.com"] });
    const result = await validateUri(
      "https://cdn.trusted.com/file.png",
      config,
      mockResolve("93.184.216.34"),
    );
    assert.equal(result.ok, true);
  });

  it("handles DNS resolution failure", async () => {
    const failResolve = async () => { throw new Error("ENOTFOUND"); };
    const result = await validateUri("https://nonexistent.test/file", defaultConfig(), failResolve);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /DNS resolution failed/);
  });

  it("blocks IPv6 loopback with brackets in URL", async () => {
    const result = await validateUri("http://[::1]/file.txt", defaultConfig());
    assert.equal(result.ok, false);
    assert.match(result.reason!, /private IP/i);
  });

  it("blocks IPv4-mapped IPv6 with brackets", async () => {
    const result = await validateUri("http://[::ffff:127.0.0.1]/file.txt", defaultConfig());
    assert.equal(result.ok, false);
    assert.match(result.reason!, /private IP/i);
  });
});

// ---------------------------------------------------------------------------
// validateMimeType
// ---------------------------------------------------------------------------

describe("validateMimeType", () => {
  const patterns = ["image/*", "application/pdf", "text/plain"];

  it("matches wildcard subtype", () => {
    assert.equal(validateMimeType("image/png", patterns), true);
    assert.equal(validateMimeType("image/jpeg", patterns), true);
  });

  it("matches exact type", () => {
    assert.equal(validateMimeType("application/pdf", patterns), true);
  });

  it("rejects unlisted type", () => {
    assert.equal(validateMimeType("application/x-executable", patterns), false);
  });

  it("is case-insensitive", () => {
    assert.equal(validateMimeType("IMAGE/PNG", patterns), true);
    assert.equal(validateMimeType("Application/PDF", patterns), true);
  });

  it("rejects empty MIME type", () => {
    assert.equal(validateMimeType("", patterns), false);
  });

  it("strips MIME parameters before matching (wildcard)", () => {
    assert.equal(validateMimeType("image/png;charset=utf-8", patterns), true);
  });

  it("strips MIME parameters before matching (exact)", () => {
    assert.equal(validateMimeType("text/plain; charset=utf-8", patterns), true);
  });
});

// ---------------------------------------------------------------------------
// checkFileSize
// ---------------------------------------------------------------------------

describe("checkFileSize", () => {
  it("allows file within limit", () => {
    const result = checkFileSize(1_000_000, 10_000_000);
    assert.equal(result.ok, true);
  });

  it("allows file exactly at limit", () => {
    const result = checkFileSize(10_000_000, 10_000_000);
    assert.equal(result.ok, true);
  });

  it("rejects file exceeding limit", () => {
    const result = checkFileSize(10_000_001, 10_000_000);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /exceeds limit/);
  });
});

// ---------------------------------------------------------------------------
// detectMimeType
// ---------------------------------------------------------------------------

describe("detectMimeType", () => {
  it("detects .pdf", () => {
    assert.equal(detectMimeType("report.pdf"), "application/pdf");
  });

  it("detects .png", () => {
    assert.equal(detectMimeType("image.png"), "image/png");
  });

  it("detects .jpg", () => {
    assert.equal(detectMimeType("photo.jpg"), "image/jpeg");
  });

  it("detects .mp4", () => {
    assert.equal(detectMimeType("video.mp4"), "video/mp4");
  });

  it("returns octet-stream for unknown", () => {
    assert.equal(detectMimeType("file.xyz123"), "application/octet-stream");
  });

  it("is case-insensitive on extension", () => {
    assert.equal(detectMimeType("photo.PNG"), "image/png");
  });
});

// ---------------------------------------------------------------------------
// sanitizeUriForLog
// ---------------------------------------------------------------------------

describe("sanitizeUriForLog", () => {
  it("returns short URI without query unchanged", () => {
    const uri = "https://example.com/file.png";
    assert.equal(sanitizeUriForLog(uri), uri);
  });

  it("strips query string (may contain tokens)", () => {
    const uri = "https://cdn.example.com/file.pdf?token=secret123&sig=abc";
    const result = sanitizeUriForLog(uri);
    assert.ok(!result.includes("secret123"));
    assert.ok(!result.includes("sig=abc"));
    assert.ok(result.includes("cdn.example.com/file.pdf"));
  });

  it("strips credentials from URI", () => {
    const uri = "https://user:password@cdn.example.com/file.pdf";
    const result = sanitizeUriForLog(uri);
    assert.ok(!result.includes("user:password"));
    assert.ok(result.includes("cdn.example.com/file.pdf"));
  });

  it("truncates long URI after cleaning", () => {
    const uri = "https://example.com/" + "a".repeat(300);
    const result = sanitizeUriForLog(uri);
    assert.ok(result.length <= 203); // 200 + "..."
    assert.ok(result.endsWith("..."));
  });

  it("handles unparseable URI by truncating", () => {
    const uri = "not-a-url-" + "x".repeat(300);
    const result = sanitizeUriForLog(uri);
    assert.ok(result.length <= 203);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFilePartForLog
// ---------------------------------------------------------------------------

describe("sanitizeFilePartForLog", () => {
  it("redacts base64 bytes", () => {
    const part = {
      kind: "file",
      file: { bytes: "aGVsbG8=", mimeType: "image/png", name: "test.png" },
    };
    const sanitized = sanitizeFilePartForLog(part);
    const file = sanitized.file as Record<string, unknown>;
    assert.equal(file.bytes, "[REDACTED]");
    assert.equal(file.mimeType, "image/png");
  });

  it("truncates long URI", () => {
    const longUri = "https://example.com/" + "x".repeat(300);
    const part = {
      kind: "file",
      file: { uri: longUri, name: "test.png" },
    };
    const sanitized = sanitizeFilePartForLog(part);
    const file = sanitized.file as Record<string, unknown>;
    assert.ok((file.uri as string).length <= 203);
  });

  it("does not mutate original", () => {
    const bytes = "aGVsbG8=";
    const part = { kind: "file", file: { bytes, name: "test.png" } };
    sanitizeFilePartForLog(part);
    assert.equal((part.file as any).bytes, bytes);
  });
});
