import { fail } from "../errors.js";
export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<void>;
}
export class MemoryRateLimiter implements RateLimiter {
  #windows = new Map<string, { count: number; until: number }>();
  constructor(private maxKeys = 50000) {}
  async consume(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    let entry = this.#windows.get(key);
    if (!entry || entry.until <= now) {
      if (this.#windows.size >= this.maxKeys) {
        for (const [k, v] of this.#windows)
          if (v.until <= now) this.#windows.delete(k);
        if (this.#windows.size >= this.maxKeys)
          fail("RATE_LIMIT_CAPACITY", "Rate limiter capacity reached.");
      }
      entry = { count: 0, until: now + windowMs };
      this.#windows.set(key, entry);
    }
    if (entry.count >= limit)
      fail("RATE_LIMITED", "Rate limit exceeded.", {
        retryAfterMs: entry.until - now,
      });
    entry.count++;
  }
}
export interface RuntimeEvent {
  name: string;
  requestId: string;
  sessionId: string;
  at: number;
  details: Readonly<Record<string, unknown>>;
}
export type RuntimeHook = (event: RuntimeEvent) => void;
export interface RuntimeMetrics {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  retryCount: number;
  dependencySteps: number;
  routingMs: number;
  httpMs: number;
}
