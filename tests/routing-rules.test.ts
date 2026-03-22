import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRoutingRules, matchRule } from "../src/routing-rules.js";
import type { RoutingRule } from "../src/routing-rules.js";
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
