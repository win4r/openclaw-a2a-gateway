import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeAgentNameFromMetadata } from "../index.js";

describe("normalizeAgentNameFromMetadata", () => {
  it("maps JSON-RPC params.metadata.agentName to params.message.agentName", () => {
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: "1",
      method: "message/stream",
      params: {
        message: {
                    messageId: "msg-1",
          role: "ROLE_USER",
          parts: [{ text: "hi" }],
        },
        metadata: {
          agentName: "main",
        },
      },
    };

    normalizeAgentNameFromMetadata(body);

    const params = body.params as Record<string, unknown>;
    const message = params.message as Record<string, unknown>;
    assert.equal(message.agentName, "main");
  });

  it("does not override existing message.agentName", () => {
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: "1",
      method: "message/send",
      params: {
        message: {
                    messageId: "msg-1",
          role: "ROLE_USER",
          agentName: "coder",
          parts: [{ text: "hi" }],
        },
        metadata: {
          agentName: "main",
        },
      },
    };

    normalizeAgentNameFromMetadata(body);

    const params = body.params as Record<string, unknown>;
    const message = params.message as Record<string, unknown>;
    assert.equal(message.agentName, "coder");
  });

  it("copies JSON-RPC params.metadata.llm to params.message.metadata.llm", () => {
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: "1",
      method: "message/stream",
      params: {
        message: {
                    messageId: "msg-1",
          role: "ROLE_USER",
          parts: [{ text: "hi" }],
        },
        metadata: {
          llm: {
            foundationModels: {
              modelName: "openai/gpt-5.4",
            },
          },
        },
      },
    };

    normalizeAgentNameFromMetadata(body);

    const params = body.params as Record<string, unknown>;
    const message = params.message as Record<string, unknown>;
    const messageMetadata = message.metadata as Record<string, unknown>;
    const llm = messageMetadata.llm as Record<string, unknown>;
    const foundationModels = llm.foundationModels as Record<string, unknown>;
    assert.equal(foundationModels.modelName, "openai/gpt-5.4");
  });
});
