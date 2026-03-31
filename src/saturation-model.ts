/**
 * Michaelis-Menten saturation model for soft concurrency limiting.
 *
 * Enzyme kinetics: v = Vmax · [S] / (Km + [S])
 *
 * Instead of hard-rejecting tasks above a threshold, this model adds a
 * progressive delay that increases with load, allowing the system to
 * degrade gracefully.  Analogous to enzyme saturation: at Vmax the
 * enzyme doesn't "reject" substrates — it processes them more slowly.
 *
 *   delay(load) = baseDelay · load / (Km + load)
 *
 * where:
 *   - load = activeTasks / maxConcurrentTasks  (utilization ratio)
 *   - Km   = load at which delay = baseDelay / 2  (half-saturation)
 *   - baseDelay = maximum delay at full saturation
 *
 * At low load (load << Km): delay ≈ 0          (linear region)
 * At Km:                    delay = baseDelay/2 (half-saturation)
 * At high load (load >> Km): delay → baseDelay  (saturated plateau)
 *
 * The hard limit (maxConcurrentTasks) still applies — the saturation
 * delay is purely additive, providing a soft "pressure" zone before the
 * hard wall.
 *
 * @see Michaelis, L. & Menten, M.L. (1913) "Die Kinetik der
 *   Invertinwirkung." Biochem Z 49:333-369.
 * @see Johnson, K.A. & Goody, R.S. (2011) "The Original Michaelis
 *   Constant." Biochemistry 50(39):8264-8269.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for Michaelis-Menten soft concurrency limiting.
 *
 * When provided to the queueing executor, a progressive delay is added
 * before task execution based on the current load ratio.
 */
export interface SaturationConfig {
  /**
   * Half-saturation constant (as load ratio).  When utilization reaches
   * this fraction of maxConcurrentTasks, delay equals baseDelayMs / 2.
   *
   * Lower Km → delay ramps up sooner (enzyme with high substrate affinity).
   * Higher Km → delay ramps up later (enzyme with low affinity).
   * @default 0.5
   */
  km?: number;
  /**
   * Maximum delay in ms at full saturation.
   * @default 1000
   */
  baseDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_KM = 0.5;
const DEFAULT_BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Michaelis-Menten delay function.
 *
 *   delay = baseDelay × load / (Km + load)
 *
 * @param load       Current utilization ratio (activeTasks / maxConcurrent).
 * @param km         Half-saturation constant.
 * @param baseDelay  Maximum delay at saturation (ms).
 * @returns Delay in ms, in range [0, baseDelay).
 *
 * @see Michaelis & Menten (1913) Biochem Z 49:333-369.
 */
export function michaelisMentenDelay(
  load: number,
  km: number,
  baseDelay: number,
): number {
  if (load <= 0) return 0;
  if (km <= 0) return baseDelay; // infinite affinity → instant saturation
  return baseDelay * load / (km + load);
}

/**
 * Compute the saturation delay for the current executor state.
 *
 * Convenience wrapper that converts raw task counts into a load ratio
 * and applies the Michaelis-Menten model.
 *
 * @param activeTasks    Number of currently executing tasks.
 * @param maxConcurrent  Hard concurrency limit.
 * @param config         Saturation parameters (optional fields use defaults).
 * @returns Delay in ms to apply before the next task starts.
 */
export function computeSaturationDelay(
  activeTasks: number,
  maxConcurrent: number,
  config?: SaturationConfig,
): number {
  if (maxConcurrent <= 0 || activeTasks <= 0) return 0;
  const load = activeTasks / maxConcurrent;
  const km = config?.km ?? DEFAULT_KM;
  const baseDelay = config?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  return michaelisMentenDelay(load, km, baseDelay);
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Parse saturation config from raw user-provided config object.
 * Returns `null` if saturation is not configured.
 */
export function parseSaturationConfig(
  raw: Record<string, unknown> | undefined,
): SaturationConfig | null {
  if (!raw) return null;

  const km =
    typeof raw.km === "number" &&
    Number.isFinite(raw.km) &&
    raw.km > 0
      ? raw.km
      : DEFAULT_KM;

  const baseDelayMs =
    typeof raw.baseDelayMs === "number" &&
    Number.isFinite(raw.baseDelayMs) &&
    raw.baseDelayMs > 0
      ? raw.baseDelayMs
      : DEFAULT_BASE_DELAY_MS;

  return { km, baseDelayMs };
}
