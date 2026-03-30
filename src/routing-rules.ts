/**
 * Rule-based routing — choose peer + agentId based on message content.
 *
 * Rules are evaluated at send-time in priority order (higher priority first).
 * The first matching rule wins (legacy). When {@link AffinityConfig} is
 * provided, rules are scored using the Hill equation (Hill, 1910) and
 * returned in descending score order.
 *
 * @see Hill, A.V. (1910) "The possible effects of the aggregation of the
 *   molecules of haemoglobin on its dissociation curves." J Physiol 40, iv–vii.
 * @see Finlay, D.B. et al. (2020) "100 years of modelling ligand-receptor
 *   binding and response." Br J Pharmacol 177(7):1472-1484.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutingRule {
  name: string;
  match: {
    /** Regex pattern to match against message text (case-insensitive). */
    pattern?: string;
    /** Match if message contains any of these tags (OR logic). */
    tags?: string[];
    /** Match if target peer has any of these skills. */
    skills?: string[];
  };
  target: {
    peer: string;
    agentId?: string;
  };
  /** Higher = checked first (default: 0). */
  priority?: number;
}

export interface RoutingMatch {
  peer: string;
  agentId?: string;
}

/**
 * Configuration for Hill-equation-based affinity scoring.
 *
 * When provided to {@link matchAllRules}, each matching rule is scored using:
 *
 *   score = affinity^n / (Kd^n + affinity^n)
 *
 * where `affinity` is a weighted combination of match dimensions.
 */
export interface AffinityConfig {
  /**
   * Hill coefficient (n). Controls the steepness of the scoring sigmoid.
   * - n = 1: linear response (Michaelis-Menten, equivalent to legacy behavior)
   * - n > 1: threshold effect ("good enough" peers strongly preferred)
   * - n < 1: dispersive (spreads load more evenly)
   * @default 1
   */
  hillCoefficient?: number;
  /**
   * Half-saturation constant. When affinity equals Kd, score = 0.5.
   * Lower Kd → stricter (high-affinity receptor analogy).
   * @default 0.5
   */
  kd?: number;
  /** Per-dimension weights (must sum to ~1 for interpretability). */
  weights?: AffinityWeights;
}

export interface AffinityWeights {
  /** Weight for skill match ratio (matched / required). @default 0.4 */
  skills?: number;
  /** Weight for tag match ratio (matched / required). @default 0.3 */
  tags?: number;
  /** Weight for pattern match (1 if matched, 0 if not). @default 0.2 */
  pattern?: number;
  /** Weight for historical success rate of the peer. @default 0.1 */
  successRate?: number;
}

/**
 * A routing match extended with a Hill-equation affinity score.
 */
export interface ScoredMatch extends RoutingMatch {
  /** Hill score in [0, 1]. Higher = better affinity. */
  score: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse and validate routing rules from raw config.
 *
 * Invalid entries (missing name, target.peer, or at least one match criterion)
 * are silently dropped.
 */
export function parseRoutingRules(raw: unknown): RoutingRule[] {
  if (!Array.isArray(raw)) return [];

  const rules: RoutingRule[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;

    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) continue;

    const matchRaw = obj.match && typeof obj.match === "object" ? obj.match as Record<string, unknown> : null;
    if (!matchRaw) continue;

    const pattern = typeof matchRaw.pattern === "string" ? matchRaw.pattern : undefined;
    const tags = Array.isArray(matchRaw.tags)
      ? (matchRaw.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0)
      : undefined;
    const skills = Array.isArray(matchRaw.skills)
      ? (matchRaw.skills as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
      : undefined;

    // At least one match criterion required
    const hasPattern = pattern !== undefined && pattern.length > 0;
    const hasTags = tags !== undefined && tags.length > 0;
    const hasSkills = skills !== undefined && skills.length > 0;
    if (!hasPattern && !hasTags && !hasSkills) continue;

    const targetRaw = obj.target && typeof obj.target === "object" ? obj.target as Record<string, unknown> : null;
    if (!targetRaw) continue;

    const peer = typeof targetRaw.peer === "string" ? targetRaw.peer.trim() : "";
    if (!peer) continue;

    const agentId = typeof targetRaw.agentId === "string" ? targetRaw.agentId.trim() || undefined : undefined;

    const priority = typeof obj.priority === "number" && Number.isFinite(obj.priority) ? obj.priority : 0;

    rules.push({
      name,
      match: {
        ...(hasPattern ? { pattern } : {}),
        ...(hasTags ? { tags } : {}),
        ...(hasSkills ? { skills } : {}),
      },
      target: { peer, ...(agentId ? { agentId } : {}) },
      priority,
    });
  }

  // Sort by priority descending (higher first), stable order for same priority
  rules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  return rules;
}

// ---------------------------------------------------------------------------
// Hill equation — pure math
// ---------------------------------------------------------------------------

const DEFAULT_N = 1;
const DEFAULT_KD = 0.5;
const DEFAULT_WEIGHTS: Required<AffinityWeights> = {
  skills: 0.4,
  tags: 0.3,
  pattern: 0.2,
  successRate: 0.1,
};

/**
 * Hill equation: score = affinity^n / (Kd^n + affinity^n)
 *
 * When affinity = Kd, score = 0.5 (half-saturation, by definition).
 *
 * @param affinity  Raw affinity value in [0, 1].
 * @param n         Hill coefficient (steepness). n=1 → Michaelis-Menten.
 * @param kd        Half-saturation constant.
 * @returns Score in [0, 1].
 *
 * @see Hill, A.V. (1910) J Physiol 40, iv–vii.
 */
export function hillScore(affinity: number, n: number, kd: number): number {
  if (affinity <= 0) return 0;
  if (kd <= 0) return affinity > 0 ? 1 : 0;
  const an = affinity ** n;
  const kn = kd ** n;
  return an / (kn + an);
}

// ---------------------------------------------------------------------------
// Affinity computation
// ---------------------------------------------------------------------------

/**
 * Compute raw affinity for a (rule, message, peer) triple.
 *
 * Affinity is a weighted sum of per-dimension match ratios:
 *   - skill_match_ratio:  matched skills / required skills   (0-1)
 *   - tag_match_ratio:    matched tags / required tags       (0-1)
 *   - pattern_match:      regex matched = 1, else 0
 *   - success_rate:       historical success rate            (0-1, optional)
 *
 * Dimensions that are not specified in the rule contribute their full
 * weight (1.0), so a rule with only `pattern` set gets pattern + full
 * credit for skills and tags.  This keeps simple rules competitive.
 */
export function computeAffinity(
  rule: RoutingRule,
  message: { text: string; tags?: string[] },
  peerSkills?: Map<string, string[]>,
  successRates?: Map<string, number>,
  weights?: AffinityWeights,
): number {
  const w = { ...DEFAULT_WEIGHTS, ...weights };

  // --- skill match ratio ---
  let skillRatio = 1; // default: full credit when not specified
  if (rule.match.skills && rule.match.skills.length > 0) {
    const peerSet = peerSkills?.get(rule.target.peer) ?? [];
    const matched = rule.match.skills.filter((s) => peerSet.includes(s)).length;
    skillRatio = matched / rule.match.skills.length;
  }

  // --- tag match ratio ---
  let tagRatio = 1;
  if (rule.match.tags && rule.match.tags.length > 0) {
    const msgTags = message.tags ?? [];
    const matched = rule.match.tags.filter((t) => msgTags.includes(t)).length;
    tagRatio = matched / rule.match.tags.length;
  }

  // --- pattern match ---
  let patternMatch = 1; // default: full credit when not specified
  if (rule.match.pattern) {
    if (rule.match.pattern.length > 500) {
      patternMatch = 0;
    } else {
      try {
        const re = new RegExp(rule.match.pattern, "i");
        patternMatch = re.test(message.text.slice(0, 10_000)) ? 1 : 0;
      } catch {
        patternMatch = 0;
      }
    }
  }

  // --- success rate ---
  const successRate = successRates?.get(rule.target.peer) ?? 1;

  return (
    w.skills * skillRatio +
    w.tags * tagRatio +
    w.pattern * patternMatch +
    w.successRate * successRate
  );
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Score all matching rules using Hill-equation affinity.
 *
 * When `affinityConfig` is **not** provided, behaviour is identical to the
 * legacy priority-first model: matching rules are returned in priority
 * order with score = 1 for all (backward-compatible).
 *
 * When `affinityConfig` **is** provided, each rule that passes the boolean
 * AND-gate ({@link matchesRule}) is scored via {@link hillScore} over its
 * {@link computeAffinity} value, and results are sorted by score descending.
 *
 * @returns Scored matches, highest score first.
 */
export function matchAllRules(
  rules: RoutingRule[],
  message: { text: string; tags?: string[] },
  peerSkills?: Map<string, string[]>,
  successRates?: Map<string, number>,
  affinityConfig?: AffinityConfig,
): ScoredMatch[] {
  const scored: ScoredMatch[] = [];

  for (const rule of rules) {
    if (!matchesRule(rule, message, peerSkills)) continue;

    const match: RoutingMatch = {
      peer: rule.target.peer,
      ...(rule.target.agentId ? { agentId: rule.target.agentId } : {}),
    };

    if (!affinityConfig) {
      // Legacy mode: score = 1 (priority order preserved from parseRoutingRules)
      scored.push({ ...match, score: 1 });
    } else {
      const n = affinityConfig.hillCoefficient ?? DEFAULT_N;
      const kd = affinityConfig.kd ?? DEFAULT_KD;
      const raw = computeAffinity(rule, message, peerSkills, successRates, affinityConfig.weights);
      scored.push({ ...match, score: hillScore(raw, n, kd) });
    }
  }

  // When using affinity scoring, sort by score descending.
  // In legacy mode all scores are 1 so original priority order is preserved.
  if (affinityConfig) {
    scored.sort((a, b) => b.score - a.score);
  }

  return scored;
}

/**
 * Evaluate rules in priority order against a message.
 *
 * Match criteria within a single rule are AND-combined:
 *   - pattern: regex test against message text
 *   - tags: any overlap between message tags and rule tags
 *   - skills: target peer advertises at least one required skill
 *
 * Returns the first match or null.
 *
 * The `peerSkills` map is populated from Agent Card discovery during
 * periodic health checks. Skills are cached per peer and refreshed
 * on each successful health check probe.
 */
export function matchRule(
  rules: RoutingRule[],
  message: { text: string; tags?: string[] },
  peerSkills?: Map<string, string[]>,
): RoutingMatch | null {
  // Backward-compatible: no affinity scoring, priority-first.
  const results = matchAllRules(rules, message, peerSkills);
  if (results.length === 0) return null;
  const { score: _, ...match } = results[0];
  return match;
}

/**
 * Test whether a single rule matches the given message.
 * All specified criteria must match (AND logic across criteria).
 */
function matchesRule(
  rule: RoutingRule,
  message: { text: string; tags?: string[] },
  peerSkills?: Map<string, string[]>,
): boolean {
  // Pattern matching (case-insensitive, with length limit to mitigate ReDoS)
  if (rule.match.pattern) {
    if (rule.match.pattern.length > 500) return false; // reject overly complex patterns
    try {
      const re = new RegExp(rule.match.pattern, "i");
      // Test against a truncated message to limit backtracking surface
      if (!re.test(message.text.slice(0, 10_000))) return false;
    } catch {
      // Invalid regex → rule cannot match
      return false;
    }
  }

  // Tag matching (OR: any tag in common)
  if (rule.match.tags && rule.match.tags.length > 0) {
    const messageTags = message.tags ?? [];
    const hit = rule.match.tags.some((t) => messageTags.includes(t));
    if (!hit) return false;
  }

  // Skill matching (OR: peer has at least one required skill)
  if (rule.match.skills && rule.match.skills.length > 0) {
    const skills = peerSkills?.get(rule.target.peer) ?? [];
    const hit = rule.match.skills.some((s) => skills.includes(s));
    if (!hit) return false;
  }

  return true;
}
