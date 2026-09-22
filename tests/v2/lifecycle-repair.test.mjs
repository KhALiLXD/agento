import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, MemorySessionStore } from "../../dist/v2/index.js";

const input = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const tools = () => [
  {
    id: "availability",
    tool: {
      description: "Find availability",
      input_schema: input({ date: { type: "string" } }, ["date"]),
    },
    request: {
      method: "GET",
      url: "https://api.test/slots",
      map: { query: { date: "$.date" } },
    },
    response: { private_fields: ["execution_token"] },
  },
  {
    id: "book",
    trigger_hints: ["change date"],
    tool: {
      description: "Book",
      input_schema: input(
        {
          date: { type: "string" },
          slot: { type: "string" },
          notes: { type: "string" },
        },
        ["date", "slot"],
      ),
    },
    request: {
      method: "POST",
      url: "https://api.test/book",
      map: { body: { token: "$.slot", notes: "$.notes" } },
    },
    behavior: {
      effect: "side-effect",
      confirmation: {
        required: true,
        preview: {
          date: "$.date",
          notes: "$.notes",
          time: { source: "selection", path: "$.time" },
          amount: { source: "selection", path: "$.amount" },
        },
      },
      recovery: { refresh_dependency: "availability" },
    },
    depends_on: [
      {
        tool: "availability",
        when: "missing",
        arguments: { date: "$.date" },
        select: {
          items_path: "$",
          id_path: "$.execution_token",
          id_sensitive: true,
          label_path: "$.label",
          facts: { time: "$.label", amount: "$.price" },
        },
        map: { "$.slot": "$.execution_token" },
      },
    ],
  },
];

test("private selection IDs and option facts never send executable tokens to model or public result", async () => {
  const store = new MemorySessionStore();
  const prompts = [];
  const runtime = await AgentRuntime.create({
    config: {
      version: "2",
      tools: tools(),
      routing: { semantic_recall: { enabled: false } },
    },
    sessionStore: store,
    model: {
      capabilities: () => ({ nativeTools: true }),
      selectTool: async () => ({ call: null, usage: {} }),
      generateText: async (request) => {
        prompts.push(request);
        return { text: "The second option costs 20.", usage: {} };
      },
    },
    fetch: async () =>
      Response.json([
        { execution_token: "private-one", label: "10:00", price: 10 },
        { execution_token: "private-two", label: "11:00", price: 20 },
      ]),
  });
  try {
    const first = await runtime.invoke({
      sessionId: "s",
      tool: "book",
      arguments: { date: "2026-10-01", notes: "quiet" },
    });
    const expiry = first.selection.expiresAt;
    assert.equal(JSON.stringify(first).includes("private-"), false);
    const detour = await runtime.chat({
      sessionId: "s",
      message: "How much is the second?",
    });
    assert.equal(detour.selection.id, first.selection.id);
    assert.equal(detour.selection.expiresAt, expiry);
    assert.equal(JSON.stringify(prompts).includes("private-"), false);
    assert.match(JSON.stringify(prompts), /20/);
    const confirmation = await runtime.select({
      sessionId: "s",
      selectionId: first.selection.id,
      choice: first.selection.options[1].id,
    });
    assert.deepEqual(confirmation.confirmation.preview, {
      date: "2026-10-01",
      notes: "quiet",
      time: "11:00",
      amount: 20,
    });
    assert.ok(confirmation.confirmation.expiresAt <= expiry);
  } finally {
    runtime.dispose();
  }
});

for (const status of [409, 410])
  test(`HTTP ${status} refreshes only reads and requires a new confirmation`, async () => {
    let reads = 0,
      writes = 0;
    const runtime = await AgentRuntime.create({
      config: { version: "2", tools: tools() },
      fetch: async (url) => {
        if (new URL(url).pathname === "/slots") {
          reads++;
          return Response.json([
            { execution_token: "slot-" + reads, label: "10:00", price: 20 },
          ]);
        }
        writes++;
        return new Response("{}", { status });
      },
    });
    try {
      const first = await runtime.invoke({
        sessionId: "s",
        tool: "book",
        arguments: { date: "2026-10-01" },
      });
      const refreshed = await runtime.confirm({
        sessionId: "s",
        confirmationId: first.confirmation.id,
      });
      assert.equal(
        refreshed.status,
        "needs_confirmation",
        JSON.stringify(refreshed),
      );
      assert.notEqual(refreshed.confirmation.id, first.confirmation.id);
      assert.equal(writes, 1);
      assert.equal(reads, 2);
      const old = await runtime.confirm({
        sessionId: "s",
        confirmationId: first.confirmation.id,
      });
      assert.equal(old.error.code, "CONFIRMATION_STALE");
      assert.equal(writes, 1);
    } finally {
      runtime.dispose();
    }
  });

test("editing pending date invalidates old slot while preserving notes", async () => {
  const dates = [];
  const runtime = await AgentRuntime.create({
    config: { version: "2", tools: tools() },
    model: {
      capabilities: () => ({ nativeTools: true }),
      selectTool: async () => ({
        call: { name: "book", arguments: { date: "2026-10-02" } },
        usage: {},
      }),
    },
    fetch: async (url) => {
      dates.push(new URL(url).searchParams.get("date"));
      return Response.json([
        { execution_token: "slot-" + dates.length, label: "10:00", price: 20 },
      ]);
    },
  });
  try {
    const first = await runtime.invoke({
      sessionId: "s",
      tool: "book",
      arguments: { date: "2026-10-01", notes: "quiet" },
    });
    const changed = await runtime.chat({
      sessionId: "s",
      message: "change date to tomorrow",
    });
    assert.equal(changed.status, "needs_confirmation", JSON.stringify(changed));
    assert.deepEqual(dates, ["2026-10-01", "2026-10-02"]);
    assert.equal(changed.confirmation.preview.notes, "quiet");
    assert.notEqual(changed.confirmation.id, first.confirmation.id);
  } finally {
    runtime.dispose();
  }
});
