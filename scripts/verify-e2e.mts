import express from "express";
import { TaskState, Role } from "@a2a-js/sdk";
import type { AgentExecutionEvent, AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { readFileSync } from "node:fs";
import { A2AClient } from "../src/client.js";

const PORT = 18999;
const base = `http://127.0.0.1:${PORT}`;

function makeCardV1() {
  return {
    name: "Verify Echo", description: "local verification", version: "1.0.0",
    supportedInterfaces: [
      { url: `${base}/`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
      { url: `${base}/`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "0.3" },
    ],
    capabilities: {}, securitySchemes: {}, securityRequirements: [],
    defaultInputModes: [], defaultOutputModes: [], skills: [], signatures: [],
  };
}
const cardV03 = { protocolVersion: "0.3.0", name: "Verify Echo", url: `${base}/`, skills: [] };

function extractText(ctx: any): string {
  for (const p of ctx.userMessage?.parts ?? []) {
    if (p?.content?.$case === "text") return String(p.content.value);
    if (typeof p?.text === "string") return p.text;
  }
  return "";
}

const executor: AgentExecutor = {
  async execute(ctx: RequestContext, bus: ExecutionEventBus) {
    const task = {
      id: ctx.taskId, contextId: ctx.contextId,
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        timestamp: new Date().toISOString(),
        message: {
          messageId: `m-${ctx.taskId}`, contextId: ctx.contextId, taskId: ctx.taskId,
          role: Role.ROLE_AGENT,
          parts: [{ content: { $case: "text", value: `pong:${extractText(ctx)}` }, metadata: undefined, filename: "", mediaType: "text/plain" }],
          metadata: undefined, extensions: [], referenceTaskIds: [],
        },
      },
      artifacts: [], history: [], metadata: undefined,
    } as never;
    bus.publish({ kind: "task", data: task } as unknown as AgentExecutionEvent);
    bus.finished();
  },
  async cancelTask(_id: string, _bus: ExecutionEventBus) {},
};

const handler = new DefaultRequestHandler(makeCardV1() as never, new InMemoryTaskStore(), executor);
const app = express();
app.use(express.json());
app.get("/card-v1", (_q, r) => r.json(makeCardV1()));
app.get("/card-v03", (_q, r) => r.json(cardV03));
app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication, legacyCompat: { enabled: true } }));
app.listen(PORT, "127.0.0.1");
await new Promise((r) => setTimeout(r, 400));

const client = new A2AClient();
let failures = 0;
async function check(name: string, peer: any) {
  try {
    const res: any = await client.sendMessage(peer, { text: "ping" }, {});
    const ok = !!res.ok;
    console.log(`${name}: ${ok ? "PASS" : "FAIL"}${ok ? "" : " " + JSON.stringify(res.response ?? {}).slice(0, 220)}`);
    if (!ok) failures++;
  } catch (e: any) {
    console.log(`${name}: THREW ${e.message}`);
    failures++;
  }
}

await check("A.v1-outbound-vs-real-sdk-server", { name: "v1-peer", agentCardUrl: `${base}/card-v1` });
await check("B.legacy-v03-outbound-vs-real-sdk-server", { name: "v03-peer", agentCardUrl: `${base}/card-v03` });

const peers = JSON.parse(readFileSync("/home/praxis/.openclaw/a2a-peers.json", "utf8"));
const praxTok = peers.prax?.token ?? "";
if (!praxTok) {
  console.log("C.prax-live: SKIP (no token)");
} else {
  const res: any = await Promise.race([
    client.sendMessage(
      { name: "praxai", agentCardUrl: "http://192.168.4.209:18800/.well-known/agent-card.json", auth: { type: "bearer", token: praxTok } } as never,
      { text: "connectivity probe from Axiom migration verification (fix/95-sdk1-dual-stack)" },
      {},
    ),
    new Promise((r) => setTimeout(() => r({ ok: null }), 90_000)),
  ]);
  console.log(`C.prax-live-real-v03-server: ${res.ok === null ? "PENDING>90s" : res.ok ? "PASS" : "FAIL"}${res.ok === false ? " " + JSON.stringify(res.response ?? {}).slice(0, 220) : ""}`);
  if (res.ok === false) failures++;
}
process.exit(failures ? 1 : 0);
