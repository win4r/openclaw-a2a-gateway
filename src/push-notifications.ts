/**
 * Push Notification support for A2A long-running tasks.
 *
 * When a task reaches a terminal state (completed/failed/canceled),
 * the gateway can POST the result to a pre-registered webhook URL
 * instead of requiring the client to poll tasks/get.
 *
 * This is an in-memory store — registrations do not survive restarts.
 */

export interface PushNotificationConfig {
  /** Webhook URL to POST results to. */
  url: string;
  /** Optional auth token for the webhook (sent as Bearer). */
  token?: string;
  /** Optional event filter: ["completed", "failed", "canceled"]. Default: all terminal states. */
  events?: string[];
}

export interface PushNotificationResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

const TERMINAL_EVENTS = ["completed", "failed", "canceled"];
const PUSH_TIMEOUT_MS = 10_000;

/**
 * In-memory store mapping taskId to webhook config.
 * Fire-and-forget delivery — task completion is never blocked by webhook.
 */
export class PushNotificationStore {
  private readonly registrations = new Map<string, PushNotificationConfig>();

  register(taskId: string, config: PushNotificationConfig): void {
    this.registrations.set(taskId, { ...config });
  }

  unregister(taskId: string): void {
    this.registrations.delete(taskId);
  }

  get(taskId: string): PushNotificationConfig | undefined {
    return this.registrations.get(taskId);
  }

  has(taskId: string): boolean {
    return this.registrations.has(taskId);
  }

  /** Number of active registrations (for diagnostics). */
  get size(): number {
    return this.registrations.size;
  }

  /**
   * Send a push notification for a completed task.
   *
   * Returns immediately if no registration exists or the event is filtered out.
   * Uses a 10s timeout — never blocks task completion.
   */
  async send(
    taskId: string,
    state: string,
    task: object,
  ): Promise<PushNotificationResult> {
    const config = this.registrations.get(taskId);
    if (!config) {
      return { ok: false, error: "no registration" };
    }

    // Check event filter
    const allowedEvents = config.events && config.events.length > 0
      ? config.events
      : TERMINAL_EVENTS;
    if (!allowedEvents.includes(state)) {
      return { ok: false, error: `event "${state}" filtered out` };
    }

    const body = JSON.stringify({ taskId, state, task });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.token) {
      headers["Authorization"] = `Bearer ${config.token}`;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

      const response = await fetch(config.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Auto-cleanup after successful delivery
      this.registrations.delete(taskId);

      return {
        ok: response.ok,
        statusCode: response.status,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }
}
