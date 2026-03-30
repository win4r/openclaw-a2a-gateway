import type {
  PeerConfig,
  HealthCheckConfig,
  CircuitBreakerConfig,
  CircuitState,
  HealthStatus,
  PeerState,
} from "./types.js";

type LogFn = (level: "info" | "warn" | "error", msg: string, details?: Record<string, unknown>) => void;
type HealthProbe = (peer: PeerConfig) => Promise<boolean>;

/**
 * Compute recovery capacity using an exponential curve.
 *
 *   capacity(t) = 1 - exp(-k * t_seconds)
 *
 * Analogous to receptor recycling: internalized receptors gradually return
 * to the cell surface, restoring signal transduction capacity.
 *
 * @param elapsedMs  Milliseconds since recovery began.
 * @param k          Recovery rate constant (higher = faster recovery).
 * @returns Capacity in [0, 1].
 *
 * @see Bhalla, U.S. & Bhatt, D.K. (2007) "Receptor desensitization
 *   produces complex dose-response" BMC Syst Biol 1:54.
 */
export function computeRecoveryCapacity(elapsedMs: number, k: number): number {
  if (elapsedMs <= 0) return 0;
  return 1 - Math.exp(-k * (elapsedMs / 1000));
}

// Recovery is considered complete when capacity exceeds this threshold.
const RECOVERY_COMPLETE_THRESHOLD = 0.99;
// Deterministic round-robin period for capacity-based throttling.
const CAPACITY_PERIOD = 10;

/**
 * Manages per-peer health checks and circuit breaker state.
 *
 * Health checks periodically probe each peer's Agent Card endpoint.
 * The circuit breaker follows a four-state pattern inspired by receptor
 * desensitization in cell signaling:
 *
 *   CLOSED → DESENSITIZED → OPEN → RECOVERING → CLOSED
 *
 * - **DESENSITIZED** (new): triggered at `softThreshold`, allows partial
 *   traffic. Analogous to receptor phosphorylation reducing signal gain.
 * - **RECOVERING** (replaces half-open): after cooldown, capacity ramps
 *   up via exponential curve. Analogous to receptor recycling.
 *
 * Without optional config fields (`softThreshold`, `recoveryRateConstant`),
 * behaviour is identical to the legacy three-state pattern.
 *
 * @see Bhalla, U.S. & Bhatt, D.K. (2007) BMC Syst Biol 1:54.
 */
export class PeerHealthManager {
  private readonly states = new Map<string, PeerState>();
  private readonly peerSkills = new Map<string, string[]>();
  private readonly peers: PeerConfig[];
  private readonly healthConfig: HealthCheckConfig;
  private readonly cbConfig: CircuitBreakerConfig;
  private readonly probe: HealthProbe;
  private readonly log: LogFn;
  private timer: ReturnType<typeof setInterval> | null = null;
  private recoveringInFlight = new Set<string>();
  /** Per-peer counter for deterministic capacity-based throttling. */
  private capacityCounters = new Map<string, number>();

  constructor(
    peers: PeerConfig[],
    healthConfig: HealthCheckConfig,
    cbConfig: CircuitBreakerConfig,
    probe: HealthProbe,
    log: LogFn,
  ) {
    this.peers = peers;
    this.healthConfig = healthConfig;
    this.cbConfig = cbConfig;
    this.probe = probe;
    this.log = log;

    // Initialize state for each peer
    for (const peer of peers) {
      this.states.set(peer.name, {
        health: "unknown",
        circuit: "closed",
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastCheckAt: null,
        recoveringSince: null,
      });
    }
  }

  /** Start periodic health checks. */
  start(): void {
    if (!this.healthConfig.enabled || this.peers.length === 0) return;

    this.log("info", "peer.health.start", {
      peers: this.peers.map((p) => p.name),
      interval_ms: this.healthConfig.intervalMs,
    });

    // Run immediately, then on interval
    this.runHealthChecks();
    this.timer = setInterval(() => this.runHealthChecks(), this.healthConfig.intervalMs);
  }

  /** Stop periodic health checks. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Check if a peer is available for requests. */
  isAvailable(peerName: string): boolean {
    const state = this.states.get(peerName);
    if (!state) return true; // Unknown peer → allow (fail at send)

    if (state.circuit === "closed") return true;

    if (state.circuit === "desensitized") {
      return this.checkCapacity(peerName, this.cbConfig.desensitizedCapacity ?? 0.5);
    }

    if (state.circuit === "open") {
      // Check if cooldown has elapsed → transition to recovering
      if (
        state.lastFailureAt &&
        Date.now() - state.lastFailureAt >= this.cbConfig.resetTimeoutMs
      ) {
        state.circuit = "recovering";
        state.recoveringSince = Date.now();
        this.recoveringInFlight.add(peerName);
        this.capacityCounters.set(peerName, 0);
        this.log("info", "peer.circuit.recovering", { peer: peerName });
        return true;
      }
      return false;
    }

    // recovering
    if (this.cbConfig.recoveryRateConstant != null) {
      // Gradual recovery: capacity increases over time
      const elapsed = Date.now() - (state.recoveringSince ?? Date.now());
      const capacity = computeRecoveryCapacity(elapsed, this.cbConfig.recoveryRateConstant);
      if (capacity >= RECOVERY_COMPLETE_THRESHOLD) {
        // Recovery complete → close circuit
        state.circuit = "closed";
        state.consecutiveFailures = 0;
        state.health = "healthy";
        state.recoveringSince = null;
        this.recoveringInFlight.delete(peerName);
        this.log("info", "peer.circuit.closed", {
          peer: peerName,
          previous: "recovering",
          reason: "recovery complete",
        });
        return true;
      }
      return this.checkCapacity(peerName, capacity);
    }

    // No recoveryRateConstant → single-probe mode (legacy half-open behavior)
    if (this.recoveringInFlight.has(peerName)) return false;
    this.recoveringInFlight.add(peerName);
    return true;
  }

  /** Deterministic capacity check using round-robin. */
  private checkCapacity(peerName: string, capacity: number): boolean {
    if (capacity >= 1) return true;
    if (capacity <= 0) return false;
    const counter = this.capacityCounters.get(peerName) ?? 0;
    this.capacityCounters.set(peerName, counter + 1);
    const allowCount = Math.round(capacity * CAPACITY_PERIOD);
    return (counter % CAPACITY_PERIOD) < allowCount;
  }

  /** Record a successful call to a peer. */
  recordSuccess(peerName: string): void {
    const state = this.states.get(peerName);
    if (!state) return;

    const prevCircuit = state.circuit;
    state.consecutiveFailures = 0;
    state.health = "healthy";
    state.recoveringSince = null;
    this.recoveringInFlight.delete(peerName);
    this.capacityCounters.delete(peerName);

    if (state.circuit !== "closed") {
      state.circuit = "closed";
      this.log("info", "peer.circuit.closed", {
        peer: peerName,
        previous: prevCircuit,
      });
    }
  }

  /** Record a failed call to a peer. May trigger circuit state change. */
  recordFailure(peerName: string): void {
    const state = this.states.get(peerName);
    if (!state) return;

    state.consecutiveFailures += 1;
    state.lastFailureAt = Date.now();
    this.recoveringInFlight.delete(peerName);

    // recovering failure → back to open
    if (state.circuit === "recovering") {
      state.circuit = "open";
      state.recoveringSince = null;
      this.log("warn", "peer.circuit.open", {
        peer: peerName,
        reason: "recovery probe failed",
        consecutive_failures: state.consecutiveFailures,
      });
      return;
    }

    // desensitized: check if hard threshold reached
    if (state.circuit === "desensitized") {
      if (state.consecutiveFailures >= this.cbConfig.failureThreshold) {
        state.circuit = "open";
        state.health = "unhealthy";
        this.capacityCounters.delete(peerName);
        this.log("warn", "peer.circuit.open", {
          peer: peerName,
          reason: "failure threshold reached (from desensitized)",
          consecutive_failures: state.consecutiveFailures,
        });
      }
      return;
    }

    // closed: check soft threshold first, then hard threshold
    if (state.circuit === "closed") {
      const soft = this.cbConfig.softThreshold;
      if (
        soft != null &&
        soft < this.cbConfig.failureThreshold &&
        state.consecutiveFailures >= soft &&
        state.consecutiveFailures < this.cbConfig.failureThreshold
      ) {
        state.circuit = "desensitized";
        this.capacityCounters.set(peerName, 0);
        this.log("warn", "peer.circuit.desensitized", {
          peer: peerName,
          consecutive_failures: state.consecutiveFailures,
          capacity: this.cbConfig.desensitizedCapacity ?? 0.5,
        });
        return;
      }

      if (state.consecutiveFailures >= this.cbConfig.failureThreshold) {
        state.circuit = "open";
        state.health = "unhealthy";
        this.log("warn", "peer.circuit.open", {
          peer: peerName,
          reason: "failure threshold reached",
          consecutive_failures: state.consecutiveFailures,
        });
      }
    }
  }

  /** Get state for a single peer. */
  getState(peerName: string): PeerState | undefined {
    return this.states.get(peerName);
  }

  /** Get states for all peers. */
  getAllStates(): Map<string, PeerState> {
    return new Map(this.states);
  }

  /**
   * Cache skills advertised by a peer's Agent Card.
   * Called from the health check probe after a successful Agent Card fetch.
   */
  updateSkills(peerName: string, skills: string[]): void {
    this.peerSkills.set(peerName, skills);
  }

  /**
   * Return cached skills for all peers.
   * Used by rule-based routing to match `skills` criteria.
   */
  getPeerSkills(): Map<string, string[]> {
    return new Map(this.peerSkills);
  }

  /** Run health checks for all peers. */
  private runHealthChecks(): void {
    for (const peer of this.peers) {
      this.checkPeer(peer).catch((err) => {
        this.log("error", "peer.health.check-error", {
          peer: peer.name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /** Probe a single peer and update its state. */
  private async checkPeer(peer: PeerConfig): Promise<void> {
    const state = this.states.get(peer.name);
    if (!state) return;

    const healthy = await this.probe(peer);
    state.lastCheckAt = Date.now();

    if (healthy) {
      this.recordSuccess(peer.name);
    } else {
      state.health = "unhealthy";
      this.recordFailure(peer.name);
    }
  }
}
