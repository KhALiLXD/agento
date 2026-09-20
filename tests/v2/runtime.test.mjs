import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/v2/runtime/agent-runtime.js";
import { MemorySessionStore } from "../../dist/v2/session/store.js";
const input = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const search = {
  id: "search",
  tool: {
    description: "Search hair services خدمات شعر",
    input_schema: input(
      {
        q: { type: "string" },
        limit: { type: "integer", minimum: 1, default: 10 },
      },
      ["q"],
    ),
  },
  request: {
    method: "GET",
    url: "https://api.test/search",
    map: { query: { q: "$.q", limit: "$.limit" } },
  },
};
const action = {
  id: "book",
  tool: {
    description: "Book an appointment",
    input_schema: input(
      { slot: { type: "string" }, notes: { type: "string" } },
      ["slot"],
    ),
  },
  request: {
    method: "POST",
    url: "https://api.test/book",
    map: { body: { slot: "$.slot", notes: "$.notes" } },
    auth: { type: "session" },
  },
  behavior: { effect: "side-effect", confirmation: { required: true } },
};
const create = (tools, options = {}) =>
  AgentRuntime.create({ config: { version: "2", tools }, ...options });
test("direct invocation: required query input, defaults and encoding, no model call", async () => {
  let url;
  const runtime = await create([search], {
    fetch: async (u) => {
      url = u;
      return Response.json({ ok: true });
    },
  });
  const missing = await runtime.invoke({ sessionId: "s", tool: "search" });
  assert.equal(missing.status, "needs_input");
  assert.deepEqual(missing.missing, ["/q"]);
  const r = await runtime.invoke({
    sessionId: "s",
    tool: "search",
    arguments: { q: "hair & nails" },
  });
  assert.equal(r.status, "completed");
  assert.equal(new URL(url).searchParams.get("q"), "hair & nails");
  assert.equal(new URL(url).searchParams.get("limit"), "10");
  assert.equal(r.meta.modelCalls, 0);
  runtime.dispose();
});
test("native chat uses one routing call, preserves arguments and validates required inputs", async () => {
  let calls = 0;
  const model = {
    capabilities: () => ({ nativeTools: true }),
    selectTool: async (r) => {
      calls++;
      assert.equal(r.tools[0].request, undefined);
      return {
        call: { name: "search", arguments: { q: "hair" } },
        usage: { inputTokens: 4, outputTokens: 2 },
      };
    },
  };
  const runtime = await create([search], {
    model,
    fetch: async () => Response.json(["hair"]),
  });
  const result = await runtime.chat({
    sessionId: "a",
    message: "hair services",
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 1);
  assert.equal(result.meta.modelCalls, 1);
  assert.equal(result.meta.toolCalls, 1);
  runtime.dispose();
});
test("action confirmation is explicit, session-bound, consumed once and yes cannot execute it", async () => {
  let calls = 0;
  const runtime = await create([action], {
    fetch: async () => {
      calls++;
      return Response.json({ id: 1 });
    },
  });
  const a = await runtime.invoke({
    sessionId: "a",
    tool: "book",
    arguments: { slot: "S1" },
    auth: { token: "private-secret" },
  });
  assert.equal(a.status, "needs_confirmation");
  assert.equal(calls, 0);
  const yes = await runtime.chat({ sessionId: "a", message: "yes" });
  assert.equal(yes.status, "needs_confirmation");
  assert.equal(calls, 0);
  const wrong = await runtime.confirm({
    sessionId: "b",
    confirmationId: a.confirmation.id,
    auth: { token: "private-secret" },
  });
  assert.equal(wrong.error.code, "CONFIRMATION_STALE");
  const results = await Promise.all([
    runtime.confirm({ sessionId: "a", confirmationId: a.confirmation.id }),
    runtime.confirm({ sessionId: "a", confirmationId: a.confirmation.id }),
  ]);
  assert.equal(results.filter((r) => r.status === "completed").length, 1);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(a).includes("private-secret"), false);
  runtime.dispose();
});
test("dependency selection, nested output mapping and authenticated booking resumes deterministically", async () => {
  const availability = {
    id: "availability",
    tool: {
      description: "Available slots",
      input_schema: input({ date: { type: "string", format: "date" } }, [
        "date",
      ]),
    },
    request: {
      method: "GET",
      url: "https://api.test/slots",
      map: { query: { date: "$.date" } },
    },
  };
  const book = structuredClone(action);
  book.tool.input_schema.properties.date = { type: "string", format: "date" };
  book.tool.input_schema.required.push("date");
  book.depends_on = [
    {
      tool: "availability",
      arguments: { date: "$.date" },
      select: {
        items_path: "$.data.slots",
        id_path: "$.code",
        label_path: "$.display",
      },
      map: { "$.slot": "$.code" },
    },
  ];
  let posted;
  const runtime = await create([availability, book], {
    fetch: async (u, init) =>
      u.includes("/slots")
        ? Response.json({
            data: {
              slots: [
                { code: "A", display: "10:00" },
                { code: "B", display: "11:00" },
              ],
            },
          })
        : ((posted = JSON.parse(init.body)), Response.json({ id: 42 })),
  });
  const first = await runtime.invoke({
    sessionId: "s",
    tool: "book",
    arguments: { date: "2026-10-01" },
    auth: { token: "secret" },
  });
  assert.equal(first.status, "needs_selection", JSON.stringify(first));
  const second = await runtime.select({
    sessionId: "s",
    selectionId: first.selection.id,
    choice: "B",
  });
  assert.equal(second.status, "needs_confirmation", JSON.stringify(second));
  assert.equal(second.confirmation.preview.slot, undefined);
  const final = await runtime.confirm({
    sessionId: "s",
    confirmationId: second.confirmation.id,
  });
  assert.equal(final.status, "completed");
  assert.equal(posted.slot, "B");
  runtime.dispose();
});
test("credentials never enter models, hooks, results or ordinary session state, and public tools get no auth", async () => {
  const store = new MemorySessionStore(),
    events = [],
    prompts = [];
  let headers;
  const model = {
    capabilities: () => ({ nativeTools: true }),
    selectTool: async (r) => {
      prompts.push(r);
      return {
        call: { name: "search", arguments: { q: "hair" } },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    generateText: async (r) => {
      prompts.push(r);
      return {
        text: "Echo secret-token",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const runtime = await create([search], {
    model,
    sessionStore: store,
    presentation: "both",
    onEvent: (e) => events.push(e),
    fetch: async (u, init) => {
      headers = init.headers;
      return Response.json({
        access_token: "secret-token",
        safe: "hair",
        nested: { password: "secret-token" },
        echo: "secret-token",
      });
    },
  });
  const r = await runtime.chat({
    sessionId: "s",
    message: "hair secret-token",
    auth: { token: "secret-token" },
  });
  assert.equal(r.status, "completed");
  assert.equal(headers.authorization, undefined);
  for (const value of [r, events, prompts, await store.get("s")])
    assert.equal(JSON.stringify(value).includes("secret-token"), false);
  runtime.dispose();
});
test("same session serialized across runtime instances sharing a store; different sessions run concurrently", async () => {
  const store = new MemorySessionStore();
  let active = 0,
    max = 0;
  const fetch = async () => {
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return Response.json({});
  };
  const a = await create([search], { sessionStore: store, fetch }),
    b = await create([search], { sessionStore: store, fetch });
  const req = { sessionId: "s", tool: "search", arguments: { q: "hair" } };
  await Promise.all([a.invoke(req), b.invoke(req)]);
  assert.equal(max, 1);
  max = 0;
  await Promise.all([a.invoke(req), b.invoke({ ...req, sessionId: "other" })]);
  assert.equal(max, 2);
  a.dispose();
  b.dispose();
});
test("configured rate limits and history bounds are enforced", async () => {
  const store = new MemorySessionStore();
  const runtime = await AgentRuntime.create({
    config: {
      version: "2",
      tools: [search],
      session: { max_history_messages: 2 },
      rate_limits: { messages: 2 },
    },
    sessionStore: store,
    fetch: async () => Response.json({}),
  });
  await runtime.chat({ sessionId: "s", message: "cancel" });
  await runtime.chat({ sessionId: "s", message: "cancel" });
  const r = await runtime.chat({ sessionId: "s", message: "cancel" });
  assert.equal(r.error.code, "RATE_LIMITED");
  assert.ok((await store.get("s")).history.length <= 2);
  runtime.dispose();
});
test("output schema rejection is distinct from routing errors", async () => {
  const t = structuredClone(search);
  t.response = { output_schema: input({ id: { type: "integer" } }, ["id"]) };
  const r = await create([t], {
    fetch: async () => Response.json({ id: "bad" }),
  });
  assert.equal(
    (
      await r.invoke({
        sessionId: "s",
        tool: "search",
        arguments: { q: "hair" },
      })
    ).error.code,
    "TOOL_OUTPUT_SCHEMA_VIOLATION",
  );
  r.dispose();
});
