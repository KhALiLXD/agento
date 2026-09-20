import { z } from "zod";
import { parseConfig } from "./compiler.js";
import type { AgentConfigV2 } from "./schema.js";
import { fail } from "../errors.js";
const field = z
  .object({
    name: z.string(),
    type: z.string().default("string"),
    required: z.boolean().optional(),
    ai_label: z.string().optional(),
    source: z.string().optional(),
    value: z.unknown().optional(),
    enum: z.array(z.unknown()).optional(),
  })
  .passthrough();
const legacy = z
  .object({
    endpoints: z.array(
      z
        .object({
          id: z.string(),
          type: z.string().optional(),
          description_for_ai: z.string(),
          trigger_hints: z.array(z.string()).optional(),
          http: z
            .object({
              method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
              url: z.string(),
              timeout_ms: z.number().optional(),
            })
            .passthrough(),
          query_params: z.array(field).optional(),
          payload: z
            .object({
              required: z.array(field).optional(),
              optional: z.array(field).optional(),
              static: z.array(field).optional(),
            })
            .passthrough()
            .optional(),
          headers: z.array(z.unknown()).optional(),
          auth: z.unknown().optional(),
          depends_on: z.unknown().optional(),
          navigates_to: z.unknown().optional(),
          response_hint: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export interface MigrationResult {
  config: AgentConfigV2;
  warnings: string[];
  requiresReview: boolean;
}
/** Produces an explicit draft; never automatically loads potentially ambiguous v1 policy. */
export function migrateLegacyConfig(input: unknown): MigrationResult {
  const parsed = legacy.safeParse(
    typeof input === "string" ? parseConfig(input) : input,
  );
  if (!parsed.success)
    fail(
      "CONFIG_MIGRATION_INVALID",
      "Expected a legacy YAML configuration with endpoints.",
    );
  const warnings: string[] = [];
  const tools: AgentConfigV2["tools"] = parsed.data.endpoints.map((e) => {
    const properties: Record<string, Record<string, unknown>> = {},
      required: string[] = [],
      path: Record<string, string> = {},
      query: Record<string, string> = {},
      body: Record<string, unknown> = {};
    const add = (
      f: z.infer<typeof field>,
      isRequired: boolean,
      destination: Record<string, unknown>,
    ) => {
      if (
        !["string", "number", "integer", "boolean", "object", "array"].includes(
          f.type,
        )
      )
        fail(
          "CONFIG_MIGRATION_AMBIGUOUS",
          `Tool ${e.id}: unsupported legacy field type. Define a v2 schema explicitly.`,
        );
      const source = f.source ?? "conversation";
      if (source === "conversation") {
        if (
          properties[f.name] &&
          JSON.stringify(properties[f.name]) !==
            JSON.stringify({ type: f.type })
        )
          warnings.push(
            `${e.id}.${f.name}: review overlapping legacy field declarations.`,
          );
        properties[f.name] = {
          type: f.type,
          ...(f.ai_label ? { description: f.ai_label } : {}),
          ...(f.enum ? { enum: f.enum } : {}),
        };
        if (isRequired && !required.includes(f.name)) required.push(f.name);
        destination[f.name] = "$." + f.name;
      } else if (source === "session")
        destination[f.name] = { source: "session", path: "$." + f.name };
      else if (source === "config-constant") {
        if (!Object.hasOwn(f, "value"))
          fail(
            "CONFIG_MIGRATION_AMBIGUOUS",
            `Tool ${e.id}: constant ${f.name} has no value.`,
          );
        destination[f.name] = { source: "constant", value: f.value };
      } else if (source === "generated")
        destination[f.name] = { source: "generated", generator: "uuid" };
      else
        fail(
          "CONFIG_MIGRATION_AMBIGUOUS",
          `Tool ${e.id}: source ${source} requires an explicit v2 dependency mapping.`,
        );
    };
    for (const f of e.query_params ?? []) add(f, f.required ?? false, query);
    for (const [fields, isRequired] of [
      [e.payload?.required ?? [], true],
      [e.payload?.optional ?? [], false],
    ] as const)
      for (const f of fields) {
        const destination = e.http.url.includes("{" + f.name + "}")
          ? path
          : ["GET", "HEAD"].includes(e.http.method)
            ? query
            : body;
        add(f, isRequired, destination);
      }
    for (const f of e.payload?.static ?? [])
      body[f.name] = { source: "constant", value: f.value };
    if (e.auth !== undefined || e.headers?.length)
      warnings.push(
        `${e.id}: map authentication/headers explicitly to request.auth; this draft does not forward legacy credentials.`,
      );
    if (e.depends_on !== undefined || e.navigates_to !== undefined)
      warnings.push(
        `${e.id}: specify dependency/navigation and selection paths explicitly; legacy implicit id/name selection cannot be inferred safely.`,
      );
    const effect =
      ["GET", "HEAD"].includes(e.http.method) && e.type !== "action"
        ? "read-only"
        : "side-effect";
    return {
      id: e.id,
      tool: {
        description: e.description_for_ai,
        input_schema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
      trigger_hints: e.trigger_hints,
      request: {
        ...e.http,
        map: { path, query, body } as NonNullable<
          AgentConfigV2["tools"][number]["request"]["map"]
        >,
      },
      behavior: { effect, confirmation: { required: effect !== "read-only" } },
      response: { instructions: e.response_hint },
    };
  });
  warnings.push(
    "Review provider settings, global authentication, rate limits, session policy and presentation instructions; v1 defaults are not inherited.",
  );
  return { config: { version: "2", tools }, warnings, requiresReview: true };
}
