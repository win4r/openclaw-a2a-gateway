/**
 * Rule-based routing — choose peer + agentId based on message content.
 *
 * Rules are evaluated at send-time in priority order (higher priority first).
 * The first matching rule wins.
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
// Matching
// ---------------------------------------------------------------------------

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
 * **Known limitation (v1):** The `peerSkills` map is not yet populated
 * at runtime — skills-based matching always returns no match. Use
 * `pattern` or `tags` criteria for now. Wiring peer skill caching from
 * health-check Agent Card discovery is planned for a future release.
 */
export function matchRule(
  rules: RoutingRule[],
  message: { text: string; tags?: string[] },
  peerSkills?: Map<string, string[]>,
): RoutingMatch | null {
  for (const rule of rules) {
    if (!matchesRule(rule, message, peerSkills)) continue;

    return {
      peer: rule.target.peer,
      ...(rule.target.agentId ? { agentId: rule.target.agentId } : {}),
    };
  }

  return null;
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
