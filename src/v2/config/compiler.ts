import { parseDocument } from "yaml";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import {
  configSchema,
  type ResolvedConfig,
  type ToolConfig,
  type JsonSchema,
} from "./schema.js";
import { deepFreeze, digest } from "./paths.js";
import { fail } from "../errors.js";
import { sensitiveKey } from "../security/redactor.js";
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}
export interface LightweightToolDefinition {
  readonly id: string;
  readonly title?: string;
  readonly description: string;
}
export interface ExecutionDefinition {
  readonly config: ToolConfig;
  readonly validateInput: ValidateFunction;
  readonly validatePartial: ValidateFunction;
  readonly validateOutput?: ValidateFunction;
}
// No exposed mutable Map: Object.freeze(Map) would still permit .set().
export class Registry<T> {
  #values: Map<string, T>;
  constructor(entries: Iterable<readonly [string, T]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }
  get(id: string): T {
    const value = this.#values.get(id);
    if (!value) fail("ROUTING_NO_MATCH", "Unknown tool.", { tool: id });
    return value;
  }
  has(id: string) {
    return this.#values.has(id);
  }
  values(): readonly T[] {
    return Object.freeze([...this.#values.values()]);
  }
  get size() {
    return this.#values.size;
  }
}
export interface CompiledAgent {
  readonly tools: Registry<ToolDefinition>;
  readonly lightweightTools: readonly LightweightToolDefinition[];
  readonly executions: Registry<ExecutionDefinition>;
  readonly dependencyGraph: Readonly<Record<string, readonly string[]>>;
  readonly policies: ResolvedConfig;
  readonly hash: string;
}
export function schemaValidator(
  schema: JsonSchema,
  defaults = false,
): ValidateFunction {
  try {
    const ajv = new Ajv({
      allErrors: true,
      strict: true,
      useDefaults: defaults,
      coerceTypes: false,
      addUsedSchema: false,
    });
    addFormats(ajv);
    return ajv.compile(schema);
  } catch {
    return fail(
      "CONFIG_SCHEMA_INVALID",
      "Invalid or unsupported JSON Schema (use draft-07 with local references).",
    );
  }
}
export function parseConfig(yaml: string): unknown {
  try {
    const doc = parseDocument(yaml, { uniqueKeys: true });
    if (doc.errors.length)
      fail("CONFIG_INVALID", "Invalid YAML or duplicate keys.");
    return doc.toJS({ maxAliasCount: 50 });
  } catch {
    return fail("CONFIG_INVALID", "Invalid YAML configuration.");
  }
}
function schemaAt(schema: JsonSchema, path: string): boolean {
  let current: unknown = schema;
  for (const part of path.split(".").slice(1)) {
    if (!current || typeof current !== "object") return false;
    current = (
      (current as JsonSchema).properties as Record<string, unknown> | undefined
    )?.[part];
  }
  return current !== undefined;
}
function validateProperties(schema: unknown): void {
  if (!schema || typeof schema !== "object") return;
  const node = schema as JsonSchema;
  if (node.properties && typeof node.properties === "object")
    for (const key of Object.keys(node.properties)) {
      if (
        !key.trim() ||
        sensitiveKey(key) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        fail(
          "CONFIG_SCHEMA_INVALID",
          "Model input schemas cannot expose credential or unsafe property names.",
        );
    }
  for (const child of Object.values(node))
    if (child && typeof child === "object") validateProperties(child);
}
export function compileConfig(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): CompiledAgent {
  const parsed = configSchema.safeParse(
    typeof input === "string" ? parseConfig(input) : input,
  );
  if (!parsed.success)
    fail("CONFIG_INVALID", "Configuration validation failed.", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        code: i.code,
        message:
          i.code === "custom" ? "Invalid configuration value." : i.message,
      })),
    });
  const config = parsed.data,
    ids = new Set<string>(),
    tools: Array<[string, ToolDefinition]> = [],
    executions: Array<[string, ExecutionDefinition]> = [];
  for (const tool of config.tools) {
    if (ids.has(tool.id))
      fail("CONFIG_TOOL_DUPLICATE", `Duplicate tool: ${tool.id}`);
    ids.add(tool.id);
  }
  for (const model of Object.values(config.models ?? {})) {
    if (!model) continue;
    if (model.provider !== "ollama" && !model.api_key)
      fail(
        "CONFIG_AUTH_INVALID",
        "Provider requires an environment API key reference.",
      );
    if (model.api_key && !env[model.api_key.slice(5)])
      fail(
        "CONFIG_SECRET_MISSING",
        "Required provider environment variable is missing.",
        { variable: model.api_key.slice(5) },
      );
    if (model.base_url) {
      const u = new URL(model.base_url);
      if (
        u.username ||
        u.password ||
        !["http:", "https:"].includes(u.protocol) ||
        (model.provider !== "ollama" && u.protocol !== "https:")
      )
        fail(
          "CONFIG_AUTH_INVALID",
          "Provider URL must use safe HTTPS transport.",
        );
    }
  }
  for (const tool of config.tools) {
    const schema = tool.tool.input_schema;
    validateProperties(schema);
    if (schema.type !== "object")
      fail(
        "CONFIG_SCHEMA_INVALID",
        `Tool ${tool.id} requires an object input schema.`,
      );
    const properties = schema.properties as Record<string, unknown> | undefined;
    for (const key of Object.keys(properties ?? {}))
      if (
        !key.trim() ||
        sensitiveKey(key) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        fail(
          "CONFIG_SCHEMA_INVALID",
          `Tool ${tool.id} exposes a credential or invalid input field.`,
        );
    let url: URL;
    try {
      url = new URL(
        tool.request.url.replace(/\{[A-Za-z0-9_-]+\}/g, "placeholder"),
      );
    } catch {
      return fail(
        "CONFIG_URL_INVALID",
        `Tool ${tool.id} requires an absolute HTTP(S) URL.`,
      );
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      fail("CONFIG_URL_INVALID", `Tool ${tool.id} has an unsafe URL.`);
    if (
      /\{/.test(new URL(tool.request.url).origin) ||
      /\{/.test(tool.request.url.split("?")[1] ?? "")
    )
      fail(
        "CONFIG_MAPPING_INVALID",
        "URL placeholders are only allowed in paths.",
      );
    if (
      tool.request.auth.type !== "none" &&
      url.protocol !== "https:" &&
      !tool.request.allow_insecure_http
    )
      fail(
        "CONFIG_AUTH_INVALID",
        `Tool ${tool.id} requires HTTPS for credentials.`,
      );
    if (tool.request.auth.type === "api-key" && !env[tool.request.auth.env])
      fail(
        "CONFIG_SECRET_MISSING",
        `Tool ${tool.id} is missing its API key environment value.`,
      );
    if ([...url.searchParams.keys()].some(sensitiveKey))
      fail(
        "CONFIG_URL_INVALID",
        "Credentials are not permitted in configured URL query strings. Use request.auth.",
      );
    const reservedHeaders = [
      "host",
      "content-length",
      "connection",
      "transfer-encoding",
    ];
    if (
      tool.request.auth.type === "api-key" &&
      reservedHeaders.includes(tool.request.auth.header.toLowerCase())
    )
      fail(
        "CONFIG_AUTH_INVALID",
        "Reserved transport header cannot carry an API key.",
      );
    if (tool.request.idempotency) {
      const h = tool.request.idempotency.header.toLowerCase();
      if (
        sensitiveKey(h) ||
        reservedHeaders.includes(h) ||
        Object.keys(tool.request.map.headers).some((k) => k.toLowerCase() === h)
      )
        fail(
          "CONFIG_MAPPING_INVALID",
          "Idempotency header conflicts with authentication or mapped headers.",
        );
    }
    const placeholders = [
      ...tool.request.url.matchAll(/\{([A-Za-z0-9_-]+)\}/g),
    ].map((m) => m[1]);
    if (placeholders.some((p) => !Object.hasOwn(tool.request.map.path, p)))
      fail(
        "CONFIG_PATH_PARAMETER_UNRESOLVED",
        `Tool ${tool.id} has unresolved URL path parameters.`,
      );
    if (
      Object.keys(tool.request.map.path).some((p) => !placeholders.includes(p))
    )
      fail(
        "CONFIG_MAPPING_INVALID",
        `Tool ${tool.id} maps an undeclared path parameter.`,
      );
    if (
      ["GET", "HEAD"].includes(tool.request.method) &&
      Object.keys(tool.request.map.body).length
    )
      fail("CONFIG_MAPPING_INVALID", "GET/HEAD cannot have a request body.");
    if (
      !["GET", "HEAD"].includes(tool.request.method) &&
      tool.behavior.effect === "read-only"
    )
      fail(
        "CONFIG_EFFECT_INVALID",
        `Tool ${tool.id}: mutating HTTP methods must declare side effects.`,
      );
    if (
      tool.behavior.effect !== "read-only" &&
      !tool.behavior.confirmation.required
    )
      fail(
        "CONFIG_CONFIRMATION_INVALID",
        `Tool ${tool.id}: side effects require confirmation.`,
      );
    const headers = Object.keys(tool.request.map.headers).map((h) =>
      h.toLowerCase(),
    );
    if (
      new Set(headers).size !== headers.length ||
      headers.some(
        (h) =>
          sensitiveKey(h) ||
          [
            "host",
            "content-length",
            "connection",
            "transfer-encoding",
          ].includes(h),
      )
    )
      fail(
        "CONFIG_MAPPING_INVALID",
        "Conflicting or security-sensitive header mapping; use request.auth.",
      );
    for (const group of Object.values(tool.request.map))
      for (const value of Object.values(group)) {
        if (typeof value !== "string" && value.source === "selection")
          fail(
            "CONFIG_MAPPING_INVALID",
            "Selection facts are presentation-only; use explicit execution mappings.",
          );
        const path =
          typeof value === "string"
            ? value
            : value.source === "tool-input"
              ? value.path
              : undefined;
        if (path && !schemaAt(schema, path))
          fail(
            "CONFIG_MAPPING_INVALID",
            `Tool ${tool.id} maps an undeclared input.`,
          );
        if (
          typeof value !== "string" &&
          value.source === "dependency" &&
          !tool.depends_on.some((d) => d.tool === value.tool)
        )
          fail(
            "CONFIG_DEPENDENCY_INVALID",
            `Tool ${tool.id} maps an undeclared dependency.`,
          );
      }
    const targets = new Set<string>();
    if (
      tool.behavior.recovery &&
      (tool.behavior.effect === "read-only" ||
        !tool.depends_on.some(
          (dep) => dep.tool === tool.behavior.recovery!.refresh_dependency,
        ))
    )
      fail(
        "CONFIG_DEPENDENCY_INVALID",
        "Recovery requires a declared dependency on a confirmed action.",
      );
    if (
      new Set(tool.depends_on.map((d) => d.tool)).size !==
      tool.depends_on.length
    )
      fail("CONFIG_DEPENDENCY_INVALID", "Duplicate dependency tool.");
    for (const dep of tool.depends_on) {
      if (!ids.has(dep.tool))
        fail(
          "CONFIG_DEPENDENCY_INVALID",
          `Tool ${tool.id} references missing dependency ${dep.tool}.`,
        );
      if (
        config.tools.find((t) => t.id === dep.tool)?.behavior.effect !==
        "read-only"
      )
        fail(
          "CONFIG_DEPENDENCY_INVALID",
          "Automatic dependencies must be read-only.",
        );
      const upstream = config.tools.find((t) => t.id === dep.tool)!;
      for (const [key, value] of Object.entries(dep.arguments)) {
        if (typeof value !== "string" && value.source === "selection")
          fail(
            "CONFIG_MAPPING_INVALID",
            "Selection facts cannot supply dependency execution inputs.",
          );
        if (!schemaAt(upstream.tool.input_schema, "$." + key))
          fail(
            "CONFIG_MAPPING_INVALID",
            "Dependency argument is not declared by its tool.",
          );
        const path =
          typeof value === "string"
            ? value
            : value.source === "tool-input"
              ? value.path
              : undefined;
        if (path && !schemaAt(schema, path))
          fail(
            "CONFIG_MAPPING_INVALID",
            "Dependency reads an undeclared parent input.",
          );
        if (typeof value !== "string" && value.source === "dependency")
          fail(
            "CONFIG_MAPPING_INVALID",
            "Dependency argument sources must use parent input, session, constant, or generated values.",
          );
      }
      if (dep.select?.match && !schemaAt(schema, dep.select.match.input_path))
        fail(
          "CONFIG_MAPPING_INVALID",
          `Tool ${tool.id} selection match reads an undeclared input.`,
        );
      for (const target of Object.keys(dep.map)) {
        if (
          target === "$" ||
          !schemaAt(schema, target) ||
          [...targets].some(
            (t) =>
              t === target ||
              t.startsWith(target + ".") ||
              target.startsWith(t + "."),
          )
        )
          fail(
            "CONFIG_MAPPING_INVALID",
            `Tool ${tool.id} has conflicting dependency mappings.`,
          );
        targets.add(target);
      }
    }
    if (
      tool.navigates_to &&
      (!ids.has(tool.navigates_to.tool) || !tool.selection)
    )
      fail(
        "CONFIG_NAVIGATION_INVALID",
        "Navigation requires a valid tool and explicit selection configuration.",
      );
    if (tool.navigates_to) {
      const target = config.tools.find(
        (t) => t.id === tool.navigates_to?.tool,
      )!;
      const navigationTargets = new Set<string>();
      for (const [key, value] of Object.entries(tool.navigates_to.arguments)) {
        if (typeof value !== "string" && value.source === "selection")
          fail(
            "CONFIG_NAVIGATION_INVALID",
            "Use selected-item map for navigation inputs.",
          );
        const targetPath = "$." + key;
        if (!schemaAt(target.tool.input_schema, targetPath))
          fail(
            "CONFIG_NAVIGATION_INVALID",
            "Navigation argument maps an undeclared target input.",
          );
        const sourcePath =
          typeof value === "string"
            ? value
            : value.source === "tool-input"
              ? value.path
              : undefined;
        if (sourcePath && !schemaAt(schema, sourcePath))
          fail(
            "CONFIG_NAVIGATION_INVALID",
            "Navigation argument reads an undeclared source input.",
          );
        if (typeof value !== "string" && value.source === "dependency")
          fail(
            "CONFIG_NAVIGATION_INVALID",
            "Navigation arguments cannot read dependency results.",
          );
        navigationTargets.add(targetPath);
      }
      for (const path of Object.keys(tool.navigates_to.map)) {
        if (path === "$" || !schemaAt(target.tool.input_schema, path))
          fail(
            "CONFIG_NAVIGATION_INVALID",
            "Navigation maps an undeclared target input.",
          );
        if (
          [...navigationTargets].some(
            (other) =>
              other === path ||
              other.startsWith(path + ".") ||
              path.startsWith(other + "."),
          )
        )
          fail(
            "CONFIG_NAVIGATION_INVALID",
            "Navigation argument and selected-item mappings conflict.",
          );
        navigationTargets.add(path);
      }
    }
    if (
      tool.selection?.match &&
      !schemaAt(schema, tool.selection.match.input_path)
    )
      fail(
        "CONFIG_MAPPING_INVALID",
        `Tool ${tool.id} selection match reads an undeclared input.`,
      );
    if (tool.references) {
      if (tool.references.publish) {
        if (
          tool.references.publish.path === "$" ||
          tool.references.publish.path
            .split(".")
            .some(
              (part) =>
                sensitiveKey(part) ||
                config.tools.some((entry) =>
                  entry.response.private_fields.includes(part),
                ),
            )
        )
          fail(
            "CONFIG_REFERENCES_INVALID",
            "References cannot publish private fields or whole response items.",
          );
        if (
          !tool.selection &&
          !config.tools.some((parent) =>
            parent.depends_on.some((dep) => dep.tool === tool.id && dep.select),
          )
        )
          fail(
            "CONFIG_REFERENCES_INVALID",
            "Reference publication requires an explicit selection.",
          );
      }
      if (tool.references.consume) {
        for (const [inputName, refName] of Object.entries(
          tool.references.consume,
        )) {
          if (!schemaAt(schema, "$." + inputName))
            fail(
              "CONFIG_REFERENCES_INVALID",
              "Reference consume input is not declared.",
            );
          if (
            !config.tools.some(
              (publisher) => publisher.references?.publish?.name === refName,
            )
          )
            fail(
              "CONFIG_REFERENCES_INVALID",
              "Reference consumer has no declared publisher.",
            );
          targets.add("$." + inputName);
        }
      }
    }
    for (const [key, value] of Object.entries(
      tool.behavior.confirmation.preview,
    )) {
      if (typeof value !== "string" && value.source === "selection") {
        const facts = new Set<string>();
        const visited = new Set<string>();
        const gather = (current: ToolConfig): void => {
          if (visited.has(current.id)) return;
          visited.add(current.id);
          for (const selected of [
            current.selection,
            ...current.depends_on.map((dep) => dep.select),
          ])
            for (const fact of Object.keys(selected?.facts ?? {}))
              facts.add(fact);
          for (const dependency of current.depends_on) {
            const upstream = config.tools.find(
              (entry) => entry.id === dependency.tool,
            );
            if (upstream) gather(upstream);
          }
          for (const upstream of config.tools)
            if (upstream.navigates_to?.tool === current.id) gather(upstream);
        };
        gather(tool);
        if (value.path === "$" || !facts.has(value.path.split(".")[1]))
          fail(
            "CONFIG_CONFIRMATION_INVALID",
            "Confirmation reads an undeclared selection fact.",
          );
      }
      const privateFields = new Set(
        config.tools.flatMap((entry) => entry.response.private_fields),
      );
      const sourcePath =
        typeof value === "string"
          ? value
          : "path" in value
            ? value.path
            : undefined;
      if (
        sensitiveKey(key) ||
        privateFields.has(key) ||
        sourcePath
          ?.split(".")
          .some((part) => sensitiveKey(part) || privateFields.has(part))
      )
        fail(
          "CONFIG_CONFIRMATION_INVALID",
          "Confirmation preview cannot expose credential-like fields.",
        );
      const path =
        typeof value === "string"
          ? value
          : value.source === "tool-input"
            ? value.path
            : undefined;
      if (path && !schemaAt(schema, path))
        fail(
          "CONFIG_CONFIRMATION_INVALID",
          "Confirmation preview reads an undeclared input.",
        );
      if (typeof value !== "string" && value.source === "generated")
        fail(
          "CONFIG_CONFIRMATION_INVALID",
          "Confirmation previews cannot contain generated values.",
        );
      if (
        typeof value !== "string" &&
        value.source === "dependency" &&
        !tool.depends_on.some((dependency) => dependency.tool === value.tool)
      )
        fail(
          "CONFIG_CONFIRMATION_INVALID",
          "Confirmation preview reads an undeclared dependency.",
        );
    }
    for (const selected of [
      tool.selection,
      ...tool.depends_on.map((dep) => dep.select),
    ]) {
      if (!selected) continue;
      const privateFields = new Set(
        config.tools.flatMap((entry) => entry.response.private_fields),
      );
      for (const [key, path] of Object.entries(selected.facts ?? {}))
        if (
          sensitiveKey(key) ||
          privateFields.has(key) ||
          path === "$" ||
          path
            .split(".")
            .some((part) => sensitiveKey(part) || privateFields.has(part))
        )
          fail(
            "CONFIG_MAPPING_INVALID",
            "Selection facts cannot expose private fields or entire items.",
          );
    }
    const inputSchema = structuredClone(schema);
    if (inputSchema.additionalProperties === undefined)
      inputSchema.additionalProperties = false;
    const partialSchema = { ...inputSchema, required: [] };
    const modelSchema = structuredClone(inputSchema);
    const modelProperties = (modelSchema.properties ?? {}) as Record<
      string,
      unknown
    >;
    for (const path of targets)
      if (path.split(".").length === 2) delete modelProperties[path.slice(2)];
    modelSchema.required = (
      Array.isArray(modelSchema.required) ? modelSchema.required : []
    ).filter((k) => typeof k === "string" && Object.hasOwn(modelProperties, k));
    tools.push([
      tool.id,
      deepFreeze({
        name: tool.id,
        description: tool.tool.description,
        inputSchema: modelSchema,
      }),
    ]);
    executions.push([
      tool.id,
      Object.freeze({
        config: deepFreeze(tool),
        validateInput: schemaValidator(inputSchema, true),
        validatePartial: schemaValidator(partialSchema, true),
        ...(tool.response.output_schema
          ? { validateOutput: schemaValidator(tool.response.output_schema) }
          : {}),
      }),
    ]);
  }
  const graph = Object.fromEntries(
    config.tools.map((t) => [t.id, t.depends_on.map((d) => d.tool)]),
  );
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id))
      fail("CONFIG_DEPENDENCY_CYCLE", `Dependency cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph[id]) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return Object.freeze({
    tools: new Registry(tools),
    lightweightTools: deepFreeze(
      config.tools.map((tool) => ({
        id: tool.id,
        ...(tool.tool.title ? { title: tool.tool.title } : {}),
        description: tool.tool.description,
      })),
    ),
    executions: new Registry(executions),
    dependencyGraph: deepFreeze(graph),
    policies: deepFreeze(config),
    hash: digest(config),
  });
}
