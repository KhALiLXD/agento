import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { AgentRuntimeError, fail } from "../v2/errors.js";
import { MemorySessionTokenStore } from "./store.js";
import type {
  AuthenticationOptions,
  SessionTokenStore,
  StoredSessionToken,
} from "./types.js";

interface Credential {
  token: string;
}

function normalizeToken(value: unknown): string {
  if (typeof value !== "string" || value.length > 16_384) {
    fail("AUTH_TOKEN_INVALID", "The opaque access token is invalid.");
  }
  const token = value.replace(/^Bearer +/i, "");
  if (!token || /[^\x21-\x7e]/.test(token)) {
    fail("AUTH_TOKEN_INVALID", "The opaque access token is invalid.");
  }
  return token;
}

export class SessionCredentials {
  #key: Buffer;
  #store: SessionTokenStore;
  #ownsStore: boolean;
  #invalidations = new Map<
    string,
    { until: number; expectedDigest?: string }
  >();
  #lastInvalidationCleanup = 0;

  constructor(
    options: AuthenticationOptions,
    private readonly sessionTimeoutMs: number,
  ) {
    if (!Number.isFinite(sessionTimeoutMs) || sessionTimeoutMs <= 0) {
      throw new AgentRuntimeError(
        "CONFIG_INVALID",
        "Session timeout must be positive.",
      );
    }
    if (options.store && !options.encryptionKey) {
      throw new AgentRuntimeError(
        "CONFIG_AUTH_INVALID",
        "A custom token store requires a 32-byte encryptionKey.",
      );
    }
    if (
      options.encryptionKey &&
      (!(options.encryptionKey instanceof Uint8Array) ||
        options.encryptionKey.byteLength !== 32)
    ) {
      throw new AgentRuntimeError(
        "CONFIG_AUTH_INVALID",
        "Authentication encryptionKey must contain 32 bytes.",
      );
    }
    this.#key = options.encryptionKey
      ? Buffer.from(options.encryptionKey)
      : randomBytes(32);
    this.#store = options.store ?? new MemorySessionTokenStore();
    this.#ownsStore = !options.store;
  }

  /** Retain or reuse opaque transport data. Never decode claims or make API login decisions. */
  async resolve(
    sessionId: string,
    suppliedToken?: unknown,
    sessionExpiresAt?: number,
  ): Promise<string | undefined> {
    try {
      const credential =
        suppliedToken === undefined
          ? await this.read(sessionId)
          : { token: normalizeToken(suppliedToken) };
      if (!credential) return undefined;
      await this.save(sessionId, credential, sessionExpiresAt);
      return credential.token;
    } catch (error) {
      // A failed refresh must never fall back to an older credential.
      await this.clear(sessionId);
      throw error;
    }
  }

  private async save(
    sessionId: string,
    credential: Credential,
    sessionExpiresAt?: number,
  ): Promise<void> {
    const now = Date.now();
    const expiresAt = Math.min(
      now + this.sessionTimeoutMs,
      sessionExpiresAt ?? Infinity,
    );
    if (expiresAt <= now) {
      fail("SESSION_EXPIRED", "The credential session has expired.");
    }
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
      cipher.setAAD(Buffer.from(JSON.stringify([sessionId, expiresAt])));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(credential), "utf8"),
        cipher.final(),
      ]);
      const value = [iv, cipher.getAuthTag(), ciphertext]
        .map((part) => part.toString("base64url"))
        .join(".");
      await this.#store.set(sessionId, { value, expiresAt });
      const invalidation = this.#invalidations.get(sessionId);
      if (invalidation) {
        // Keep a fence against late writes even after fresh credentials have been accepted.
        invalidation.expectedDigest = createHash("sha256")
          .update(value)
          .digest("base64url");
      }
    } catch {
      if (!this.#ownsStore) {
        // A remote write may still commit after its promise rejects on a timeout.
        this.#invalidations.set(sessionId, {
          until: Date.now() + this.sessionTimeoutMs,
        });
      }
      fail("AUTH_STORAGE_ERROR", "Opaque credential storage is unavailable.");
    }
  }

  private async read(sessionId: string): Promise<Credential | undefined> {
    let invalidation = this.#invalidations.get(sessionId);
    if (invalidation) {
      if (invalidation.until <= Date.now()) {
        this.#invalidations.delete(sessionId);
        invalidation = undefined;
      } else if (!invalidation.expectedDigest) {
        return undefined;
      }
    }
    try {
      const stored: StoredSessionToken | undefined =
        await this.#store.get(sessionId);
      if (!stored) return undefined;
      if (
        invalidation?.expectedDigest &&
        createHash("sha256").update(stored.value).digest("base64url") !==
          invalidation.expectedDigest
      ) {
        throw new Error("Credential write fence mismatch");
      }
      if (!Number.isFinite(stored.expiresAt))
        throw new Error("Invalid credential expiry");
      if (stored.expiresAt <= Date.now()) {
        await this.#store.delete(sessionId);
        return undefined;
      }
      const parts = stored.value.split(".");
      if (parts.length !== 3) throw new Error("Invalid credential envelope");
      const [iv, tag, ciphertext] = parts.map((part) =>
        Buffer.from(part, "base64url"),
      );
      if (iv.length !== 12 || tag.length !== 16)
        throw new Error("Invalid credential envelope");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(
        Buffer.from(JSON.stringify([sessionId, stored.expiresAt])),
      );
      decipher.setAuthTag(tag);
      const credential = JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
          "utf8",
        ),
      ) as Credential;
      return { token: normalizeToken(credential.token) };
    } catch {
      fail("AUTH_STORAGE_ERROR", "Opaque credential storage is unavailable.");
    }
  }

  async clear(sessionId: string): Promise<void> {
    const now = Date.now();
    if (now - this.#lastInvalidationCleanup >= 60_000) {
      for (const [id, invalidation] of this.#invalidations) {
        if (invalidation.until <= now) this.#invalidations.delete(id);
      }
      this.#lastInvalidationCleanup = now;
    }
    // Failed remote deletion must not resurrect a credential in this handler.
    const preserveFence =
      (this.#invalidations.get(sessionId)?.until ?? 0) > now;
    this.#invalidations.set(sessionId, { until: now + this.sessionTimeoutMs });
    try {
      await this.#store.delete(sessionId);
      if (!preserveFence) this.#invalidations.delete(sessionId);
    } catch {
      fail("AUTH_STORAGE_ERROR", "Opaque credential storage is unavailable.");
    }
  }

  dispose(): void {
    if (this.#ownsStore) (this.#store as MemorySessionTokenStore).dispose();
    this.#key.fill(0);
    this.#invalidations.clear();
  }
}
