import type { SessionTokenStore, StoredSessionToken } from "./types.js";

/** Process-local, bounded storage. Use a shared TTL store for multi-worker deployments. */
export class MemorySessionTokenStore implements SessionTokenStore {
  #tokens = new Map<string, StoredSessionToken>();
  #timer: ReturnType<typeof setInterval>;

  constructor(private readonly maxEntries = 10_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive safe integer");
    }
    this.#timer = setInterval(() => this.prune(), 60_000);
    this.#timer.unref();
  }

  get(sessionId: string): StoredSessionToken | undefined {
    const token = this.#tokens.get(sessionId);
    if (token && token.expiresAt <= Date.now()) {
      this.#tokens.delete(sessionId);
      return undefined;
    }
    return token ? { ...token } : undefined;
  }

  set(sessionId: string, token: StoredSessionToken): void {
    if (!this.#tokens.has(sessionId) && this.#tokens.size >= this.maxEntries) {
      this.prune();
      if (this.#tokens.size >= this.maxEntries) {
        throw new Error("Session token store capacity exceeded");
      }
    }
    this.#tokens.set(sessionId, { ...token });
  }

  delete(sessionId: string): void {
    this.#tokens.delete(sessionId);
  }

  private prune(): void {
    const now = Date.now();
    for (const [sessionId, token] of this.#tokens) {
      if (token.expiresAt <= now) this.#tokens.delete(sessionId);
    }
  }

  dispose(): void {
    clearInterval(this.#timer);
    this.#tokens.clear();
  }
}
