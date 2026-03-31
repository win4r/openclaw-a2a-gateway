import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  michaelisMentenDelay,
  computeSaturationDelay,
  parseSaturationConfig,
} from "../src/saturation-model.js";

// ---------------------------------------------------------------------------
// michaelisMentenDelay — pure math
// ---------------------------------------------------------------------------

describe("michaelisMentenDelay", () => {
  it("returns 0 when load is 0", () => {
    assert.equal(michaelisMentenDelay(0, 0.5, 1000), 0);
  });

  it("returns 0 when load is negative", () => {
    assert.equal(michaelisMentenDelay(-1, 0.5, 1000), 0);
  });

  it("returns half baseDelay when load equals Km", () => {
    // At Km: delay = baseDelay * Km / (Km + Km) = baseDelay / 2
    const delay = michaelisMentenDelay(0.5, 0.5, 1000);
    assert.equal(delay, 500);
  });

  it("approaches baseDelay at very high load", () => {
    // load=100, Km=0.5: delay = 1000 * 100 / (0.5 + 100) ≈ 995
    const delay = michaelisMentenDelay(100, 0.5, 1000);
    assert.ok(delay > 990);
    assert.ok(delay < 1000);
  });

  it("is near 0 at very low load", () => {
    // load=0.01, Km=0.5: delay = 1000 * 0.01 / (0.5 + 0.01) ≈ 19.6
    const delay = michaelisMentenDelay(0.01, 0.5, 1000);
    assert.ok(delay < 30);
  });

  it("returns baseDelay when Km is 0 (infinite affinity)", () => {
    assert.equal(michaelisMentenDelay(0.5, 0, 1000), 1000);
  });

  it("is monotonically increasing with load", () => {
    const delays = [0.1, 0.3, 0.5, 0.7, 1.0, 2.0].map(
      (load) => michaelisMentenDelay(load, 0.5, 1000),
    );
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] > delays[i - 1], `delay at ${i} should be > delay at ${i - 1}`);
    }
  });

  it("higher Km delays the onset of saturation", () => {
    // At load=0.5: Km=0.3 gives higher delay than Km=0.8
    const delayLowKm = michaelisMentenDelay(0.5, 0.3, 1000);
    const delayHighKm = michaelisMentenDelay(0.5, 0.8, 1000);
    assert.ok(delayLowKm > delayHighKm);
  });
});

// ---------------------------------------------------------------------------
// computeSaturationDelay — convenience wrapper
// ---------------------------------------------------------------------------

describe("computeSaturationDelay", () => {
  it("returns 0 when no active tasks", () => {
    assert.equal(computeSaturationDelay(0, 10), 0);
  });

  it("returns 0 when maxConcurrent is 0", () => {
    assert.equal(computeSaturationDelay(5, 0), 0);
  });

  it("uses default config when none provided", () => {
    // 5 active / 10 max = load 0.5, default Km=0.5, baseDelay=1000
    // delay = 1000 * 0.5 / (0.5 + 0.5) = 500
    const delay = computeSaturationDelay(5, 10);
    assert.equal(delay, 500);
  });

  it("respects custom config", () => {
    // 8 active / 10 max = load 0.8, Km=0.3, baseDelay=2000
    // delay = 2000 * 0.8 / (0.3 + 0.8) ≈ 1454.5
    const delay = computeSaturationDelay(8, 10, { km: 0.3, baseDelayMs: 2000 });
    assert.ok(Math.abs(delay - 2000 * 0.8 / 1.1) < 1);
  });

  it("delay increases as load approaches max", () => {
    const delays = [1, 3, 5, 7, 9].map(
      (active) => computeSaturationDelay(active, 10, { km: 0.5, baseDelayMs: 1000 }),
    );
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] > delays[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// parseSaturationConfig
// ---------------------------------------------------------------------------

describe("parseSaturationConfig", () => {
  it("returns null when raw is undefined", () => {
    assert.equal(parseSaturationConfig(undefined), null);
  });

  it("parses valid config", () => {
    const config = parseSaturationConfig({ km: 0.3, baseDelayMs: 2000 });
    assert.ok(config);
    assert.equal(config.km, 0.3);
    assert.equal(config.baseDelayMs, 2000);
  });

  it("uses defaults for missing fields", () => {
    const config = parseSaturationConfig({});
    assert.ok(config);
    assert.equal(config.km, 0.5);
    assert.equal(config.baseDelayMs, 1000);
  });

  it("rejects non-positive km", () => {
    const config = parseSaturationConfig({ km: -1 });
    assert.ok(config);
    assert.equal(config.km, 0.5); // falls back to default
  });

  it("rejects non-positive baseDelayMs", () => {
    const config = parseSaturationConfig({ baseDelayMs: 0 });
    assert.ok(config);
    assert.equal(config.baseDelayMs, 1000); // falls back to default
  });
});
