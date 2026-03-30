import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseRoutingRules,
  matchRule,
  hillScore,
  computeAffinity,
  matchAllRules,
} from "../src/routing-rules.js";
import type { RoutingRule, AffinityConfig, ScoredMatch } from "../src/routing-rules.js";
import { parseConfig } from "../index.js";
import { createHarness, invokeGatewayMethod, makeConfig } from "./helpers.js";

// ---------------------------------------------------------------------------
// parseRoutingRules
// ---------------------------------------------------------------------------

describe("parseRoutingRules", () => {
  it("parses valid rules", () => {
    const rules = parseRoutingRules([
      {
        name: "code-review",
        match: { pattern: "review|code|PR" },
        target: { peer: "Coder-Bot", agentId: "reviewer" },
        priority: 10,
      },
      {
        name: "translate",
        match: { tags: ["translation"] },
        target: { peer: "Translator-Bot" },
        priority: 5,
      },
    ]);

    assert.equal(rules.length, 2);
    assert.equal(rules[0].name, "code-review");
    assert.equal(rules[0].match.pattern, "review|code|PR");
    assert.equal(rules[0].target.peer, "Coder-Bot");
    assert.equal(rules[0].target.agentId, "reviewer");
    assert.equal(rules[0].priority, 10);
    assert.equal(rules[1].name, "translate");
    assert.deepEqual(rules[1].match.tags, ["translation"]);
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(parseRoutingRules(undefined), []);
    assert.deepEqual(parseRoutingRules(null), []);
    assert.deepEqual(parseRoutingRules("string"), []);
    assert.deepEqual(parseRoutingRules(42), []);
    assert.deepEqual(parseRoutingRules({}), []);
  });

  it("returns empty array for empty array", () => {
    assert.deepEqual(parseRoutingRules([]), []);
  });

  it("drops entries with missing name", () => {
    const rules = parseRoutingRules([
      { match: { pattern: "test" }, target: { peer: "Bot" } },
    ]);
    assert.equal(rules.length, 0);
  });

  it("drops entries with missing match", () => {
    const rules = parseRoutingRules([
      { name: "broken", target: { peer: "Bot" } },
    ]);
    assert.equal(rules.length, 0);
  });

  it("drops entries with missing target", () => {
    const rules = parseRoutingRules([
      { name: "broken", match: { pattern: "test" } },
    ]);
    assert.equal(rules.length, 0);
  });

  it("drops entries with missing target.peer", () => {
    const rules = parseRoutingRules([
      { name: "broken", match: { pattern: "test" }, target: {} },
    ]);
    assert.equal(rules.length, 0);
  });

  it("drops entries with no match criteria", () => {
    const rules = parseRoutingRules([
      { name: "empty-match", match: {}, target: { peer: "Bot" } },
    ]);
    assert.equal(rules.length, 0);
  });

  it("drops entries with empty tags and skills arrays", () => {
    const rules = parseRoutingRules([
      { name: "empty-arrays", match: { tags: [], skills: [] }, target: { peer: "Bot" } },
    ]);
    assert.equal(rules.length, 0);
  });

  it("filters out non-string tags and skills", () => {
    const rules = parseRoutingRules([
      { name: "mixed", match: { tags: ["valid", 42, null, "also-valid"] }, target: { peer: "Bot" } },
    ]);
    assert.equal(rules.length, 1);
    assert.deepEqual(rules[0].match.tags, ["valid", "also-valid"]);
  });

  it("sorts by priority descending", () => {
    const rules = parseRoutingRules([
      { name: "low", match: { pattern: "a" }, target: { peer: "A" }, priority: 1 },
      { name: "high", match: { pattern: "b" }, target: { peer: "B" }, priority: 100 },
      { name: "mid", match: { pattern: "c" }, target: { peer: "C" }, priority: 50 },
    ]);

    assert.equal(rules[0].name, "high");
    assert.equal(rules[1].name, "mid");
    assert.equal(rules[2].name, "low");
  });

  it("defaults priority to 0", () => {
    const rules = parseRoutingRules([
      { name: "no-priority", match: { pattern: "test" }, target: { peer: "Bot" } },
    ]);
    assert.equal(rules[0].priority, 0);
  });

  it("does not include agentId in target when not provided", () => {
    const rules = parseRoutingRules([
      { name: "no-agent", match: { pattern: "test" }, target: { peer: "Bot" } },
    ]);
    assert.equal(rules[0].target.agentId, undefined);
    assert.ok(!("agentId" in rules[0].target));
  });
});

// ---------------------------------------------------------------------------
// matchRule — pattern matching
// ---------------------------------------------------------------------------

describe("matchRule — pattern matching", () => {
  const rules: RoutingRule[] = parseRoutingRules([
    { name: "code", match: { pattern: "review|code|PR" }, target: { peer: "Coder" }, priority: 10 },
  ]);

  it("matches regex pattern", () => {
    const result = matchRule(rules, { text: "Please review this code" });
    assert.deepEqual(result, { peer: "Coder" });
  });

  it("matches case-insensitively", () => {
    const result = matchRule(rules, { text: "CODE REVIEW please" });
    assert.deepEqual(result, { peer: "Coder" });
  });

  it("returns null when pattern does not match", () => {
    const result = matchRule(rules, { text: "Hello world" });
    assert.equal(result, null);
  });

  it("handles invalid regex gracefully (no match)", () => {
    const badRules = parseRoutingRules([
      { name: "bad-regex", match: { pattern: "[invalid" }, target: { peer: "Bot" } },
    ]);
    const result = matchRule(badRules, { text: "[invalid" });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// matchRule — tag matching
// ---------------------------------------------------------------------------

describe("matchRule — tag matching", () => {
  const rules: RoutingRule[] = parseRoutingRules([
    { name: "translate", match: { tags: ["translation", "i18n"] }, target: { peer: "Translator" } },
  ]);

  it("matches single overlapping tag", () => {
    const result = matchRule(rules, { text: "anything", tags: ["translation"] });
    assert.deepEqual(result, { peer: "Translator" });
  });

  it("matches with multiple overlapping tags (OR)", () => {
    const result = matchRule(rules, { text: "anything", tags: ["i18n", "translation"] });
    assert.deepEqual(result, { peer: "Translator" });
  });

  it("returns null when no tags overlap", () => {
    const result = matchRule(rules, { text: "anything", tags: ["coding"] });
    assert.equal(result, null);
  });

  it("returns null when message has no tags", () => {
    const result = matchRule(rules, { text: "anything" });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// matchRule — skill matching
// ---------------------------------------------------------------------------

describe("matchRule — skill matching", () => {
  const rules: RoutingRule[] = parseRoutingRules([
    { name: "image-gen", match: { skills: ["image-generation"] }, target: { peer: "ArtBot" } },
  ]);

  it("matches when peer has the skill", () => {
    const peerSkills = new Map([["ArtBot", ["image-generation", "chat"]]]);
    const result = matchRule(rules, { text: "draw a cat" }, peerSkills);
    assert.deepEqual(result, { peer: "ArtBot" });
  });

  it("returns null when peer lacks the skill", () => {
    const peerSkills = new Map([["ArtBot", ["chat"]]]);
    const result = matchRule(rules, { text: "draw a cat" }, peerSkills);
    assert.equal(result, null);
  });

  it("returns null when peerSkills map is not provided", () => {
    const result = matchRule(rules, { text: "draw a cat" });
    assert.equal(result, null);
  });

  it("returns null when peer is not in the skills map", () => {
    const peerSkills = new Map([["OtherBot", ["image-generation"]]]);
    const result = matchRule(rules, { text: "draw a cat" }, peerSkills);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// matchRule — combined criteria (AND logic)
// ---------------------------------------------------------------------------

describe("matchRule — combined criteria", () => {
  const rules: RoutingRule[] = parseRoutingRules([
    {
      name: "code-translate",
      match: { pattern: "translate", tags: ["code"] },
      target: { peer: "CodeTranslator" },
    },
  ]);

  it("matches when all criteria are met", () => {
    const result = matchRule(rules, { text: "please translate this", tags: ["code"] });
    assert.deepEqual(result, { peer: "CodeTranslator" });
  });

  it("returns null when pattern matches but tags do not", () => {
    const result = matchRule(rules, { text: "please translate this", tags: ["docs"] });
    assert.equal(result, null);
  });

  it("returns null when tags match but pattern does not", () => {
    const result = matchRule(rules, { text: "please review this", tags: ["code"] });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// matchRule — priority ordering
// ---------------------------------------------------------------------------

describe("matchRule — priority ordering", () => {
  it("higher priority rule wins", () => {
    const rules: RoutingRule[] = parseRoutingRules([
      { name: "low", match: { pattern: "test" }, target: { peer: "LowBot" }, priority: 1 },
      { name: "high", match: { pattern: "test" }, target: { peer: "HighBot" }, priority: 100 },
    ]);

    const result = matchRule(rules, { text: "this is a test" });
    assert.deepEqual(result, { peer: "HighBot" });
  });

  it("returns first match at same priority (insertion order)", () => {
    const rules: RoutingRule[] = parseRoutingRules([
      { name: "first", match: { pattern: "hello" }, target: { peer: "FirstBot" }, priority: 5 },
      { name: "second", match: { pattern: "hello" }, target: { peer: "SecondBot" }, priority: 5 },
    ]);

    const result = matchRule(rules, { text: "hello world" });
    assert.deepEqual(result, { peer: "FirstBot" });
  });
});

// ---------------------------------------------------------------------------
// matchRule — no match
// ---------------------------------------------------------------------------

describe("matchRule — no match", () => {
  it("returns null when no rules match", () => {
    const rules: RoutingRule[] = parseRoutingRules([
      { name: "code", match: { pattern: "code" }, target: { peer: "Coder" } },
    ]);
    assert.equal(matchRule(rules, { text: "hello" }), null);
  });

  it("returns null when rules array is empty", () => {
    assert.equal(matchRule([], { text: "hello" }), null);
  });
});

// ---------------------------------------------------------------------------
// matchRule — agentId passthrough
// ---------------------------------------------------------------------------

describe("matchRule — agentId passthrough", () => {
  it("includes agentId when rule specifies it", () => {
    const rules: RoutingRule[] = parseRoutingRules([
      { name: "review", match: { pattern: "review" }, target: { peer: "Coder", agentId: "reviewer" } },
    ]);
    const result = matchRule(rules, { text: "review this PR" });
    assert.deepEqual(result, { peer: "Coder", agentId: "reviewer" });
  });

  it("omits agentId when rule does not specify it", () => {
    const rules: RoutingRule[] = parseRoutingRules([
      { name: "general", match: { pattern: "hello" }, target: { peer: "Bot" } },
    ]);
    const result = matchRule(rules, { text: "hello" });
    assert.deepEqual(result, { peer: "Bot" });
    assert.ok(!("agentId" in result!));
  });
});

// ---------------------------------------------------------------------------
// parseConfig integration
// ---------------------------------------------------------------------------

describe("parseConfig — routing.rules integration", () => {
  it("parses routing.rules from config", () => {
    const config = parseConfig({
      routing: {
        defaultAgentId: "main",
        rules: [
          {
            name: "code-review",
            match: { pattern: "review|code" },
            target: { peer: "Coder-Bot", agentId: "reviewer" },
            priority: 10,
          },
        ],
      },
    });

    assert.equal(config.routing.rules.length, 1);
    assert.equal(config.routing.rules[0].name, "code-review");
    assert.equal(config.routing.rules[0].target.peer, "Coder-Bot");
  });

  it("defaults to empty rules when not configured", () => {
    const config = parseConfig({ routing: { defaultAgentId: "main" } });
    assert.deepEqual(config.routing.rules, []);
  });

  it("defaults to empty rules when routing is absent", () => {
    const config = parseConfig({});
    assert.deepEqual(config.routing.rules, []);
  });
});

// ---------------------------------------------------------------------------
// a2a.send gateway method — rule-based routing integration
// ---------------------------------------------------------------------------

describe("a2a.send — rule-based routing", () => {
  it("returns error when no peer specified and no rules configured", async () => {
    const harness = createHarness(makeConfig({ peers: [] }));
    const result = await invokeGatewayMethod(harness, "a2a.send", {
      message: { text: "hello" },
    });

    assert.equal(result.ok, false);
    const data = result.data as Record<string, unknown>;
    assert.ok(
      String(data.error).includes("No peer specified and no routing rule matched"),
      `Expected routing error but got: ${data.error}`,
    );
  });

  it("returns error when no peer specified and no rule matches", async () => {
    const config = makeConfig({
      peers: [
        { name: "Coder-Bot", agentCardUrl: "http://127.0.0.1:19900/.well-known/agent-card.json" },
      ],
      routing: {
        defaultAgentId: "main",
        rules: [
          {
            name: "code-only",
            match: { pattern: "code|review" },
            target: { peer: "Coder-Bot" },
          },
        ],
      },
    });
    const harness = createHarness(config);
    const result = await invokeGatewayMethod(harness, "a2a.send", {
      message: { text: "hello world" },
    });

    assert.equal(result.ok, false);
    const data = result.data as Record<string, unknown>;
    assert.ok(
      String(data.error).includes("No peer specified and no routing rule matched"),
      `Expected routing error but got: ${data.error}`,
    );
  });

  it("explicit peer bypasses rules (peer not found gives peer error, not routing error)", async () => {
    const config = makeConfig({
      peers: [],
      routing: {
        defaultAgentId: "main",
        rules: [
          {
            name: "catch-all",
            match: { pattern: ".*" },
            target: { peer: "RuleBot" },
          },
        ],
      },
    });
    const harness = createHarness(config);

    // With explicit peer that doesn't exist, should give "Peer not found" error
    // (not "No peer specified and no routing rule matched")
    const result = await invokeGatewayMethod(harness, "a2a.send", {
      peer: "ExplicitPeer",
      message: { text: "hello" },
    });

    assert.equal(result.ok, false);
    const data = result.data as Record<string, unknown>;
    assert.ok(
      String(data.error).includes("Peer not found: ExplicitPeer"),
      `Expected 'Peer not found' error but got: ${data.error}`,
    );
  });
});

// ===========================================================================
// Hill equation affinity scoring (Phase 1.1 — Bio-inspired routing)
// ===========================================================================

// ---------------------------------------------------------------------------
// hillScore — pure math (Hill 1910)
// ---------------------------------------------------------------------------

describe("hillScore — Hill equation math", () => {
  it("half-saturation: hillScore(Kd, n, Kd) === 0.5 for any n", () => {
    assert.equal(hillScore(0.5, 1, 0.5), 0.5);
    assert.equal(hillScore(0.5, 2, 0.5), 0.5);
    assert.equal(hillScore(0.5, 3, 0.5), 0.5);
  });

  it("full saturation: hillScore(1, n, Kd) approaches 1", () => {
    // hillScore(1, 2, 0.5) = 1/(0.25+1) = 0.8; higher n → closer to 1
    assert.ok(hillScore(1, 2, 0.5) === 0.8, `Expected 0.8, got ${hillScore(1, 2, 0.5)}`);
    assert.ok(hillScore(1, 4, 0.5) > 0.9, `n=4 should give > 0.9`);
  });

  it("zero affinity: hillScore(0, n, Kd) === 0", () => {
    assert.equal(hillScore(0, 1, 0.5), 0);
    assert.equal(hillScore(0, 3, 0.5), 0);
  });

  it("higher n gives steeper sigmoid: score at 0.8 with n=3 > n=1", () => {
    const s1 = hillScore(0.8, 1, 0.5);
    const s3 = hillScore(0.8, 3, 0.5);
    assert.ok(s3 > s1, `n=3 score ${s3} should be > n=1 score ${s1}`);
  });

  it("lower n gives gentler curve: score at 0.3 with n=0.5 > n=2", () => {
    const s05 = hillScore(0.3, 0.5, 0.5);
    const s2 = hillScore(0.3, 2, 0.5);
    assert.ok(s05 > s2, `n=0.5 score ${s05} should be > n=2 score ${s2}`);
  });

  it("score is always in [0, 1] range", () => {
    for (const a of [0, 0.1, 0.5, 0.9, 1.0]) {
      for (const n of [0.5, 1, 2, 3]) {
        const s = hillScore(a, n, 0.5);
        assert.ok(s >= 0 && s <= 1, `hillScore(${a}, ${n}, 0.5) = ${s} out of range`);
      }
    }
  });

  it("n=1 gives linear-like response (equivalent to Michaelis-Menten)", () => {
    // At n=1: score = a / (Kd + a). With Kd=0.5, score(0.25) ≈ 0.333
    const s = hillScore(0.25, 1, 0.5);
    assert.ok(Math.abs(s - 1 / 3) < 0.001, `Expected ~0.333, got ${s}`);
  });
});

// ---------------------------------------------------------------------------
// computeAffinity — weighted combination
// ---------------------------------------------------------------------------

describe("computeAffinity — affinity calculation", () => {
  it("full skill match gives high affinity", () => {
    const rule: RoutingRule = parseRoutingRules([
      { name: "r", match: { skills: ["a", "b", "c"] }, target: { peer: "P" } },
    ])[0];
    const peerSkills = new Map([["P", ["a", "b", "c"]]]);
    const a = computeAffinity(rule, { text: "" }, peerSkills);
    assert.ok(a > 0.3, `Expected > 0.3, got ${a}`);
  });

  it("partial skill match gives lower affinity than full match", () => {
    const rule: RoutingRule = parseRoutingRules([
      { name: "r", match: { skills: ["a", "b", "c"] }, target: { peer: "P" } },
    ])[0];
    const full = new Map([["P", ["a", "b", "c"]]]);
    const partial = new Map([["P", ["a"]]]);
    const aFull = computeAffinity(rule, { text: "" }, full);
    const aPartial = computeAffinity(rule, { text: "" }, partial);
    assert.ok(aFull > aPartial, `Full ${aFull} should be > partial ${aPartial}`);
  });

  it("pattern match contributes to affinity", () => {
    const rule: RoutingRule = parseRoutingRules([
      { name: "r", match: { pattern: "hello" }, target: { peer: "P" } },
    ])[0];
    const withMatch = computeAffinity(rule, { text: "hello world" });
    const noMatch = computeAffinity(rule, { text: "goodbye" });
    assert.ok(withMatch > noMatch, `Match ${withMatch} should be > no match ${noMatch}`);
  });

  it("tag match ratio is proportional", () => {
    const rule: RoutingRule = parseRoutingRules([
      { name: "r", match: { tags: ["a", "b", "c"] }, target: { peer: "P" } },
    ])[0];
    const a3 = computeAffinity(rule, { text: "", tags: ["a", "b", "c"] });
    const a1 = computeAffinity(rule, { text: "", tags: ["a"] });
    assert.ok(a3 > a1, `3-tag match ${a3} should be > 1-tag match ${a1}`);
  });

  it("custom weights override defaults", () => {
    const rule: RoutingRule = parseRoutingRules([
      { name: "r", match: { pattern: "test", skills: ["x"] }, target: { peer: "P" } },
    ])[0];
    const peerSkills = new Map([["P", ["x"]]]);
    // Skill weight = 1.0, everything else = 0 → affinity = skill_ratio
    const a = computeAffinity(rule, { text: "test" }, peerSkills, undefined, {
      skills: 1.0,
      tags: 0,
      pattern: 0,
      successRate: 0,
    });
    assert.ok(Math.abs(a - 1.0) < 0.01, `Expected ~1.0 with skill-only weights, got ${a}`);
  });
});

// ---------------------------------------------------------------------------
// matchAllRules — scored multi-match
// ---------------------------------------------------------------------------

describe("matchAllRules — scored routing", () => {
  const rules: RoutingRule[] = parseRoutingRules([
    { name: "specialist", match: { skills: ["deep-code"] }, target: { peer: "Expert" }, priority: 5 },
    { name: "generalist", match: { pattern: ".*" }, target: { peer: "General" }, priority: 10 },
  ]);

  it("returns scored results sorted by score descending", () => {
    const peerSkills = new Map([["Expert", ["deep-code", "review"]]]);
    const config: AffinityConfig = { hillCoefficient: 2, kd: 0.5 };
    const results = matchAllRules(rules, { text: "review code" }, peerSkills, undefined, config);
    assert.ok(results.length > 0, "Should have results");
    // All results should have score property
    for (const r of results) {
      assert.ok(typeof r.score === "number", `score should be number, got ${typeof r.score}`);
      assert.ok(r.score >= 0 && r.score <= 1, `score ${r.score} out of [0,1]`);
    }
    // Results sorted by score descending
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score,
        `Results not sorted: ${results[i - 1].score} < ${results[i].score}`);
    }
  });

  it("without AffinityConfig, falls back to priority-first (backward compat)", () => {
    const peerSkills = new Map([["Expert", ["deep-code"]]]);
    // No affinityConfig → should behave like current matchRule: priority order, first match
    const results = matchAllRules(rules, { text: "review code" }, peerSkills);
    assert.ok(results.length > 0);
    // "generalist" has higher priority (10 > 5), should be first
    assert.equal(results[0].peer, "General");
  });

  it("returns empty array when no rules match", () => {
    const noMatchRules = parseRoutingRules([
      { name: "nope", match: { pattern: "^impossible$" }, target: { peer: "Bot" } },
    ]);
    const results = matchAllRules(noMatchRules, { text: "hello" });
    assert.equal(results.length, 0);
  });
});

// ---------------------------------------------------------------------------
// matchRule backward compatibility with Hill scoring
// ---------------------------------------------------------------------------

describe("matchRule — backward compatibility with Hill scoring", () => {
  it("existing tests still pass: matchRule returns first priority match", () => {
    const rules: RoutingRule[] = parseRoutingRules([
      { name: "low", match: { pattern: "test" }, target: { peer: "LowBot" }, priority: 1 },
      { name: "high", match: { pattern: "test" }, target: { peer: "HighBot" }, priority: 100 },
    ]);
    const result = matchRule(rules, { text: "this is a test" });
    assert.deepEqual(result, { peer: "HighBot" });
  });

  it("matchRule still returns null when no match", () => {
    assert.equal(matchRule([], { text: "hello" }), null);
  });
});

// ---------------------------------------------------------------------------
// Performance: 1000 rules < 50ms
// ---------------------------------------------------------------------------

describe("matchAllRules — performance", () => {
  it("1000 rules scored in under 50ms", () => {
    const rawRules = Array.from({ length: 1000 }, (_, i) => ({
      name: `rule-${i}`,
      match: { pattern: `keyword${i % 10}`, skills: [`skill${i % 5}`] },
      target: { peer: `Peer-${i % 20}` },
      priority: i,
    }));
    const rules = parseRoutingRules(rawRules);
    const peerSkills = new Map(
      Array.from({ length: 20 }, (_, i) => [`Peer-${i}`, [`skill${i % 5}`, `skill${(i + 1) % 5}`]]),
    );
    const config: AffinityConfig = { hillCoefficient: 2, kd: 0.5 };

    const start = performance.now();
    matchAllRules(rules, { text: "keyword3 test" }, peerSkills, undefined, config);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 50, `Took ${elapsed.toFixed(1)}ms, expected < 50ms`);
  });
});
