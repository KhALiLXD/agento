export interface StoredSessionToken {
  /** AES-256-GCM ciphertext. Stores never receive the plaintext token. */
  value: string;
  expiresAt: number;
}

/** Implementations must isolate session keys and honor expiresAt as an absolute TTL. */
export interface SessionTokenStore {
  get(
    sessionId: string,
  ): StoredSessionToken | undefined | Promise<StoredSessionToken | undefined>;
  set(sessionId: string, token: StoredSessionToken): void | Promise<void>;
  delete(sessionId: string): void | Promise<void>;
}

export interface AuthenticationOptions {
  store?: SessionTokenStore;
  /** Required with a custom store. Supply 32 secret random bytes, shared by its workers. */
  encryptionKey?: Uint8Array;
}
