import { z } from "zod";
export type JsonSchema = Record<string, unknown>;
const positive = z.number().int().positive();
const nonnegative = z.number().int().nonnegative();
export const pathSchema = z
  .string()
  .regex(/^\$(?:\.[A-Za-z0-9_-]+)*$/)
  .refine(
    (p) =>
      !p
        .split(".")
        .some((x) => ["__proto__", "constructor", "prototype"].includes(x)),
    "Unsafe property path",
  );
const name = z
  .string()
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/)
  .refine((n) => !["__proto__", "constructor", "prototype"].includes(n));
const jsonSchema = z
  .record(z.unknown())
  .refine((s) => Object.keys(s).length > 0, "JSON schema is required");
const source = z.union([
  pathSchema,
  z.object({ source: z.literal("tool-input"), path: pathSchema }).strict(),
  z.object({ source: z.literal("session"), path: pathSchema }).strict(),
  z
    .object({ source: z.literal("dependency"), tool: name, path: pathSchema })
    .strict(),
  z
    .object({ source: z.literal("constant"), value: z.unknown() })
    .strict()
    .refine((s) => Object.hasOwn(s, "value"), "Constant value is required"),
  z
    .object({ source: z.literal("generated"), generator: z.literal("uuid") })
    .strict(),
]);
const mapping = z.record(name, source);
const selection = z
  .object({
    items_path: pathSchema,
    id_path: pathSchema,
    label_path: pathSchema,
    match: z
      .object({
        input_path: pathSchema,
        item_path: pathSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export const providerSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "mistral", "cohere", "ollama"]),
    model: z.string().min(1),
    api_key: z
      .string()
      .regex(/^\$ENV:[A-Z_a-z][A-Z_a-z0-9]*$/)
      .optional(),
    base_url: z.string().url().optional(),
    temperature: z.number().min(0).max(2).optional(),
    timeout_ms: positive.default(30000),
    capabilities: z
      .object({
        nativeTools: z.boolean().optional(),
        structuredOutput: z.boolean().optional(),
        strictSchema: z.boolean().optional(),
        systemMessages: z.boolean().optional(),
        temperature: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const toolSchema = z
  .object({
    id: name,
    tool: z
      .object({
        title: z.string().max(200).optional(),
        description: z.string().trim().min(1).max(8000),
        input_schema: jsonSchema,
      })
      .strict(),
    trigger_hints: z.array(z.string().min(1)).default([]),
    keywords: z.record(z.string(), z.number().positive()).default({}),
    request: z
      .object({
        method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
        url: z.string().min(1),
        map: z
          .object({
            path: mapping.default({}),
            query: mapping.default({}),
            body: mapping.default({}),
            headers: mapping.default({}),
          })
          .strict()
          .default({}),
        timeout_ms: positive.default(8000),
        max_response_bytes: positive.default(1048576),
        auth: z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("none") }).strict(),
            z.object({ type: z.literal("session") }).strict(),
            z
              .object({
                type: z.literal("api-key"),
                env: z.string().regex(/^[A-Z_a-z][A-Z_a-z0-9]*$/),
                header: z
                  .string()
                  .regex(/^[A-Za-z0-9-]+$/)
                  .default("X-API-Key"),
              })
              .strict(),
          ])
          .default({ type: "none" }),
        allow_insecure_http: z.boolean().default(false),
        retry: z
          .object({
            attempts: positive.max(5).default(1),
            backoff_ms: nonnegative.max(60000).default(500),
            multiplier: z.number().min(1).max(10).default(2),
            jitter: z.boolean().default(true),
            idempotent: z.boolean().default(false),
          })
          .strict()
          .default({}),
        idempotency: z
          .object({
            header: z
              .string()
              .regex(/^[A-Za-z0-9-]+$/)
              .default("Idempotency-Key"),
            source: z.literal("generated").default("generated"),
          })
          .strict()
          .optional(),
        circuit_breaker: z
          .object({
            threshold: positive.default(5),
            reset_ms: positive.default(30000),
          })
          .strict()
          .default({}),
      })
      .strict(),
    behavior: z
      .object({
        effect: z
          .enum(["read-only", "side-effect", "destructive"])
          .default("read-only"),
        confirmation: z
          .object({
            required: z.boolean().default(false),
            ttl_ms: positive.default(300000),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    depends_on: z
      .array(
        z
          .object({
            tool: name,
            when: z.enum(["always", "missing"]).default("always"),
            arguments: mapping.default({}),
            select: selection.optional(),
            map: z.record(pathSchema, pathSchema),
            ttl_ms: positive.default(60000),
          })
          .strict(),
      )
      .default([]),
    navigates_to: z
      .object({ tool: name, map: z.record(pathSchema, pathSchema) })
      .strict()
      .optional(),
    selection: selection.optional(),
    response: z
      .object({
        output_schema: jsonSchema.optional(),
        items_path: pathSchema.optional(),
        model_view: z
          .object({
            path: pathSchema.default("$"),
            max_items: positive.max(1000).default(20),
            max_chars: positive.max(100000).default(12000),
            include: z.array(name).optional(),
          })
          .strict()
          .default({}),
        instructions: z
          .string()
          .default(
            "Present only the supplied API facts. Do not invent missing information.",
          ),
      })
      .strict()
      .default({}),
  })
  .strict();
export const configSchema = z
  .object({
    version: z.literal("2"),
    assistant: z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        language: z.string().trim().min(1).default("auto"),
        system_prompt: z
          .string()
          .default(
            "You are an AI assistant connected to application tools through AGENTO. Respond naturally to casual conversation. Reply in the user's language when practical. Do not invent facts that should come from application tools.",
          ),
        conversation: z
          .object({
            enabled: z.boolean().default(true),
            include_capability_summary: z.boolean().default(true),
            capability_summary: z
              .object({
                include_title: z.boolean().default(true),
                include_description: z.boolean().default(true),
              })
              .strict()
              .default({}),
            use_presentation_model: z.boolean().default(true),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    tools: z.array(toolSchema).min(1).max(10000),
    routing: z
      .object({
        candidate_limit: positive.max(100).default(6),
        fallback_attempts: positive.max(3).default(2),
        lexical: z
          .object({
            enabled: z.boolean().default(true),
            min_score: z.number().nonnegative().default(1),
            normalize_unicode: z.boolean().default(true),
            normalize_arabic: z.boolean().default(true),
            phrase_matching: z.boolean().default(true),
          })
          .strict()
          .default({}),
        semantic_recall: z
          .object({
            enabled: z.boolean().default(true),
            candidate_limit: positive.max(100).default(6),
            max_catalog_tools: positive.max(10000).default(100),
            max_catalog_chars: positive.max(1000000).default(100000),
            metadata: z
              .object({
                include_id: z.literal(true).default(true),
                include_title: z.boolean().default(true),
                include_description: z.boolean().default(true),
              })
              .strict()
              .default({}),
            allow_no_match: z.literal(true).default(true),
            multilingual: z.literal(true).default(true),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    session: z
      .object({
        ttl_ms: positive.default(1800000),
        max_history_messages: nonnegative.max(1000).default(20),
        max_sessions: positive.default(10000),
        max_steps: positive.max(100).default(32),
      })
      .strict()
      .default({}),
    rate_limits: z
      .object({
        ai_calls: positive.default(60),
        tool_calls: positive.default(120),
        messages: positive.default(120),
        messages_per_session: positive.default(1000),
        window_ms: positive.default(60000),
      })
      .strict()
      .default({}),
    models: z
      .object({
        routing: providerSchema,
        presentation: providerSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentConfigV2 = z.input<typeof configSchema>;
export type ResolvedConfig = z.output<typeof configSchema>;
export type ToolConfig = z.output<typeof toolSchema>;
export type ValueSource = z.output<typeof source>;
export type ProviderConfig = z.output<typeof providerSchema>;
