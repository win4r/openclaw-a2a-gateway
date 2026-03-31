import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";

import {
  QuorumDiscoveryManager,
  parseQuorumConfig,
  QUORUM_DEFAULTS,
} from "../src/quorum-discovery.js";
import type { QuorumConfig } from "../src/quorum-discovery.js";
import { DnsDiscoveryManager } from "../src/dns-discovery.js";
import type { DnsDiscoveryConfig } from "../src/dns-discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLog: any = () => {};

function makeDnsConfig(overrides: Partial<DnsDiscoveryConfig> = {}): DnsDiscoveryConfig {
  return {
    enabled: true,
    serviceName: "_a2a._tcp.test.local",
    refreshIntervalMs: 600_000, // Very long — we drive refresh manually via quorum
    mergeWithStatic: true,
    ...overrides,
  };
}

function makeQuorumConfig(overrides: Partial<QuorumConfig> = {}): QuorumConfig {
  return {
    activateThreshold: 3,
    deactivateThreshold: 1,
    stableIntervalMs: 200, // Short for tests
    exploreIntervalMs: 50,
    ...overrides,
  };
}

/** Mock DNS to return `n` SRV records. */
function mockDnsPeers(n: number): void {
  dns.promises.resolveSrv = async () =>
    Array.from({ length: n }, (_, i) => ({
      name: `agent-${i}.local`,
      port: 18800 + i,
      priority: 10,
      weight: 10,
    }));
  dns.promises.resolveTxt = async () => [["protocol=jsonrpc"]];
}

/** Mock DNS to return ENODATA (no records) — keeps cached peers with valid TTL. */
function mockDnsNoop(): void {
  dns.promises.resolveSrv = async () => {
    const err: any = new Error("ENODATA");
    err.code = "ENODATA";
    throw err;
  };
  dns.promises.resolveTxt = async () => [];
}

/** Directly set discovered peers on a DnsDiscoveryManager (for deterministic tests). */
function setDiscoveredPeers(dnsMgr: DnsDiscoveryManager, count: number): void {
  const now = Date.now();
  (dnsMgr as any).discoveredPeers = Array.from({ length: count }, (_, i) => ({
    name: `agent-${i}`,
    host: `agent-${i}.local`,
    port: 18800 + i,
    agentCardUrl: `http://agent-${i}.local:${18800 + i}/.well-known/agent-card.json`,
    discoveredAt: now,
    ttl: 300,
  }));
}

// ---------------------------------------------------------------------------
// Save / restore DNS stubs
// ---------------------------------------------------------------------------

let origSrv: typeof dns.promises.resolveSrv;
let origTxt: typeof dns.promises.resolveTxt;

beforeEach(() => {
  origSrv = dns.promises.resolveSrv;
  origTxt = dns.promises.resolveTxt;
});

afterEach(() => {
  dns.promises.resolveSrv = origSrv;
  dns.promises.resolveTxt = origTxt;
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("QuorumDiscoveryManager constructor", () => {
  it("rejects deactivateThreshold >= activateThreshold", () => {
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    assert.throws(
      () => new QuorumDiscoveryManager(dnsMgr, { activateThreshold: 3, deactivateThreshold: 3 }, noopLog),
      /hysteresis/,
    );
    assert.throws(
      () => new QuorumDiscoveryManager(dnsMgr, { activateThreshold: 3, deactivateThreshold: 5 }, noopLog),
      /hysteresis/,
    );
  });

  it("rejects activateThreshold < 1", () => {
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    assert.throws(
      () => new QuorumDiscoveryManager(dnsMgr, { activateThreshold: 0, deactivateThreshold: -1 }, noopLog),
      /activateThreshold/,
    );
  });

  it("rejects negative deactivateThreshold", () => {
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    assert.throws(
      () => new QuorumDiscoveryManager(dnsMgr, { activateThreshold: 3, deactivateThreshold: -1 }, noopLog),
      /deactivateThreshold/,
    );
  });

  it("accepts valid config with defaults", () => {
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    const mgr = new QuorumDiscoveryManager(dnsMgr, { activateThreshold: 5, deactivateThreshold: 2 }, noopLog);
    assert.equal(mgr.getMode(), "explore");
    assert.equal(mgr.getCurrentIntervalMs(), 10_000); // default explore interval
  });
});

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------

describe("QuorumDiscoveryManager mode switching", () => {
  it("starts in explore mode", () => {
    mockDnsPeers(0);
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    const mgr = new QuorumDiscoveryManager(dnsMgr, makeQuorumConfig(), noopLog);
    assert.equal(mgr.getMode(), "explore");
  });

  it("switches to stable when density >= activateThreshold", async () => {
    mockDnsPeers(3); // activateThreshold = 3
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    const mgr = new QuorumDiscoveryManager(dnsMgr, makeQuorumConfig(), noopLog);

    mgr.start();
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(mgr.getMode(), "stable");
    assert.equal(mgr.getCurrentIntervalMs(), 200);
    mgr.stop();
  });

  it("stays in explore when density < activateThreshold", async () => {
    mockDnsPeers(2); // below activateThreshold = 3
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    const mgr = new QuorumDiscoveryManager(dnsMgr, makeQuorumConfig(), noopLog);

    mgr.start();
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(mgr.getMode(), "explore");
    mgr.stop();
  });

  it("does not switch back to explore until density < deactivateThreshold (hysteresis)", async () => {
    // Use deterministic peer manipulation + direct tick() calls
    mockDnsNoop(); // DNS returns ENODATA — won't overwrite our manual peers
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    const mgr = new QuorumDiscoveryManager(dnsMgr, makeQuorumConfig(), noopLog);
    (mgr as any).running = true; // enable tick() without starting timer

    // Phase 1: 5 peers → stable
    setDiscoveredPeers(dnsMgr, 5);
    await (mgr as any).tick();
    assert.equal(mgr.getMode(), "stable");

    // Phase 2: 2 peers — in hysteresis dead zone (deactivateThreshold=1) → still stable
    setDiscoveredPeers(dnsMgr, 2);
    await (mgr as any).tick();
    assert.equal(mgr.getMode(), "stable"); // hysteresis holds

    // Phase 3: 0 peers — below deactivateThreshold → explore
    setDiscoveredPeers(dnsMgr, 0);
    await (mgr as any).tick();
    assert.equal(mgr.getMode(), "explore");

    mgr.stop();
  });

  it("switches back to explore when density drops below deactivateThreshold", async () => {
    mockDnsNoop();
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    const mgr = new QuorumDiscoveryManager(
      dnsMgr,
      makeQuorumConfig({ activateThreshold: 3, deactivateThreshold: 1 }),
      noopLog,
    );
    (mgr as any).running = true;

    // Start stable
    setDiscoveredPeers(dnsMgr, 4);
    await (mgr as any).tick();
    assert.equal(mgr.getMode(), "stable");

    // Drop below deactivateThreshold
    setDiscoveredPeers(dnsMgr, 0);
    await (mgr as any).tick();
    assert.equal(mgr.getMode(), "explore");

    mgr.stop();
  });
});

// ---------------------------------------------------------------------------
// getDensity / getDnsManager
// ---------------------------------------------------------------------------

describe("QuorumDiscoveryManager accessors", () => {
  it("getDensity reflects discovered peer count", async () => {
    mockDnsPeers(4);
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    const mgr = new QuorumDiscoveryManager(dnsMgr, makeQuorumConfig(), noopLog);

    mgr.start();
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(mgr.getDensity(), 4);
    mgr.stop();
  });

  it("getDnsManager returns the underlying DnsDiscoveryManager", () => {
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    const mgr = new QuorumDiscoveryManager(dnsMgr, makeQuorumConfig(), noopLog);
    assert.strictEqual(mgr.getDnsManager(), dnsMgr);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("QuorumDiscoveryManager lifecycle", () => {
  it("stop clears timer and does not schedule further ticks", async () => {
    mockDnsPeers(0);
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    const mgr = new QuorumDiscoveryManager(
      dnsMgr,
      makeQuorumConfig({ exploreIntervalMs: 30 }),
      noopLog,
    );

    mgr.start();
    await new Promise((r) => setTimeout(r, 50));
    mgr.stop();

    // After stop, mode should be frozen
    const modeAfterStop = mgr.getMode();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mgr.getMode(), modeAfterStop);
  });

  it("double start is idempotent", async () => {
    mockDnsPeers(0);
    const dnsMgr = new DnsDiscoveryManager(makeDnsConfig(), noopLog);
    const mgr = new QuorumDiscoveryManager(dnsMgr, makeQuorumConfig(), noopLog);

    mgr.start();
    mgr.start(); // should be no-op
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(mgr.getMode(), "explore");
    mgr.stop();
  });
});

// ---------------------------------------------------------------------------
// parseQuorumConfig
// ---------------------------------------------------------------------------

describe("parseQuorumConfig", () => {
  it("returns null when raw is undefined", () => {
    assert.equal(parseQuorumConfig(undefined), null);
  });

  it("parses valid config with custom values", () => {
    const config = parseQuorumConfig({
      activateThreshold: 10,
      deactivateThreshold: 4,
      stableIntervalMs: 60_000,
      exploreIntervalMs: 5_000,
    });
    assert.ok(config);
    assert.equal(config.activateThreshold, 10);
    assert.equal(config.deactivateThreshold, 4);
    assert.equal(config.stableIntervalMs, 60_000);
    assert.equal(config.exploreIntervalMs, 5_000);
  });

  it("uses defaults for missing optional fields", () => {
    const config = parseQuorumConfig({
      activateThreshold: 8,
      deactivateThreshold: 3,
    });
    assert.ok(config);
    assert.equal(config.stableIntervalMs, QUORUM_DEFAULTS.stableIntervalMs);
    assert.equal(config.exploreIntervalMs, QUORUM_DEFAULTS.exploreIntervalMs);
  });

  it("returns null when hysteresis constraint is violated", () => {
    const config = parseQuorumConfig({
      activateThreshold: 3,
      deactivateThreshold: 3,
    });
    assert.equal(config, null);
  });

  it("uses default thresholds for non-numeric values", () => {
    const config = parseQuorumConfig({
      activateThreshold: "five",
      deactivateThreshold: true,
    });
    assert.ok(config);
    assert.equal(config.activateThreshold, QUORUM_DEFAULTS.activateThreshold);
    assert.equal(config.deactivateThreshold, QUORUM_DEFAULTS.deactivateThreshold);
  });

  it("rejects interval < 1000ms", () => {
    const config = parseQuorumConfig({
      activateThreshold: 5,
      deactivateThreshold: 2,
      stableIntervalMs: 500,
      exploreIntervalMs: 100,
    });
    assert.ok(config);
    assert.equal(config.stableIntervalMs, QUORUM_DEFAULTS.stableIntervalMs);
    assert.equal(config.exploreIntervalMs, QUORUM_DEFAULTS.exploreIntervalMs);
  });
});
