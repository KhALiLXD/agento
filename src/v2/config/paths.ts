import { createHash } from "node:crypto";
import { fail } from "../errors.js";
import { pathSchema } from "./schema.js";
export function readPath(value: unknown, path: string): unknown {
  if (!pathSchema.safeParse(path).success)
    fail("CONFIG_MAPPING_INVALID", "Invalid property path.");
  let result = value;
  for (const part of path.split(".").slice(1)) {
    if (!result || typeof result !== "object" || !Object.hasOwn(result, part))
      return undefined;
    result = (result as Record<string, unknown>)[part];
  }
  return result;
}
export function writePath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (path === "$" || !pathSchema.safeParse(path).success)
    fail("CONFIG_MAPPING_INVALID", "A writable property path is required.");
  const parts = path.slice(2).split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (next === undefined) current[part] = {};
    else if (!next || typeof next !== "object" || Array.isArray(next))
      fail("INPUT_MAPPING_CONFLICT", "Overlapping property mappings.");
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = structuredClone(value);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
