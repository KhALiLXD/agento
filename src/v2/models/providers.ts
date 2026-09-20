import { z } from "zod";
import type { ProviderConfig, JsonSchema } from "../config/schema.js";
import type {
  ModelAdapter,
  ModelCapabilities,
  GenerationRequest,
  ToolSelectionRequest,
  Usage,
  ToolCall,
} from "./interface.js";
import { fail, AgentRuntimeError } from "../errors.js";
import { schemaValidator } from "../config/compiler.js";
import { digest } from "../config/paths.js";
import { redact } from "../security/redactor.js";
const object = z.record(z.unknown());
const roots = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  mistral: "https://api.mistral.ai/v1",
  cohere: "https://api.cohere.com/v2",
  ollama: "http://localhost:11434/api",
};
const defaults: Record<ProviderConfig["provider"], ModelCapabilities> = {
  openai: {
    nativeTools: true,
    structuredOutput: true,
    strictSchema: true,
    systemMessages: true,
    temperature: true,
  },
  anthropic: {
    nativeTools: true,
    structuredOutput: false,
    strictSchema: false,
    systemMessages: true,
    temperature: true,
  },
  mistral: {
    nativeTools: true,
    structuredOutput: true,
    strictSchema: false,
    systemMessages: true,
    temperature: true,
  },
  cohere: {
    nativeTools: true,
    structuredOutput: true,
    strictSchema: false,
    systemMessages: true,
    temperature: true,
  },
  ollama: {
    nativeTools: true,
    structuredOutput: true,
    strictSchema: false,
    systemMessages: true,
    temperature: true,
  },
};
function record(value: unknown): Record<string, unknown> {
  const r = object.safeParse(value);
  if (!r.success)
    return fail("MODEL_RESPONSE_MALFORMED", "Malformed model response.");
  return r.data;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
export function parseModelJson(value: string): unknown {
  // Whole fenced block is accepted; arbitrary prose/regex extraction is deliberately rejected.
  const source = value
    .trim()
    .replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  try {
    return JSON.parse(source);
  } catch {
    return fail("MODEL_RESPONSE_MALFORMED", "Model did not return valid JSON.");
  }
}
function strictSchema(schema: JsonSchema): JsonSchema {
  const s = structuredClone(schema);
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, JsonSchema>;
    for (const key of Object.keys(props)) {
      const p = strictSchema(props[key]);
      props[key] = { anyOf: [p, { type: "null" }] };
    }
    s.required = Object.keys(props);
    s.additionalProperties = false;
  }
  if (s.items && typeof s.items === "object")
    s.items = strictSchema(s.items as JsonSchema);
  return s;
}
/** Small protocol adapters using native fetch; no framework or provider SDK dependency. */
export class ProviderModel implements ModelAdapter {
  #toolCache = new Map<string, unknown>();
  #schemaCache = new Map<string, ReturnType<typeof schemaValidator>>();
  #config: ProviderConfig;
  #key: string;
  #fetch: typeof fetch;
  #caps: ModelCapabilities;
  constructor(
    config: ProviderConfig,
    options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.#config = config;
    this.#key = config.api_key
      ? ((options.env ?? process.env)[config.api_key.slice(5)] ?? "")
      : "";
    this.#fetch = options.fetch ?? fetch;
    if (config.provider !== "ollama" && !this.#key)
      fail(
        "CONFIG_SECRET_MISSING",
        "Provider API key environment variable is missing.",
      );
    this.#caps = { ...defaults[config.provider], ...config.capabilities };
    if (
      config.provider === "openai" &&
      /^(?:o[134]|gpt-5)/.test(config.model) &&
      config.capabilities?.temperature === undefined
    )
      this.#caps.temperature = false;
    const url = new URL(config.base_url ?? roots[config.provider]);
    if (
      url.username ||
      url.password ||
      !["https:", "http:"].includes(url.protocol) ||
      (this.#key && url.protocol !== "https:")
    )
      fail("CONFIG_AUTH_INVALID", "Unsafe provider URL.");
  }
  capabilities(): ModelCapabilities {
    return { ...this.#caps };
  }
  async #request(
    request: GenerationRequest,
    mode: "text" | "tools" | "structured",
    extra?: ToolSelectionRequest["tools"] | JsonSchema,
  ): Promise<Record<string, unknown>> {
    const p = this.#config.provider,
      tools =
        mode === "tools" ? (extra as ToolSelectionRequest["tools"]) : undefined;
    const schema = mode === "structured" ? (extra as JsonSchema) : undefined;
    const messages = this.#caps.systemMessages
      ? [{ role: "system", content: request.system }, ...request.messages]
      : [{ role: "user", content: request.system }, ...request.messages];
    const body: Record<string, unknown> = {
      model: this.#config.model,
      messages,
    };
    const temperature =
      request.temperature ??
      this.#config.temperature ??
      (mode === "text" ? 0.5 : 0);
    if (this.#caps.temperature) body.temperature = temperature;
    if (p === "anthropic") {
      if (this.#caps.systemMessages) body.system = request.system;
      body.messages = this.#caps.systemMessages ? request.messages : messages;
      body.max_tokens = 2048;
    }
    if (p === "ollama") {
      body.stream = false;
      body.options = this.#caps.temperature ? { temperature } : {};
      delete body.temperature;
    }
    if (tools) {
      body.tools = tools.map((t) => {
        const key = digest(t);
        const cached = this.#toolCache.get(key);
        if (cached) return cached;
        const value =
          p === "anthropic"
            ? {
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              }
            : {
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters:
                    this.#caps.strictSchema && p === "openai"
                      ? strictSchema(t.inputSchema)
                      : t.inputSchema,
                  ...(this.#caps.strictSchema && p === "openai"
                    ? { strict: true }
                    : {}),
                },
              };
        if (this.#toolCache.size >= 10000) this.#toolCache.clear();
        this.#toolCache.set(key, value);
        return value;
      });
      if (p === "anthropic")
        body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
      else if (p !== "ollama") {
        body.tool_choice = "auto";
        if (p === "openai" || p === "mistral") body.parallel_tool_calls = false;
      }
      if (p === "cohere" && this.#caps.strictSchema) body.strict_tools = true;
    }
    if (schema) {
      if (p === "ollama") body.format = schema;
      else if (p === "cohere")
        body.response_format = { type: "json_object", schema };
      else
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: "agento_result",
            schema,
            ...(p === "openai" ? { strict: false } : {}),
          },
        };
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (p === "anthropic") {
      headers["x-api-key"] = this.#key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (this.#key) headers.authorization = `Bearer ${this.#key}`;
    const endpoint =
      p === "anthropic"
        ? "/messages"
        : p === "cohere" || p === "ollama"
          ? "/chat"
          : "/chat/completions";
    const timeout = AbortSignal.timeout(this.#config.timeout_ms);
    const signal = request.signal
      ? AbortSignal.any([timeout, request.signal])
      : timeout;
    try {
      const res = await this.#fetch(
        (this.#config.base_url ?? roots[p]).replace(/\/$/, "") + endpoint,
        {
          method: "POST",
          headers,
          body: JSON.stringify(redact(body, [this.#key])),
          redirect: "error",
          signal,
        },
      );
      if (!res.ok) {
        await res.body?.cancel();
        return fail("MODEL_PROVIDER_ERROR", "Provider rejected the request.", {
          provider: p,
          status: res.status,
        });
      }
      // Stream reading is bounded so provider errors cannot exhaust runtime memory.
      const reader = res.body?.getReader();
      if (!reader)
        return fail("MODEL_RESPONSE_MALFORMED", "Empty provider response.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 2097152) {
          await reader.cancel();
          return fail(
            "MODEL_RESPONSE_MALFORMED",
            "Provider response exceeds configured transport limit.",
          );
        }
        chunks.push(item.value);
      }
      return record(parseModelJson(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      return fail(
        signal.aborted ? "MODEL_TIMEOUT" : "MODEL_PROVIDER_ERROR",
        signal.aborted
          ? "Model request was aborted or timed out."
          : "Model transport failed.",
        { provider: p },
      );
    }
  }
  #usage(data: Record<string, unknown>): Usage {
    const u =
      data.usage && typeof data.usage === "object"
        ? (data.usage as Record<string, unknown>)
        : {};
    const tokens =
      u.tokens && typeof u.tokens === "object"
        ? (u.tokens as Record<string, unknown>)
        : u;
    return {
      inputTokens: number(
        tokens.input_tokens ?? tokens.prompt_tokens ?? data.prompt_eval_count,
      ),
      outputTokens: number(
        tokens.output_tokens ?? tokens.completion_tokens ?? data.eval_count,
      ),
    };
  }
  #message(data: Record<string, unknown>): Record<string, unknown> {
    if (this.#config.provider === "anthropic") return data;
    if (
      this.#config.provider === "cohere" ||
      this.#config.provider === "ollama"
    )
      return record(data.message);
    const choice = record(array(data.choices)[0]);
    return record(choice.message);
  }
  #text(data: Record<string, unknown>): string {
    const message = this.#message(data),
      content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .filter(
          (x) =>
            x &&
            typeof x === "object" &&
            (x as Record<string, unknown>).type === "text",
        )
        .map((x) => String((x as Record<string, unknown>).text ?? ""))
        .join("");
    return fail(
      "MODEL_RESPONSE_MALFORMED",
      "Provider returned no text content.",
    );
  }
  async generateText(request: GenerationRequest) {
    const data = await this.#request(request, "text");
    return { text: this.#text(data), usage: this.#usage(data) };
  }
  async generateStructured(
    request: GenerationRequest & { schema: JsonSchema },
  ) {
    if (!this.#caps.structuredOutput)
      return fail(
        "MODEL_CAPABILITY_UNSUPPORTED",
        "Structured output is not available for this adapter.",
      );
    const data = await this.#request(request, "structured", request.schema),
      result = parseModelJson(this.#text(data));
    const key = digest(request.schema);
    let validate = this.#schemaCache.get(key);
    if (!validate) {
      validate = schemaValidator(request.schema);
      if (this.#schemaCache.size >= 128) this.#schemaCache.clear();
      this.#schemaCache.set(key, validate);
    }
    if (!validate(result))
      return fail(
        "MODEL_SCHEMA_VIOLATION",
        "Structured response violates the requested schema.",
      );
    return { data: result, usage: this.#usage(data) };
  }
  async selectTool(request: ToolSelectionRequest) {
    if (!this.#caps.nativeTools)
      return fail(
        "MODEL_CAPABILITY_UNSUPPORTED",
        "Native tools are not available for this adapter.",
      );
    const data = await this.#request(request, "tools", request.tools),
      message = this.#message(data);
    const calls =
      this.#config.provider === "anthropic"
        ? array(message.content).filter(
            (x) =>
              x &&
              typeof x === "object" &&
              (x as Record<string, unknown>).type === "tool_use",
          )
        : array(message.tool_calls);
    if (calls.length > 1)
      return fail(
        "MODEL_TOOL_SELECTION_FAILED",
        "Multiple tool calls are not supported in one routing step.",
      );
    if (
      !calls.length &&
      typeof message.content !== "string" &&
      !Array.isArray(message.content) &&
      typeof message.refusal !== "string"
    )
      fail(
        "MODEL_RESPONSE_MALFORMED",
        "Provider returned neither tool calls nor text.",
      );
    let call: ToolCall | null = null;
    if (calls.length) {
      const raw = record(calls[0]),
        fn = this.#config.provider === "anthropic" ? raw : record(raw.function);
      const args = fn.arguments ?? fn.input;
      if (typeof fn.name !== "string")
        return fail("MODEL_RESPONSE_MALFORMED", "Tool call has no name.");
      call = {
        name: fn.name,
        arguments: record(
          typeof args === "string" ? parseModelJson(args) : args,
        ),
      };
    }
    return { call, usage: this.#usage(data) };
  }
}
