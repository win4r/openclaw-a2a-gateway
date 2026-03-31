/**
 * Quorum-sensing density-aware discovery for A2A peer networks.
 *
 * Inspired by bacterial quorum sensing (QS): microorganisms secrete
 * autoinducer molecules and monitor local concentration.  When the
 * concentration exceeds a threshold the colony switches collective
 * behaviour (e.g. biofilm formation, virulence factor expression).
 *
 * Mapping to A2A discovery:
 *   - "autoinducer concentration" → number of discovered peers (density)
 *   - θ_activate  → switch to "stable" mode (less frequent polling)
 *   - θ_deactivate → switch back to "explore" mode (more frequent polling)
 *   - θ_activate > θ_deactivate  → hysteresis prevents oscillation,
 *     analogous to the positive-feedback loop in LuxR/LuxI systems.
 *
 * Without quorum config, the underlying {@link DnsDiscoveryManager} runs
 * at its fixed `refreshIntervalMs` — behaviour is unchanged.
 *
 * @see Tamsir, A. et al. (2011) "Robust multicellular computing using
 *   genetically encoded NOR gates and chemical 'wires'" Nature 469:212–215.
 * @see Gao, M. et al. (2021) "Quorum Sensing as Consensus: Mathematical
 *   Parallels Between Microbial and Multi-Agent Systems" MIT CSAIL TR.
 */

import type { DnsDiscoveryManager, DiscoveryLogFn } from "./dns-discovery.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export type QuorumMode = "explore" | "stable";

/**
 * Configuration for quorum-sensing adaptive discovery.
 *
 * The two thresholds implement a Schmitt-trigger-style hysteresis:
 * `activateThreshold` must be strictly greater than `deactivateThreshold`.
 */
export interface QuorumConfig {
  /**
   * Peer count at or above which the system enters "stable" mode.
   * Analogous to the autoinducer concentration that triggers group behaviour.
   */
  activateThreshold: number;
  /**
   * Peer count below which the system re-enters "explore" mode.
   * Must be strictly less than `activateThreshold` (hysteresis gap).
   */
  deactivateThreshold: number;
  /**
   * Refresh interval in "stable" mode (ms).  Longer interval reduces
   * network chatter when the peer population is already well-known.
   * @default 120_000
   */
  stableIntervalMs?: number;
  /**
   * Refresh interval in "explore" mode (ms).  Shorter interval speeds
   * up discovery when few peers are known.
   * @default 10_000
   */
  exploreIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STABLE_INTERVAL_MS = 120_000;
const DEFAULT_EXPLORE_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Wraps a {@link DnsDiscoveryManager} with density-aware adaptive polling.
 *
 * Instead of polling DNS at a fixed interval, the manager monitors peer
 * density after each refresh cycle and adjusts the next poll delay:
 *
 *   - **explore** mode (default): short interval, aggressive discovery
 *   - **stable** mode: long interval, reduced network overhead
 *
 * Mode transitions use hysteresis (θ_activate > θ_deactivate) to prevent
 * rapid oscillation at the boundary — the same mechanism that stabilizes
 * QS switching in natural microbial populations.
 */
export class QuorumDiscoveryManager {
  private readonly dns: DnsDiscoveryManager;
  private readonly activateThreshold: number;
  private readonly deactivateThreshold: number;
  private readonly stableIntervalMs: number;
  private readonly exploreIntervalMs: number;
  private readonly log: DiscoveryLogFn;

  private mode: QuorumMode = "explore";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    dns: DnsDiscoveryManager,
    config: QuorumConfig,
    log: DiscoveryLogFn,
  ) {
    if (config.deactivateThreshold >= config.activateThreshold) {
      throw new Error(
        "deactivateThreshold must be strictly less than activateThreshold (hysteresis requirement)",
      );
    }
    if (config.activateThreshold < 1) {
      throw new Error("activateThreshold must be >= 1");
    }
    if (config.deactivateThreshold < 0) {
      throw new Error("deactivateThreshold must be >= 0");
    }

    this.dns = dns;
    this.activateThreshold = config.activateThreshold;
    this.deactivateThreshold = config.deactivateThreshold;
    this.stableIntervalMs = config.stableIntervalMs ?? DEFAULT_STABLE_INTERVAL_MS;
    this.exploreIntervalMs = config.exploreIntervalMs ?? DEFAULT_EXPLORE_INTERVAL_MS;
    this.log = log;
  }

  /** Begin density-aware discovery polling. */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.log("info", "quorum.start", {
      activateThreshold: this.activateThreshold,
      deactivateThreshold: this.deactivateThreshold,
      stableIntervalMs: this.stableIntervalMs,
      exploreIntervalMs: this.exploreIntervalMs,
    });

    // Immediate first tick, then adaptive scheduling
    this.scheduleNext(0);
  }

  /** Stop polling and clean up. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.log("info", "quorum.stop", { finalMode: this.mode });
  }

  /** Current quorum mode. */
  getMode(): QuorumMode {
    return this.mode;
  }

  /** Current peer density (number of discovered peers). */
  getDensity(): number {
    return this.dns.getDiscoveredPeers().length;
  }

  /** Refresh interval for the current mode (ms). */
  getCurrentIntervalMs(): number {
    return this.mode === "stable"
      ? this.stableIntervalMs
      : this.exploreIntervalMs;
  }

  /** Access the wrapped DNS discovery manager. */
  getDnsManager(): DnsDiscoveryManager {
    return this.dns;
  }

  // -------------------------------------------------------------------------
  // Internal scheduling
  // -------------------------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    // Perform one discovery cycle
    await this.dns.triggerRefresh();

    // Evaluate density and apply hysteresis-based mode switching
    const density = this.dns.getDiscoveredPeers().length;
    const prevMode = this.mode;

    if (this.mode === "explore" && density >= this.activateThreshold) {
      this.mode = "stable";
    } else if (this.mode === "stable" && density < this.deactivateThreshold) {
      this.mode = "explore";
    }
    // Note: density between deactivateThreshold and activateThreshold
    // does NOT trigger a switch — this is the hysteresis dead zone.

    if (this.mode !== prevMode) {
      this.log("info", "quorum.mode-change", {
        from: prevMode,
        to: this.mode,
        density,
        intervalMs: this.getCurrentIntervalMs(),
      });
    }

    // Schedule next tick with mode-appropriate interval
    this.scheduleNext(this.getCurrentIntervalMs());
  }
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

export const QUORUM_DEFAULTS = {
  activateThreshold: 5,
  deactivateThreshold: 2,
  stableIntervalMs: DEFAULT_STABLE_INTERVAL_MS,
  exploreIntervalMs: DEFAULT_EXPLORE_INTERVAL_MS,
} as const;

/**
 * Parse quorum config from raw user-provided config object.
 * Returns `null` if quorum sensing is not configured.
 */
export function parseQuorumConfig(
  raw: Record<string, unknown> | undefined,
): QuorumConfig | null {
  if (!raw) return null;

  const activate =
    typeof raw.activateThreshold === "number" &&
    Number.isFinite(raw.activateThreshold) &&
    raw.activateThreshold >= 1
      ? raw.activateThreshold
      : QUORUM_DEFAULTS.activateThreshold;

  const deactivate =
    typeof raw.deactivateThreshold === "number" &&
    Number.isFinite(raw.deactivateThreshold) &&
    raw.deactivateThreshold >= 0
      ? raw.deactivateThreshold
      : QUORUM_DEFAULTS.deactivateThreshold;

  // Enforce hysteresis constraint
  if (deactivate >= activate) {
    return null;
  }

  const stableMs =
    typeof raw.stableIntervalMs === "number" &&
    Number.isFinite(raw.stableIntervalMs) &&
    raw.stableIntervalMs >= 1000
      ? raw.stableIntervalMs
      : QUORUM_DEFAULTS.stableIntervalMs;

  const exploreMs =
    typeof raw.exploreIntervalMs === "number" &&
    Number.isFinite(raw.exploreIntervalMs) &&
    raw.exploreIntervalMs >= 1000
      ? raw.exploreIntervalMs
      : QUORUM_DEFAULTS.exploreIntervalMs;

  return {
    activateThreshold: activate,
    deactivateThreshold: deactivate,
    stableIntervalMs: stableMs,
    exploreIntervalMs: exploreMs,
  };
}
