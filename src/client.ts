import { v4 as uuidv4 } from "uuid";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
  type AuthenticationHandler,
  type HttpHeaders,
} from "@a2a-js/sdk/client";
import { GrpcTransportFactory } from "@a2a-js/sdk/client/grpc";
import type { MessageSendParams, Message } from "@a2a-js/sdk";

import type { OutboundSendResult, PeerConfig } from "./types.js";

/**
 * Build an AuthenticationHandler for bearer or apiKey auth.
 */
function createAuthHandler(peer: PeerConfig): AuthenticationHandler | undefined {
  const auth = peer.auth;
  if (!auth?.token) return undefined;

  const headerKey = auth.type === "bearer" ? "authorization" : "x-api-key";
  const headerValue = auth.type === "bearer" ? `Bearer ${auth.token}` : auth.token;

  return {
    headers: async (): Promise<HttpHeaders> => ({
      [headerKey]: headerValue,
    }),
    shouldRetryWithHeaders: async () => undefined,
  };
}

/**
 * Parse agentCardUrl into base URL and path.
 */
function parseAgentCardUrl(agentCardUrl: string): { baseUrl: string; path: string } {
  const parsed = new URL(agentCardUrl);
  return {
    baseUrl: parsed.origin,
    path: parsed.pathname,
  };
}

export class A2AClient {
  /**
   * Create a ClientFactory with auth-aware fetch for a given peer.
   */
  private buildFactory(peer: PeerConfig): { factory: ClientFactory; path: string } {
    const { baseUrl: _baseUrl, path } = parseAgentCardUrl(peer.agentCardUrl);
    const authHandler = createAuthHandler(peer);

    // Wrap global fetch with auth headers if configured
    const authFetch = authHandler
      ? createAuthenticatingFetchWithRetry(fetch, authHandler)
      : fetch;

    // Inject auth fetch into card resolver and all transports
    const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: authFetch }),
        new RestTransportFactory({ fetchImpl: authFetch }),
        new GrpcTransportFactory(),
      ],
    });

    return { factory: new ClientFactory(options), path };
  }

  /**
   * Discover a peer's Agent Card using the SDK resolver.
   */
  async discoverAgentCard(peer: PeerConfig): Promise<Record<string, unknown>> {
    const { baseUrl, path } = parseAgentCardUrl(peer.agentCardUrl);
    const { factory } = this.buildFactory(peer);

    // createFromUrl resolves the card internally
    await factory.createFromUrl(baseUrl, path);

    // Re-fetch the card for the return value (lightweight)
    const authHandler = createAuthHandler(peer);
    const headers: Record<string, string> = authHandler
      ? (await authHandler.headers()) as Record<string, string>
      : {};

    const response = await fetch(`${baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Agent Card lookup failed with status ${response.status}`);
    }

    return response.json();
  }

  /**
   * Send a message to a peer agent using the A2A SDK Client.
   *
   * Uses ClientFactory → createFromUrl → client.sendMessage(),
   * following the official @a2a-js/sdk best practice.
   */
  async sendMessage(peer: PeerConfig, message: Record<string, unknown>): Promise<OutboundSendResult> {
    const { baseUrl } = parseAgentCardUrl(peer.agentCardUrl);
    const { factory, path } = this.buildFactory(peer);

    try {
      const client = await factory.createFromUrl(baseUrl, path);

      const targetAgentId = typeof (message as any)?.agentId === "string" ? String((message as any).agentId) : "";

      const outboundMessage: any = {
        kind: "message",
        messageId: (message.messageId as string) || uuidv4(),
        role: (message.role as Message["role"]) || "user",
        parts: (message.parts as Message["parts"]) || [
          { kind: "text", text: String(message.text || message.message || "") },
        ],
      };

      // OpenClaw extension: allow per-message routing to a specific agentId on the peer.
      // Note: gRPC transport uses protobuf Message and may drop unknown fields.
      if (targetAgentId) {
        outboundMessage.agentId = targetAgentId;
      }

      const sendParams: MessageSendParams = {
        message: outboundMessage,
      };

      const serviceParameters: Record<string, string> = {};
      if (peer.auth?.token) {
        if (peer.auth.type === "bearer") {
          serviceParameters.authorization = `Bearer ${peer.auth.token}`;
        } else {
          serviceParameters["x-api-key"] = peer.auth.token;
        }
      }

      const result = await client.sendMessage(sendParams, {
        serviceParameters: Object.keys(serviceParameters).length ? serviceParameters : undefined,
      });

      return {
        ok: true,
        statusCode: 200,
        response: result as unknown as Record<string, unknown>,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        statusCode: 500,
        response: { error: errorMessage },
      };
    }
  }
}
