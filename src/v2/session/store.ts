import type { ModelMessage } from "../models/interface.js";
import type { PreparedRequest } from "../execution/mapper.js";
import type { ValueSource } from "../config/schema.js";
import type { RuntimeState } from "../runtime/state.js";
import { fail } from "../errors.js";
export interface RuntimeFact {
  key: string;
  value: unknown;
  source: "user" | "tool" | "session" | "generated" | "constant";
  sourceToolId?: string;
  createdAt: number;
  expiresAt?: number;
}
export interface Frame {
  tool: string;
  arguments: Record<string, unknown>;
  dependencies: Record<
    string,
    { data: unknown; expiresAt: number; hash: string }
  >;
}
export interface SelectionState {
  contextHash: string;
  token: string;
  items: unknown[];
  options: Array<{ id: string; label: string }>;
  expiresAt: number;
  dependency?: string;
  navigation?: {
    tool: string;
    arguments: Record<string, ValueSource>;
    map: Record<string, string>;
    sourceArguments: Record<string, unknown>;
  };
}
export interface ConfirmationState {
  token: string;
  hash: string;
  prepared: PreparedRequest;
  expiresAt: number;
  preview?: Record<string, unknown>;
}
export interface SessionStateV2 {
  id: string;
  expiresAt: number;
  messageCount: number;
  state: RuntimeState;
  history: ModelMessage[];
  facts: Record<string, RuntimeFact>;
  stack: Frame[];
  selection?: SelectionState;
  confirmation?: ConfirmationState;
  context: Record<string, unknown>;
  configHash: string;
  lastUserMessage?: string;
}
/** transact MUST serialize the entire async operation across all runtime instances sharing this store.
 * A Redis/DB implementation needs a renewable distributed lock/fencing, not just get+set. */
export interface SessionStore {
  get(id: string): Promise<SessionStateV2 | null>;
  set(id: string, state: SessionStateV2): Promise<void>;
  delete(id: string): Promise<void>;
  touch(id: string, expiresAt: number): Promise<void>;
  transact<T>(id: string, operation: () => Promise<T>): Promise<T>;
}
export class MemorySessionStore implements SessionStore {
  #sessions = new Map<string, SessionStateV2>();
  #queues = new Map<string, Promise<void>>();
  constructor(private maxSessions = 10000) {}
  async get(id: string) {
    const s = this.#sessions.get(id);
    return s ? structuredClone(s) : null;
  }
  async set(id: string, state: SessionStateV2) {
    for (const [key, s] of this.#sessions)
      if (s.expiresAt <= Date.now() && !this.#queues.has(key))
        this.#sessions.delete(key);
    if (!this.#sessions.has(id) && this.#sessions.size >= this.maxSessions)
      fail("SESSION_CAPACITY", "Session store capacity reached.");
    this.#sessions.set(id, structuredClone(state));
  }
  async delete(id: string) {
    this.#sessions.delete(id);
  }
  async touch(id: string, expiresAt: number) {
    const s = this.#sessions.get(id);
    if (s) s.expiresAt = expiresAt;
  }
  async transact<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    let unlock!: () => void;
    const pending = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.then(() => pending);
    this.#queues.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (this.#queues.get(id) === tail) this.#queues.delete(id);
    }
  }
}
