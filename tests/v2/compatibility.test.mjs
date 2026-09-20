import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AgentRuntime,
  compileConfig,
  migrateLegacyConfig,
  createMcpAdapter,
  evaluateRouting,
} from "../../dist/v2/index.js";
const input_schema = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};
const config = {
  version: "2",
  tools: [
    {
      id: "search",
      tool: { description: "search hair", input_schema },
      request: {
        method: "GET",
        url: "https://api.test",
        map: { query: { q: "$.q" } },
      },
    },
  ],
};
for (const name of ["catalog", "booking"])
  test(`${name} example compiles`, async () => {
    const c = compileConfig(
      await readFile(
        new URL(`../../examples/v2/${name}.yml`, import.meta.url),
        "utf8",
      ),
      { OPENAI_API_KEY: "test-only-key" },
    );
    assert.ok(c.tools.size >= 3);
  });
test("legacy migration exposes query inputs and refuses undocumented sources", () => {
  const old = {
    endpoints: [
      {
        id: "search",
        description_for_ai: "Find products",
        http: { method: "GET", url: "https://api.test" },
        query_params: [{ name: "q", type: "string", required: true }],
      },
    ],
  };
  const r = migrateLegacyConfig(old);
  assert.equal(r.requiresReview, true);
  assert.deepEqual(r.config.tools[0].tool.input_schema.required, ["q"]);
  assert.equal(compileConfig(r.config).tools.size, 1);
  old.endpoints[0].payload = {
    required: [{ name: "id", source: "some-api", type: "string" }],
  };
  assert.throws(
    () => migrateLegacyConfig(old),
    (e) => e.code === "CONFIG_MIGRATION_AMBIGUOUS",
  );
});
test("MCP foundation returns structured errors and inherits runtime validation", async () => {
  const runtime = await AgentRuntime.create({
    config,
    fetch: async () => Response.json({ name: "hair" }),
  });
  const mcp = createMcpAdapter(runtime, async () => ({
    sessionId: "mcp-user",
  }));
  const listed = await mcp.listTools();
  assert.equal(listed.tools[0].annotations.readOnlyHint, true);
  assert.equal(listed.tools[0].request, undefined);
  const r = await mcp.callTool({ name: "search", arguments: { q: "hair" } });
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.status, "completed");
  const missing = await mcp.callTool({ name: "search" });
  assert.equal(missing.structuredContent.status, "needs_input");
  runtime.dispose();
});
test("routing evaluations run without APIs and report no-match and argument accuracy", async () => {
  const model = {
    capabilities: () => ({ nativeTools: true }),
    selectTool: async () => ({
      call: { name: "search", arguments: { q: "hair" } },
      usage: { inputTokens: 2, outputTokens: 3 },
    }),
  };
  const r = await evaluateRouting(compileConfig(config), model, [
    {
      input: "hair search",
      expectedTool: "search",
      expectedArguments: { q: "hair" },
    },
    { input: "zebra", expectedTool: null },
  ]);
  assert.equal(r.toolSelectionAccuracy, 1);
  assert.equal(r.argumentAccuracy, 1);
  assert.equal(r.modelCalls, 1);
  assert.equal(r.tokens, 5);
});
