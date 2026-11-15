import assert from "node:assert/strict";
import { test } from "node:test";

import { GatewayRpcConnection } from "../src/executor.ts";

function makeConnection(): GatewayRpcConnection {
  return new GatewayRpcConnection({
    port: 18789,
    wsUrl: "ws://127.0.0.1:18789/ws",
    hooksWakeUrl: "http://127.0.0.1:18789/hooks/wake",
    gatewayToken: "",
    gatewayPassword: "",
    hooksToken: "",
  });
}

test("event=agent with final payload resolves pending expectFinal agent request", async () => {
  const conn = makeConnection() as unknown as {
    pending: Map<string, unknown>;
    handleMessage(event: { data: unknown }): void;
  };

  let resolved: unknown;
  const timer = setTimeout(() => {}, 10_000);
  conn.pending.set("pending-agent", {
    method: "agent",
    expectFinal: true,
    timer,
    resolve: (value: unknown) => { resolved = value; },
    reject: (error: Error) => { throw error; },
  });

  const finalPayload = {
    status: "ok",
    result: {
      payloads: [
        { type: "message", role: "assistant", content: [{ type: "text", text: "A2A_V260_READINESS_OK" }] },
      ],
    },
  };

  conn.handleMessage({
    data: JSON.stringify({ type: "event", event: "agent", payload: finalPayload }),
  });

  clearTimeout(timer);
  assert.equal(conn.pending.size, 0);
  assert.deepEqual(resolved, finalPayload);
});

test("event=agent without content does not resolve pending expectFinal agent request", () => {
  const conn = makeConnection() as unknown as {
    pending: Map<string, unknown>;
    handleMessage(event: { data: unknown }): void;
  };

  let resolved = false;
  const timer = setTimeout(() => {}, 10_000);
  conn.pending.set("pending-agent", {
    method: "agent",
    expectFinal: true,
    timer,
    resolve: () => { resolved = true; },
    reject: (error: Error) => { throw error; },
  });

  conn.handleMessage({
    data: JSON.stringify({ type: "event", event: "agent", payload: { status: "working" } }),
  });

  clearTimeout(timer);
  assert.equal(conn.pending.size, 1);
  assert.equal(resolved, false);
});
