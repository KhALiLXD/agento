import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentRuntime,
  MemorySessionStore,
  compileConfig,
} from "../../dist/v2/index.js";

const config = () => ({
  version: "2",
  tools: [
    {
      id: "list",
      tool: {
        description: "List catalog",
        input_schema: { type: "object", properties: {} },
      },
      request: { method: "GET", url: "https://api.test/list" },
      selection: { items_path: "$", id_path: "$.id", label_path: "$.name" },
      navigates_to: { tool: "details", map: { "$.service_id": "$.id" } },
      references: { publish: { name: "service", path: "$.id", ttl_ms: 60000 } },
    },
    ...["details", "variants"].map((id) => ({
      id,
      tool: {
        description: id,
        input_schema: {
          type: "object",
          properties: { service_id: { type: "integer" } },
          required: ["service_id"],
          additionalProperties: false,
        },
      },
      request: {
        method: "GET",
        url: `https://api.test/${id}`,
        map: { query: { service_id: "$.service_id" } },
      },
      references: { consume: { service_id: "service" } },
    })),
  ],
});

test("selected reference uses the chosen item, not the last item; host input wins", async () => {
  const store = new MemorySessionStore();
  const runtime = await AgentRuntime.create({
    config: config(),
    sessionStore: store,
    fetch: async (url) =>
      new URL(url).pathname === "/list"
        ? Response.json([
            { id: 17, name: "First" },
            { id: 42, name: "Second" },
            { id: 90, name: "Last" },
          ])
        : Response.json({
            id: Number(new URL(url).searchParams.get("service_id")),
          }),
  });
  try {
    const list = await runtime.invoke({ sessionId: "a", tool: "list" });
    await runtime.select({
      sessionId: "a",
      selectionId: list.selection.id,
      choice: "17",
    });
    const next = await runtime.invoke({ sessionId: "a", tool: "variants" });
    assert.equal(next.data.id, 17);
    assert.equal(
      (await store.get("a")).references.service.sourceToolId,
      "list",
    );
    assert.equal(
      (
        await runtime.invoke({
          sessionId: "a",
          tool: "variants",
          arguments: { service_id: 42 },
        })
      ).data.id,
      42,
    );
    assert.equal(
      (await runtime.invoke({ sessionId: "b", tool: "variants" })).status,
      "needs_input",
    );
    assert.equal(
      runtime.listTools().find((tool) => tool.name === "variants").inputSchema
        .properties.service_id,
      undefined,
    );
  } finally {
    runtime.dispose();
  }
});

test("references expire and cannot cross a changed host context", async () => {
  const store = new MemorySessionStore();
  const runtime = await AgentRuntime.create({
    config: config(),
    sessionStore: store,
    fetch: async (url) =>
      new URL(url).pathname === "/list"
        ? Response.json([{ id: 17, name: "First" }])
        : Response.json({}),
  });
  try {
    const first = await runtime.invoke({
      sessionId: "a",
      tool: "list",
      context: { tenant: 1 },
    });
    await runtime.select({
      sessionId: "a",
      selectionId: first.selection.id,
      choice: "17",
    });
    assert.equal(
      (
        await runtime.invoke({
          sessionId: "a",
          tool: "variants",
          context: { tenant: 2 },
        })
      ).status,
      "needs_input",
    );
    const state = await store.get("a");
    state.references.service.expiresAt = 0;
    await store.set("a", state);
    assert.equal(
      (
        await runtime.invoke({
          sessionId: "a",
          tool: "variants",
          context: { tenant: 1 },
        })
      ).status,
      "needs_input",
    );
  } finally {
    runtime.dispose();
  }
});

test("compiler rejects undeclared reference consumers and unsafe reference names", () => {
  const absent = config();
  absent.tools[1].references.consume.service_id = "absent";
  assert.throws(
    () => compileConfig(absent),
    (error) => error.code === "CONFIG_REFERENCES_INVALID",
  );
  const unsafe = config();
  unsafe.tools[0].references.publish.name = "__proto__";
  assert.throws(
    () => compileConfig(unsafe),
    (error) => error.code === "CONFIG_INVALID",
  );
});
