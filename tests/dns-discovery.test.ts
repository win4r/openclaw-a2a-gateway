import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";

import {
  DnsDiscoveryManager,
  parseTxtRecords,
  buildAgentCardUrl,
  mergeWithStaticPeers,
  discoveredPeerToConfig,
  parseDnsDiscoveryConfig,
  DNS_DISCOVERY_DEFAULTS,
} from "../src/dns-discovery.js";
import type { DiscoveredPeer, DnsDiscoveryConfig } from "../src/dns-discovery.js";
import type { PeerConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// parseTxtRecords
// ---------------------------------------------------------------------------

describe("parseTxtRecords", () => {
  it("parses key=value pairs from TXT record chunks", () => {
    const records = [
      ["protocol=jsonrpc", "name=MyAgent", "path=/.well-known/agent-card.json"],
    ];
    const map = parseTxtRecords(records);

    assert.equal(map.get("protocol"), "jsonrpc");
    assert.equal(map.get("name"), "MyAgent");
    assert.equal(map.get("path"), "/.well-known/agent-card.json");
  });

  it("handles multiple record arrays", () => {
    const records = [
      ["protocol=grpc"],
      ["name=PeerBot", "auth_type=bearer"],
    ];
    const map = parseTxtRecords(records);

    assert.equal(map.get("protocol"), "grpc");
    assert.equal(map.get("name"), "PeerBot");
    assert.equal(map.get("auth_type"), "bearer");
  });

  it("ignores chunks without = sign", () => {
    const records = [["noequalssign", "valid=yes"]];
    const map = parseTxtRecords(records);

    assert.equal(map.size, 1);
    assert.equal(map.get("valid"), "yes");
  });

  it("handles empty records", () => {
    assert.equal(parseTxtRecords([]).size, 0);
    assert.equal(parseTxtRecords([[]]).size, 0);
  });

  it("normalizes keys to lowercase", () => {
    const records = [["Protocol=jsonrpc", "NAME=Test"]];
    const map = parseTxtRecords(records);

    assert.equal(map.get("protocol"), "jsonrpc");
    assert.equal(map.get("name"), "Test");
  });

  it("preserves value case", () => {
    const records = [["name=MyMixedCaseAgent"]];
    const map = parseTxtRecords(records);
    assert.equal(map.get("name"), "MyMixedCaseAgent");
  });

  it("handles values containing = signs", () => {
    const records = [["token=abc=def=ghi"]];
    const map = parseTxtRecords(records);
    assert.equal(map.get("token"), "abc=def=ghi");
  });
});

// ---------------------------------------------------------------------------
// buildAgentCardUrl
// ---------------------------------------------------------------------------

describe("buildAgentCardUrl", () => {
  it("constructs URL from host, port, and default path", () => {
    const url = buildAgentCardUrl("agent-a.local", 18800);
    assert.equal(url, "http://agent-a.local:18800/.well-known/agent-card.json");
  });

  it("uses custom path from TXT record", () => {
    const url = buildAgentCardUrl("192.168.1.10", 9090, "/custom/card.json");
    assert.equal(url, "http://192.168.1.10:9090/custom/card.json");
  });

  it("normalizes path without leading slash", () => {
    const url = buildAgentCardUrl("host.local", 3000, "api/agent-card");
    assert.equal(url, "http://host.local:3000/api/agent-card");
  });

  it("uses default path when pathFromTxt is empty string", () => {
    const url = buildAgentCardUrl("host.local", 8080, "");
    assert.equal(url, "http://host.local:8080/.well-known/agent-card.json");
  });
});

// ---------------------------------------------------------------------------
// mergeWithStaticPeers
// ---------------------------------------------------------------------------

describe("mergeWithStaticPeers", () => {
  const staticPeers: PeerConfig[] = [
    { name: "static-bot", agentCardUrl: "http://static:18800/.well-known/agent-card.json" },
  ];

  const discoveredPeers: DiscoveredPeer[] = [
    {
      name: "discovered-bot",
      host: "discovered.local",
      port: 18800,
      agentCardUrl: "http://discovered.local:18800/.well-known/agent-card.json",
      discoveredAt: Date.now(),
      ttl: 300,
    },
    {
      name: "static-bot", // Name collision with static peer
      host: "other.local",
      port: 18800,
      agentCardUrl: "http://other.local:18800/.well-known/agent-card.json",
      discoveredAt: Date.now(),
      ttl: 300,
    },
  ];

  it("merges static and discovered peers", () => {
    const merged = mergeWithStaticPeers(staticPeers, discoveredPeers);
    assert.equal(merged.length, 2); // static-bot + discovered-bot (collision excluded)
  });

  it("static peers take precedence on name collision", () => {
    const merged = mergeWithStaticPeers(staticPeers, discoveredPeers);
    const staticBot = merged.find((p) => p.name === "static-bot");
    assert.ok(staticBot);
    assert.equal(staticBot.agentCardUrl, "http://static:18800/.well-known/agent-card.json");
  });

  it("discovered peers with unique names are included", () => {
    const merged = mergeWithStaticPeers(staticPeers, discoveredPeers);
    const discovered = merged.find((p) => p.name === "discovered-bot");
    assert.ok(discovered);
    assert.equal(discovered.agentCardUrl, "http://discovered.local:18800/.well-known/agent-card.json");
  });

  it("returns only static peers when no discovered peers", () => {
    const merged = mergeWithStaticPeers(staticPeers, []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, "static-bot");
  });

  it("returns only discovered peers (as configs) when no static peers", () => {
    const merged = mergeWithStaticPeers([], discoveredPeers);
    assert.equal(merged.length, 2);
  });
});

// ---------------------------------------------------------------------------
// discoveredPeerToConfig
// ---------------------------------------------------------------------------

describe("discoveredPeerToConfig", () => {
  it("converts a basic discovered peer", () => {
    const peer: DiscoveredPeer = {
      name: "bot-a",
      host: "bot-a.local",
      port: 18800,
      agentCardUrl: "http://bot-a.local:18800/.well-known/agent-card.json",
      discoveredAt: Date.now(),
      ttl: 300,
    };

    const config = discoveredPeerToConfig(peer);
    assert.equal(config.name, "bot-a");
    assert.equal(config.agentCardUrl, "http://bot-a.local:18800/.well-known/agent-card.json");
    assert.equal(config.auth, undefined);
  });

  it("includes auth when present", () => {
    const peer: DiscoveredPeer = {
      name: "bot-b",
      host: "bot-b.local",
      port: 18800,
      agentCardUrl: "http://bot-b.local:18800/.well-known/agent-card.json",
      auth: { type: "bearer", token: "secret-token" },
      discoveredAt: Date.now(),
      ttl: 300,
    };

    const config = discoveredPeerToConfig(peer);
    assert.ok(config.auth);
    assert.equal(config.auth.type, "bearer");
    assert.equal(config.auth.token, "secret-token");
  });

  it("normalizes unknown auth type to bearer", () => {
    const peer: DiscoveredPeer = {
      name: "bot-c",
      host: "bot-c.local",
      port: 18800,
      agentCardUrl: "http://bot-c.local:18800/.well-known/agent-card.json",
      auth: { type: "custom", token: "tok" },
      discoveredAt: Date.now(),
      ttl: 300,
    };

    const config = discoveredPeerToConfig(peer);
    assert.ok(config.auth);
    assert.equal(config.auth.type, "bearer");
  });
});

// ---------------------------------------------------------------------------
// parseDnsDiscoveryConfig
// ---------------------------------------------------------------------------

describe("parseDnsDiscoveryConfig", () => {
  it("returns defaults when raw is undefined", () => {
    const config = parseDnsDiscoveryConfig(undefined);
    assert.deepEqual(config, DNS_DISCOVERY_DEFAULTS);
  });

  it("returns defaults when raw is empty object", () => {
    const config = parseDnsDiscoveryConfig({});
    assert.deepEqual(config, DNS_DISCOVERY_DEFAULTS);
  });

  it("parses enabled flag", () => {
    const config = parseDnsDiscoveryConfig({ enabled: true });
    assert.equal(config.enabled, true);
  });

  it("parses custom serviceName", () => {
    const config = parseDnsDiscoveryConfig({ serviceName: "_custom._tcp.example.com" });
    assert.equal(config.serviceName, "_custom._tcp.example.com");
  });

  it("parses custom refreshIntervalMs", () => {
    const config = parseDnsDiscoveryConfig({ refreshIntervalMs: 60_000 });
    assert.equal(config.refreshIntervalMs, 60_000);
  });

  it("rejects refreshIntervalMs below 1000ms", () => {
    const config = parseDnsDiscoveryConfig({ refreshIntervalMs: 500 });
    assert.equal(config.refreshIntervalMs, DNS_DISCOVERY_DEFAULTS.refreshIntervalMs);
  });

  it("parses mergeWithStatic=false", () => {
    const config = parseDnsDiscoveryConfig({ mergeWithStatic: false });
    assert.equal(config.mergeWithStatic, false);
  });

  it("ignores non-string serviceName", () => {
    const config = parseDnsDiscoveryConfig({ serviceName: 42 });
    assert.equal(config.serviceName, DNS_DISCOVERY_DEFAULTS.serviceName);
  });

  it("ignores empty string serviceName", () => {
    const config = parseDnsDiscoveryConfig({ serviceName: "  " });
    assert.equal(config.serviceName, DNS_DISCOVERY_DEFAULTS.serviceName);
  });
});

// ---------------------------------------------------------------------------
// DnsDiscoveryManager
// ---------------------------------------------------------------------------

describe("DnsDiscoveryManager", () => {
  const noopLog: any = () => {};

  function makeConfig(overrides: Partial<DnsDiscoveryConfig> = {}): DnsDiscoveryConfig {
    return {
      enabled: true,
      serviceName: "_a2a._tcp.test.local",
      refreshIntervalMs: 60_000, // Long interval so timer doesn't fire in tests
      mergeWithStatic: true,
      ...overrides,
    };
  }

  // Save and restore dns.promises methods
  let originalResolveSrv: typeof dns.promises.resolveSrv;
  let originalResolveTxt: typeof dns.promises.resolveTxt;

  beforeEach(() => {
    originalResolveSrv = dns.promises.resolveSrv;
    originalResolveTxt = dns.promises.resolveTxt;
  });

  afterEach(() => {
    dns.promises.resolveSrv = originalResolveSrv;
    dns.promises.resolveTxt = originalResolveTxt;
  });

  it("starts and stops without errors", () => {
    const mgr = new DnsDiscoveryManager(makeConfig(), noopLog);
    // Mock DNS to prevent actual network calls
    dns.promises.resolveSrv = async () => [];
    dns.promises.resolveTxt = async () => [];
    mgr.start();
    mgr.stop();
  });

  it("does not start when disabled", () => {
    const mgr = new DnsDiscoveryManager(makeConfig({ enabled: false }), noopLog);
    mgr.start();
    // getDiscoveredPeers should be empty since no refresh happened
    assert.equal(mgr.getDiscoveredPeers().length, 0);
    mgr.stop();
  });

  it("discovers peers from SRV + TXT records", async () => {
    dns.promises.resolveSrv = async (_name: string) => [
      { name: "agent-a.local", port: 18800, priority: 10, weight: 10 },
    ];
    dns.promises.resolveTxt = async (_name: string) => [
      ["protocol=jsonrpc", "name=AgentA", "path=/.well-known/agent-card.json"],
    ];

    const mgr = new DnsDiscoveryManager(makeConfig(), noopLog);
    mgr.start();

    // Wait for the async discover() to complete
    await new Promise((r) => setTimeout(r, 50));

    const peers = mgr.getDiscoveredPeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].name, "AgentA");
    assert.equal(peers[0].host, "agent-a.local");
    assert.equal(peers[0].port, 18800);
    assert.equal(peers[0].agentCardUrl, "http://agent-a.local:18800/.well-known/agent-card.json");
    assert.equal(peers[0].protocol, "jsonrpc");

    mgr.stop();
  });

  it("uses SRV hostname prefix as name when TXT has no name field", async () => {
    dns.promises.resolveSrv = async () => [
      { name: "my-agent.local", port: 9090, priority: 10, weight: 10 },
    ];
    dns.promises.resolveTxt = async () => {
      const err: any = new Error("ENODATA");
      err.code = "ENODATA";
      throw err;
    };

    const mgr = new DnsDiscoveryManager(makeConfig(), noopLog);
    mgr.start();
    await new Promise((r) => setTimeout(r, 50));

    const peers = mgr.getDiscoveredPeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].name, "my-agent");
    assert.equal(peers[0].port, 9090);

    mgr.stop();
  });

  it("includes auth from TXT records", async () => {
    dns.promises.resolveSrv = async () => [
      { name: "secure-agent.local", port: 18800, priority: 10, weight: 10 },
    ];
    dns.promises.resolveTxt = async () => [
      ["name=SecureBot", "auth_type=bearer", "auth_token=my-secret-token"],
    ];

    const mgr = new DnsDiscoveryManager(makeConfig(), noopLog);
    mgr.start();
    await new Promise((r) => setTimeout(r, 50));

    const peers = mgr.getDiscoveredPeers();
    assert.equal(peers.length, 1);
    assert.ok(peers[0].auth);
    assert.equal(peers[0].auth!.type, "bearer");
    assert.equal(peers[0].auth!.token, "my-secret-token");

    mgr.stop();
  });

  it("retains last known peers on DNS failure (graceful degradation)", async () => {
    let callCount = 0;
    dns.promises.resolveSrv = async () => {
      callCount++;
      if (callCount === 1) {
        return [{ name: "agent.local", port: 18800, priority: 10, weight: 10 }];
      }
      throw new Error("Network error");
    };
    dns.promises.resolveTxt = async () => [["name=Agent"]];

    const mgr = new DnsDiscoveryManager(
      makeConfig({ refreshIntervalMs: 100 }),
      noopLog,
    );
    mgr.start();

    // First refresh discovers a peer
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(mgr.getDiscoveredPeers().length, 1);

    // Second refresh fails -- peers should be retained
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(mgr.getDiscoveredPeers().length, 1);
    assert.equal(mgr.getDiscoveredPeers()[0].name, "Agent");

    mgr.stop();
  });

  it("evicts expired peers on refresh", async () => {
    dns.promises.resolveSrv = async () => [
      { name: "short-lived.local", port: 18800, priority: 10, weight: 10 },
    ];
    dns.promises.resolveTxt = async () => [["name=ShortLived"]];

    const mgr = new DnsDiscoveryManager(makeConfig(), noopLog);
    mgr.start();
    await new Promise((r) => setTimeout(r, 50));

    // Peer should be discovered
    assert.equal(mgr.getDiscoveredPeers().length, 1);

    // Manually set discoveredAt far in the past to simulate TTL expiration
    const peers = mgr.getDiscoveredPeers();
    // Access private field for test manipulation
    (mgr as any).discoveredPeers[0].discoveredAt = Date.now() - 400_000; // 400s ago, TTL is 300s
    (mgr as any).discoveredPeers[0].ttl = 300;

    // Now mock DNS to return ENODATA (no SRV records) to trigger eviction
    dns.promises.resolveSrv = async () => {
      const err: any = new Error("ENODATA");
      err.code = "ENODATA";
      throw err;
    };

    // Trigger another refresh
    (mgr as any).refresh();
    await new Promise((r) => setTimeout(r, 50));

    // Peer should have been evicted
    assert.equal(mgr.getDiscoveredPeers().length, 0);

    mgr.stop();
  });

  it("handles ENODATA from SRV gracefully (no crash)", async () => {
    dns.promises.resolveSrv = async () => {
      const err: any = new Error("ENODATA");
      err.code = "ENODATA";
      throw err;
    };

    const mgr = new DnsDiscoveryManager(makeConfig(), noopLog);
    mgr.start();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(mgr.getDiscoveredPeers().length, 0);
    mgr.stop();
  });

  it("handles ENOTFOUND from SRV gracefully", async () => {
    dns.promises.resolveSrv = async () => {
      const err: any = new Error("ENOTFOUND");
      err.code = "ENOTFOUND";
      throw err;
    };

    const mgr = new DnsDiscoveryManager(makeConfig(), noopLog);
    mgr.start();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(mgr.getDiscoveredPeers().length, 0);
    mgr.stop();
  });

  it("toPeerConfigs converts discovered peers to PeerConfig format", async () => {
    dns.promises.resolveSrv = async () => [
      { name: "agent-x.local", port: 18800, priority: 10, weight: 10 },
    ];
    dns.promises.resolveTxt = async () => [
      ["name=AgentX", "auth_type=bearer", "auth_token=tok123"],
    ];

    const mgr = new DnsDiscoveryManager(makeConfig(), noopLog);
    mgr.start();
    await new Promise((r) => setTimeout(r, 50));

    const configs = mgr.toPeerConfigs();
    assert.equal(configs.length, 1);
    assert.equal(configs[0].name, "AgentX");
    assert.equal(configs[0].agentCardUrl, "http://agent-x.local:18800/.well-known/agent-card.json");
    assert.ok(configs[0].auth);
    assert.equal(configs[0].auth!.type, "bearer");
    assert.equal(configs[0].auth!.token, "tok123");

    mgr.stop();
  });

  it("findPeer returns discovered peer by name", async () => {
    dns.promises.resolveSrv = async () => [
      { name: "agent-find.local", port: 18800, priority: 10, weight: 10 },
    ];
    dns.promises.resolveTxt = async () => [["name=FindMe"]];

    const mgr = new DnsDiscoveryManager(makeConfig(), noopLog);
    mgr.start();
    await new Promise((r) => setTimeout(r, 50));

    const found = mgr.findPeer("FindMe");
    assert.ok(found);
    assert.equal(found.name, "FindMe");

    const notFound = mgr.findPeer("NotThere");
    assert.equal(notFound, undefined);

    mgr.stop();
  });

  it("discovers multiple SRV records", async () => {
    dns.promises.resolveSrv = async () => [
      { name: "agent-1.local", port: 18801, priority: 10, weight: 10 },
      { name: "agent-2.local", port: 18802, priority: 20, weight: 10 },
    ];
    dns.promises.resolveTxt = async () => [["protocol=rest"]];

    const mgr = new DnsDiscoveryManager(makeConfig(), noopLog);
    mgr.start();
    await new Promise((r) => setTimeout(r, 50));

    const peers = mgr.getDiscoveredPeers();
    assert.equal(peers.length, 2);
    assert.equal(peers[0].protocol, "rest");
    assert.equal(peers[1].protocol, "rest");

    mgr.stop();
  });
});

// ---------------------------------------------------------------------------
// Config parsing integration (via parseConfig in index.ts)
// ---------------------------------------------------------------------------

describe("discovery config in parseConfig", () => {
  // Import parseConfig to test integration
  let parseConfig: typeof import("../index.js").parseConfig;

  beforeEach(async () => {
    const mod = await import("../index.js");
    parseConfig = mod.parseConfig;
  });

  it("defaults to discovery disabled", () => {
    const config = parseConfig({});
    assert.equal(config.discovery.enabled, false);
    assert.equal(config.discovery.serviceName, "_a2a._tcp.local");
    assert.equal(config.discovery.refreshIntervalMs, 30_000);
    assert.equal(config.discovery.mergeWithStatic, true);
  });

  it("parses discovery config when provided", () => {
    const config = parseConfig({
      discovery: {
        enabled: true,
        serviceName: "_custom._tcp.local",
        refreshIntervalMs: 60_000,
        mergeWithStatic: false,
      },
    });
    assert.equal(config.discovery.enabled, true);
    assert.equal(config.discovery.serviceName, "_custom._tcp.local");
    assert.equal(config.discovery.refreshIntervalMs, 60_000);
    assert.equal(config.discovery.mergeWithStatic, false);
  });
});
