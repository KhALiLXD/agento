import { randomUUID } from "node:crypto";
import type { ToolConfig, ValueSource } from "../config/schema.js";
import { readPath } from "../config/paths.js";
import { fail } from "../errors.js";
export interface MappingContext {
  input: Record<string, unknown>;
  session: Record<string, unknown>;
  dependencies: Record<string, unknown>;
}
export interface PreparedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
export function resolveSource(
  source: ValueSource,
  context: MappingContext,
): unknown {
  if (typeof source === "string") return readPath(context.input, source);
  switch (source.source) {
    case "tool-input":
      return readPath(context.input, source.path);
    case "session":
      return readPath(context.session, source.path);
    case "dependency":
      return readPath(context.dependencies[source.tool], source.path);
    case "constant":
      return source.value;
    case "generated":
      return randomUUID();
  }
}
export function mapValues(
  mapping: Record<string, ValueSource>,
  context: MappingContext,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(mapping).flatMap(([key, source]) => {
      const value = resolveSource(source, context);
      if (value === undefined) {
        if (typeof source !== "string" && source.source !== "tool-input")
          fail("INPUT_MAPPING_MISSING", "Runtime mapping source is missing.", {
            field: key,
          });
        return [];
      }
      return [[key, value]];
    }),
  );
}
function scalar(value: unknown): string {
  if (!["string", "number", "boolean"].includes(typeof value))
    return fail("INPUT_MAPPING_INVALID", "URL/header values must be scalar.");
  return String(value);
}
export function prepareRequest(
  tool: ToolConfig,
  context: MappingContext,
): PreparedRequest {
  let url = tool.request.url;
  for (const [key, value] of Object.entries(
    mapValues(tool.request.map.path, context),
  )) {
    const s = scalar(value);
    if (!s || s === "." || s === ".." || /[\\/\x00-\x1f]/.test(s))
      fail("INPUT_PATH_INVALID", "Invalid path argument.");
    url = url.replaceAll("{" + key + "}", encodeURIComponent(s));
  }
  if (/\{/.test(url)) fail("INPUT_REQUIRED", "Path arguments are missing.");
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(
    mapValues(tool.request.map.query, context),
  )) {
    parsed.searchParams.delete(key);
    for (const v of Array.isArray(value) ? value : [value])
      parsed.searchParams.append(key, scalar(v));
  }
  const headers = Object.fromEntries(
    Object.entries(mapValues(tool.request.map.headers, context)).map(
      ([key, value]) => {
        const s = scalar(value);
        if (/[\r\n]/.test(s))
          fail("INPUT_HEADER_INVALID", "Invalid header value.");
        return [key, s];
      },
    ),
  );
  const body = mapValues(tool.request.map.body, context);
  if (tool.request.idempotency)
    headers[tool.request.idempotency.header] = randomUUID();
  return {
    url: parsed.toString(),
    method: tool.request.method,
    headers,
    ...(Object.keys(body).length ? { body: JSON.stringify(body) } : {}),
  };
}
