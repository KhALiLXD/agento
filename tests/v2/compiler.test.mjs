import { test } from "node:test";
import assert from "node:assert/strict";
import { compileConfig } from "../../dist/v2/config/compiler.js";
export const tool = (id = "search") => ({
  id,
  tool: {
    description: "Search products",
    input_schema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  },
  request: {
    method: "GET",
    url: "https://example.test/search",
    map: { query: { q: "$.q" } },
  },
});
const config = (...tools) => ({ version: "2", tools });
test("compiler separates model metadata, freezes config and applies defaults", () => {
  const c = compileConfig(config(tool()));
  assert.equal(c.tools.get("search").request, undefined);
  assert.equal(c.policies.routing.candidate_limit, 6);
  assert.throws(
    () => (c.tools.get("search").inputSchema.properties.q.type = "number"),
  );
  assert.equal(c.tools.set, undefined);
});
for (const [name, mutate, code] of [
  ["duplicate", (c) => c.tools.push(tool()), "CONFIG_TOOL_DUPLICATE"],
  [
    "path",
    (c) => (c.tools[0].request.url += "/{id}"),
    "CONFIG_PATH_PARAMETER_UNRESOLVED",
  ],
  [
    "bad schema",
    (c) => (c.tools[0].tool.input_schema.properties.q.type = "banana"),
    "CONFIG_SCHEMA_INVALID",
  ],
  [
    "unknown source",
    (c) => (c.tools[0].request.map.query.q = { source: "get-availability" }),
    "CONFIG_INVALID",
  ],
  [
    "unknown input",
    (c) => (c.tools[0].request.map.query.q = "$.absent"),
    "CONFIG_MAPPING_INVALID",
  ],
  [
    "auth over HTTP",
    (c) => {
      c.tools[0].request.url = "http://example.test";
      c.tools[0].request.auth = { type: "session" };
    },
    "CONFIG_AUTH_INVALID",
  ],
  [
    "action without policy",
    (c) => (c.tools[0].request.method = "POST"),
    "CONFIG_EFFECT_INVALID",
  ],
  [
    "missing dep",
    (c) =>
      (c.tools[0].depends_on = [{ tool: "missing", map: { "$.q": "$.name" } }]),
    "CONFIG_DEPENDENCY_INVALID",
  ],
  [
    "cycle",
    (c) =>
      (c.tools[0].depends_on = [{ tool: "search", map: { "$.q": "$.name" } }]),
    "CONFIG_DEPENDENCY_CYCLE",
  ],
  [
    "credential input",
    (c) =>
      (c.tools[0].tool.input_schema.properties.access_token = {
        type: "string",
      }),
    "CONFIG_SCHEMA_INVALID",
  ],
])
  test(name, () => {
    const c = config(tool());
    mutate(c);
    assert.throws(
      () => compileConfig(c),
      (e) => e.code === code,
    );
  });
test("reject duplicate YAML keys", () =>
  assert.throws(
    () => compileConfig('version: "2"\nversion: "2"'),
    (e) => e.code === "CONFIG_INVALID",
  ));
