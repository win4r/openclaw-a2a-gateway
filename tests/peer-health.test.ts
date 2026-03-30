import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PeerHealthManager, computeRecoveryCapacity } from "../src/peer-health.js";
import type { PeerConfig, HealthCheckConfig, CircuitBreakerConfig } from "../src/types.js";

const testPeers: PeerConfig[] = [
  { name: "bot-a", agentCardUrl: "http://localhost:18801/.well-known/agent.json" },
  { name: "bot-b", agentCardUrl: "http://localhost:18802/.well-known/agent.json" },
];

const defaultHealthConfig: HealthCheckConfig = {
  enabled: true,
  intervalMs: 60_000, // Long interval so timer doesn't fire in tests
  timeoutMs: 5_000,
};

const defaultCbConfig: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 100, // Short for fast tests
};

const noop = () => {};
const noopLog = noop as any;

function createManager(
  probe: (peer: PeerConfig) => Promise<boolean> = async () => true,
  cbOverrides?: Partial<CircuitBreakerConfig>,
) {
  return new PeerHealthManager(
    testPeers,
    defaultHealthConfig,
    { ...defaultCbConfig, ...cbOverrides },
    probe,
    noopLog,
  );
}

describe("PeerHealthManager", () => {
  it("initializes all peers as unknown/closed", () => {
    const mgr = createManager();
    const state = mgr.getState("bot-a");
    assert.ok(state);
    assert.equal(state.health, "unknown");
    assert.equal(state.circuit, "closed");
    assert.equal(state.consecutiveFailures, 0);
  });

  it("isAvailable returns true for closed circuit", () => {
    const mgr = createManager();
    assert.equal(mgr.isAvailable("bot-a"), true);
  });

  it("isAvailable returns true for unknown peer (fail at send)", () => {
    const mgr = createManager();
    assert.equal(mgr.isAvailable("nonexistent"), true);
  });

  it("recordSuccess resets failures and sets healthy", () => {
    const mgr = createManager();
    mgr.recordFailure("bot-a");
    mgr.recordFailure("bot-a");
    mgr.recordSuccess("bot-a");

    const state = mgr.getState("bot-a")!;
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.health, "healthy");
    assert.equal(state.circuit, "closed");
  });

  it("opens circuit after failure threshold", () => {
    const mgr = createManager();
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }

    const state = mgr.getState("bot-a")!;
    assert.equal(state.circuit, "open");
    assert.equal(state.health, "unhealthy");
    assert.equal(mgr.isAvailable("bot-a"), false);
  });

  it("transitions from open to recovering after cooldown", async () => {
    const mgr = createManager();
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }
    assert.equal(mgr.isAvailable("bot-a"), false);

    // Wait for resetTimeoutMs (100ms)
    await new Promise((r) => setTimeout(r, 150));

    // Should now transition to recovering (replaces half-open)
    assert.equal(mgr.isAvailable("bot-a"), true);
    assert.equal(mgr.getState("bot-a")!.circuit, "recovering");
  });

  it("recovering success closes circuit", async () => {
    const mgr = createManager();
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }

    await new Promise((r) => setTimeout(r, 150));
    mgr.isAvailable("bot-a"); // triggers recovering

    mgr.recordSuccess("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "closed");
  });

  it("recovering failure re-opens circuit", async () => {
    const mgr = createManager();
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }

    await new Promise((r) => setTimeout(r, 150));
    mgr.isAvailable("bot-a"); // triggers recovering

    mgr.recordFailure("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "open");
  });

  it("recovering allows only one in-flight request (legacy mode)", async () => {
    const mgr = createManager();
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }

    await new Promise((r) => setTimeout(r, 150));

    // First call → recovering, allowed
    assert.equal(mgr.isAvailable("bot-a"), true);
    // Second call → still in-flight, blocked (single-probe mode)
    assert.equal(mgr.isAvailable("bot-a"), false);
  });

  it("different peers have independent states", () => {
    const mgr = createManager();
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }

    assert.equal(mgr.isAvailable("bot-a"), false);
    assert.equal(mgr.isAvailable("bot-b"), true);
  });

  it("getAllStates returns all peer states", () => {
    const mgr = createManager();
    const states = mgr.getAllStates();
    assert.equal(states.size, 2);
    assert.ok(states.has("bot-a"));
    assert.ok(states.has("bot-b"));
  });

  it("stop clears interval timer", () => {
    const mgr = createManager();
    mgr.start();
    mgr.stop();
    // No assertion needed — just verify it doesn't throw
  });

  it("updateSkills caches skills for a peer", () => {
    const mgr = createManager();
    mgr.updateSkills("bot-a", ["translation", "summarization"]);
    const skills = mgr.getPeerSkills();
    assert.deepEqual(skills.get("bot-a"), ["translation", "summarization"]);
    assert.equal(skills.has("bot-b"), false);
  });

  it("updateSkills overwrites previous skills", () => {
    const mgr = createManager();
    mgr.updateSkills("bot-a", ["old-skill"]);
    mgr.updateSkills("bot-a", ["new-skill"]);
    assert.deepEqual(mgr.getPeerSkills().get("bot-a"), ["new-skill"]);
  });

  it("getPeerSkills returns independent copy", () => {
    const mgr = createManager();
    mgr.updateSkills("bot-a", ["skill-1"]);
    const copy = mgr.getPeerSkills();
    copy.set("bot-a", ["tampered"]);
    assert.deepEqual(mgr.getPeerSkills().get("bot-a"), ["skill-1"]);
  });

  it("getPeerSkills returns empty map when no skills cached", () => {
    const mgr = createManager();
    assert.equal(mgr.getPeerSkills().size, 0);
  });
});

// ===========================================================================
// Receptor desensitization circuit breaker (Phase 1.2 — Bio-inspired)
// ===========================================================================

// ---------------------------------------------------------------------------
// DESENSITIZED state — soft threshold + partial traffic
// ---------------------------------------------------------------------------

describe("PeerHealthManager — DESENSITIZED state", () => {
  const softCbConfig: Partial<CircuitBreakerConfig> = {
    failureThreshold: 5,
    softThreshold: 2,
    desensitizedCapacity: 0.5,
  };

  it("enters DESENSITIZED at softThreshold (before failureThreshold)", () => {
    const mgr = createManager(async () => true, softCbConfig);
    mgr.recordFailure("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "closed");
    mgr.recordFailure("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "desensitized");
  });

  it("DESENSITIZED allows partial traffic (deterministic round-robin)", () => {
    const mgr = createManager(async () => true, softCbConfig);
    mgr.recordFailure("bot-a");
    mgr.recordFailure("bot-a"); // → desensitized

    let allowed = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (mgr.isAvailable("bot-a")) allowed++;
    }
    // With capacity 0.5, expect ~50% ± 10%
    const ratio = allowed / total;
    assert.ok(
      Math.abs(ratio - 0.5) < 0.1,
      `Expected ~50% pass rate, got ${(ratio * 100).toFixed(1)}%`,
    );
  });

  it("DESENSITIZED → OPEN at hard failureThreshold", () => {
    const mgr = createManager(async () => true, softCbConfig);
    for (let i = 0; i < 2; i++) mgr.recordFailure("bot-a"); // → desensitized
    assert.equal(mgr.getState("bot-a")!.circuit, "desensitized");

    for (let i = 0; i < 3; i++) mgr.recordFailure("bot-a"); // total 5 → open
    assert.equal(mgr.getState("bot-a")!.circuit, "open");
    assert.equal(mgr.isAvailable("bot-a"), false);
  });

  it("DESENSITIZED → CLOSED on success", () => {
    const mgr = createManager(async () => true, softCbConfig);
    mgr.recordFailure("bot-a");
    mgr.recordFailure("bot-a"); // → desensitized
    assert.equal(mgr.getState("bot-a")!.circuit, "desensitized");

    mgr.recordSuccess("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "closed");
    assert.equal(mgr.getState("bot-a")!.consecutiveFailures, 0);
  });

  it("without softThreshold, skips DESENSITIZED (goes straight to OPEN)", () => {
    const mgr = createManager(async () => true); // no softThreshold
    for (let i = 0; i < 3; i++) mgr.recordFailure("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "open"); // never desensitized
  });

  it("DESENSITIZED capacity 0.3 gives ~30% pass rate", () => {
    const mgr = createManager(async () => true, {
      failureThreshold: 5,
      softThreshold: 2,
      desensitizedCapacity: 0.3,
    });
    mgr.recordFailure("bot-a");
    mgr.recordFailure("bot-a"); // → desensitized

    let allowed = 0;
    for (let i = 0; i < 1000; i++) {
      if (mgr.isAvailable("bot-a")) allowed++;
    }
    const ratio = allowed / 1000;
    assert.ok(
      Math.abs(ratio - 0.3) < 0.1,
      `Expected ~30% pass rate, got ${(ratio * 100).toFixed(1)}%`,
    );
  });

  it("DESENSITIZED capacity 1.0 allows all traffic", () => {
    const mgr = createManager(async () => true, {
      failureThreshold: 5,
      softThreshold: 2,
      desensitizedCapacity: 1.0,
    });
    mgr.recordFailure("bot-a");
    mgr.recordFailure("bot-a");

    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      if (mgr.isAvailable("bot-a")) allowed++;
    }
    assert.equal(allowed, 100);
  });
});

// ---------------------------------------------------------------------------
// RECOVERING state — gradual recovery (replaces half-open)
// ---------------------------------------------------------------------------

describe("PeerHealthManager — RECOVERING state", () => {
  it("transitions OPEN → RECOVERING after cooldown", async () => {
    const mgr = createManager(async () => true, {
      failureThreshold: 3,
      resetTimeoutMs: 50,
      recoveryRateConstant: 1.0,
    });
    for (let i = 0; i < 3; i++) mgr.recordFailure("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "open");

    await new Promise((r) => setTimeout(r, 80));
    mgr.isAvailable("bot-a"); // triggers transition
    assert.equal(mgr.getState("bot-a")!.circuit, "recovering");
  });

  it("RECOVERING capacity increases over time (monotonic)", async () => {
    const k = 2.0; // fast recovery for test
    const c1 = computeRecoveryCapacity(0, k); // t=0
    const c2 = computeRecoveryCapacity(500, k); // t=0.5s
    const c3 = computeRecoveryCapacity(1000, k); // t=1s
    const c4 = computeRecoveryCapacity(3000, k); // t=3s

    assert.ok(c1 < c2, `c(0)=${c1} should be < c(0.5s)=${c2}`);
    assert.ok(c2 < c3, `c(0.5s)=${c2} should be < c(1s)=${c3}`);
    assert.ok(c3 < c4, `c(1s)=${c3} should be < c(3s)=${c4}`);
    assert.ok(c4 > 0.99, `c(3s)=${c4} should be > 0.99`);
  });

  it("computeRecoveryCapacity(0, k) === 0", () => {
    assert.equal(computeRecoveryCapacity(0, 1.0), 0);
  });

  it("computeRecoveryCapacity is always in [0, 1]", () => {
    for (const t of [0, 100, 500, 1000, 5000, 10000]) {
      for (const k of [0.1, 0.5, 1.0, 2.0, 5.0]) {
        const c = computeRecoveryCapacity(t, k);
        assert.ok(c >= 0 && c <= 1, `capacity(${t}ms, k=${k}) = ${c} out of [0,1]`);
      }
    }
  });

  it("RECOVERING → CLOSED on success", async () => {
    const mgr = createManager(async () => true, {
      failureThreshold: 3,
      resetTimeoutMs: 50,
      recoveryRateConstant: 1.0,
    });
    for (let i = 0; i < 3; i++) mgr.recordFailure("bot-a");
    await new Promise((r) => setTimeout(r, 80));
    mgr.isAvailable("bot-a"); // → recovering

    mgr.recordSuccess("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "closed");
  });

  it("RECOVERING → OPEN on failure", async () => {
    const mgr = createManager(async () => true, {
      failureThreshold: 3,
      resetTimeoutMs: 50,
      recoveryRateConstant: 1.0,
    });
    for (let i = 0; i < 3; i++) mgr.recordFailure("bot-a");
    await new Promise((r) => setTimeout(r, 80));
    mgr.isAvailable("bot-a"); // → recovering

    mgr.recordFailure("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "open");
  });

  it("without recoveryRateConstant, RECOVERING behaves like old half-open", async () => {
    const mgr = createManager(async () => true, {
      failureThreshold: 3,
      resetTimeoutMs: 50,
      // No recoveryRateConstant → single-probe mode
    });
    for (let i = 0; i < 3; i++) mgr.recordFailure("bot-a");
    await new Promise((r) => setTimeout(r, 80));

    // First call → transitions to recovering, allowed (like half-open)
    assert.equal(mgr.isAvailable("bot-a"), true);
    assert.equal(mgr.getState("bot-a")!.circuit, "recovering");

    // Second call → blocked (single-probe mode)
    assert.equal(mgr.isAvailable("bot-a"), false);
  });
});

// ---------------------------------------------------------------------------
// Full four-state lifecycle
// ---------------------------------------------------------------------------

describe("PeerHealthManager — full four-state lifecycle", () => {
  it("CLOSED → DESENSITIZED → OPEN → RECOVERING → CLOSED", async () => {
    const mgr = createManager(async () => true, {
      failureThreshold: 5,
      softThreshold: 2,
      desensitizedCapacity: 0.5,
      resetTimeoutMs: 50,
      recoveryRateConstant: 1.0,
    });

    // CLOSED
    assert.equal(mgr.getState("bot-a")!.circuit, "closed");

    // → DESENSITIZED (soft threshold = 2)
    mgr.recordFailure("bot-a");
    mgr.recordFailure("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "desensitized");

    // → OPEN (hard threshold = 5)
    mgr.recordFailure("bot-a");
    mgr.recordFailure("bot-a");
    mgr.recordFailure("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "open");

    // → RECOVERING (after cooldown)
    await new Promise((r) => setTimeout(r, 80));
    mgr.isAvailable("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "recovering");

    // → CLOSED (on success)
    mgr.recordSuccess("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "closed");
  });

  it("independent peers: bot-a desensitized does not affect bot-b", () => {
    const mgr = createManager(async () => true, {
      failureThreshold: 5,
      softThreshold: 2,
      desensitizedCapacity: 0.5,
    });

    mgr.recordFailure("bot-a");
    mgr.recordFailure("bot-a"); // → desensitized
    assert.equal(mgr.getState("bot-a")!.circuit, "desensitized");
    assert.equal(mgr.getState("bot-b")!.circuit, "closed");
    assert.equal(mgr.isAvailable("bot-b"), true);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — no new config fields
// ---------------------------------------------------------------------------

describe("PeerHealthManager — backward compatibility", () => {
  it("without new config fields, behavior is identical to legacy 3-state", async () => {
    const mgr = createManager(); // default config, no soft/recovery fields
    // Should go CLOSED → OPEN (not DESENSITIZED)
    for (let i = 0; i < 3; i++) mgr.recordFailure("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "open");
    assert.equal(mgr.isAvailable("bot-a"), false);

    // After cooldown → RECOVERING (acts like half-open)
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(mgr.isAvailable("bot-a"), true);
    assert.equal(mgr.getState("bot-a")!.circuit, "recovering");

    // Success → CLOSED
    mgr.recordSuccess("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "closed");
  });
});
