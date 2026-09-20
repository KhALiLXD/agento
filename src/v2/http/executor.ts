import { setTimeout as delay } from "node:timers/promises";
import type { ToolConfig } from "../config/schema.js";
import type { PreparedRequest } from "../execution/mapper.js";
import { AgentRuntimeError, fail } from "../errors.js";
interface Circuit {
  failures: number;
  openUntil: number;
  probe: boolean;
}
export interface ExecutionContext {
  token?: string;
  signal?: AbortSignal;
  beforeAttempt: () => Promise<void>;
  onRetry: (attempt: number) => void;
  onLatency: (ms: number) => void;
}
export class HttpExecutor {
  #circuits = new Map<string, Circuit>();
  #fetch: typeof fetch;
  #keys: Readonly<Record<string, string>>;
  constructor(
    options: {
      fetch?: typeof fetch;
      keys?: Readonly<Record<string, string>>;
    } = {},
  ) {
    this.#fetch = options.fetch ?? fetch;
    this.#keys = options.keys ?? {};
  }
  diagnostics() {
    return Object.fromEntries(
      [...this.#circuits].map(([id, c]) => [
        id,
        {
          failures: c.failures,
          state:
            c.openUntil > Date.now()
              ? "open"
              : c.probe
                ? "half-open"
                : "closed",
        },
      ]),
    );
  }
  async execute(
    tool: ToolConfig,
    prepared: PreparedRequest,
    context: ExecutionContext,
  ): Promise<unknown> {
    const circuit = this.#circuits.get(tool.id) ?? {
      failures: 0,
      openUntil: 0,
      probe: false,
    };
    this.#circuits.set(tool.id, circuit);
    if (circuit.openUntil > Date.now() || circuit.probe)
      fail("TOOL_CIRCUIT_OPEN", "Upstream circuit is open.", { tool: tool.id });
    if (circuit.openUntil) circuit.probe = true;
    const safe =
      tool.behavior.effect === "read-only" ||
      tool.request.retry.idempotent ||
      !!tool.request.idempotency;
    const attempts = safe ? tool.request.retry.attempts : 1;
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (context.signal?.aborted)
          fail("TOOL_ABORTED", "Tool request was cancelled.");
        const headers = { ...prepared.headers };
        if (tool.request.auth.type === "session") {
          // Credentials are intentionally opaque in v2. Forward the token
          // when the host supplied one and let the downstream API decide
          // whether it is valid, expired or authorized for this operation.
          if (context.token) headers.authorization = `Bearer ${context.token}`;
        }
        if (tool.request.auth.type === "api-key") {
          const key = this.#keys[tool.request.auth.env];
          if (!key) fail("AUTH_REQUIRED", "API credential is unavailable.");
          headers[tool.request.auth.header] = key;
        }
        const url = new URL(prepared.url);
        if (
          url.username ||
          url.password ||
          url.origin !== new URL(tool.request.url).origin
        )
          fail("TOOL_URL_UNSAFE", "Unsafe request origin.");
        if (
          tool.request.auth.type !== "none" &&
          url.protocol !== "https:" &&
          !tool.request.allow_insecure_http
        )
          fail("AUTH_HTTPS_REQUIRED", "Credential transport requires HTTPS.");
        if (prepared.body) headers["content-type"] = "application/json";
        await context.beforeAttempt();
        const start = Date.now();
        const timeout = AbortSignal.timeout(tool.request.timeout_ms),
          signal = context.signal
            ? AbortSignal.any([timeout, context.signal])
            : timeout;
        try {
          const res = await this.#fetch(prepared.url, {
            method: prepared.method,
            headers,
            body: prepared.body,
            redirect: "manual",
            signal,
          });
          if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel();
            fail("TOOL_REDIRECT_BLOCKED", "Tool redirects are disabled.");
          }
          if (!res.ok) {
            await res.body?.cancel();
            fail(
              res.status === 401 || res.status === 403
                ? "AUTH_REJECTED"
                : res.status === 429
                  ? "TOOL_RATE_LIMITED"
                  : res.status >= 500
                    ? "TOOL_SERVER_ERROR"
                    : "TOOL_CLIENT_ERROR",
              "Upstream API rejected the request.",
              { status: res.status },
            );
          }
          let result: unknown = null;
          if (
            res.status !== 204 &&
            res.status !== 205 &&
            tool.request.method !== "HEAD"
          ) {
            const reader = res.body?.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            if (reader)
              while (true) {
                const item = await reader.read();
                if (item.done) break;
                size += item.value.length;
                if (size > tool.request.max_response_bytes) {
                  await reader.cancel();
                  fail(
                    "TOOL_OUTPUT_LIMIT",
                    "API response exceeds the byte limit.",
                  );
                }
                chunks.push(item.value);
              }
            const text = Buffer.concat(chunks).toString("utf8");
            const contentType =
              res.headers.get("content-type")?.split(";")[0].trim() ?? "";
            if (
              contentType === "application/json" ||
              contentType.endsWith("+json")
            ) {
              try {
                result = JSON.parse(text);
              } catch {
                fail("TOOL_RESPONSE_MALFORMED", "API returned malformed JSON.");
              }
            } else result = text;
          } else await res.body?.cancel();
          circuit.failures = 0;
          circuit.openUntil = 0;
          return result;
        } catch (raw) {
          const error =
            raw instanceof AgentRuntimeError
              ? raw
              : new AgentRuntimeError(
                  context.signal?.aborted
                    ? "TOOL_ABORTED"
                    : timeout.aborted
                      ? "TOOL_TIMEOUT"
                      : "TOOL_NETWORK_ERROR",
                  "API transport failed.",
                );
          const transient = [
            "TOOL_SERVER_ERROR",
            "TOOL_RATE_LIMITED",
            "TOOL_TIMEOUT",
            "TOOL_NETWORK_ERROR",
          ].includes(error.code);
          if (transient) {
            circuit.failures++;
            if (circuit.failures >= tool.request.circuit_breaker.threshold)
              circuit.openUntil =
                Date.now() + tool.request.circuit_breaker.reset_ms;
          }
          if (
            !transient ||
            attempt + 1 >= attempts ||
            circuit.openUntil > Date.now()
          )
            throw error;
          context.onRetry(attempt + 1);
          const wait =
            Math.min(
              60000,
              tool.request.retry.backoff_ms *
                tool.request.retry.multiplier ** attempt,
            ) * (tool.request.retry.jitter ? 0.5 + Math.random() * 0.5 : 1);
          try {
            await delay(wait, undefined, { signal: context.signal });
          } catch {
            fail("TOOL_ABORTED", "Tool retry cancelled.");
          }
        } finally {
          context.onLatency(Date.now() - start);
        }
      }
      return fail("TOOL_EXECUTION_FAILED", "No HTTP execution result.");
    } finally {
      circuit.probe = false;
    }
  }
}
