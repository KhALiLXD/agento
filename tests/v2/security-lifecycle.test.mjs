import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentRuntime,
  MemorySessionStore,
  compileConfig,
} from "../../dist/v2/index.js";
import { redact } from "../../dist/v2/security/redactor.js";
const empty = { type: "object", properties: {} };
const publicTool = {
  id: "read",
  tool: { description: "read data", input_schema: empty },
  request: { method: "GET", url: "https://api.test/read" },
};
const action = {
  id: "act",
  tool: { description: "act", input_schema: empty },
  request: { method: "POST", url: "https://api.test/action" },
  behavior: { effect: "side-effect", confirmation: { required: true } },
};
const create = (tools, extra = {}) =>
  AgentRuntime.create({ config: { version: "2", tools }, ...extra });
test("expired confirmation, changed context, cancellation, and stale replay cannot execute", async () => {
  let calls = 0;
  const store = new MemorySessionStore(),
    runtime = await create([action], {
      sessionStore: store,
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    });
  let r = await runtime.invoke({ sessionId: "s", tool: "act" });
  let s = await store.get("s");
  s.confirmation.expiresAt = 0;
  await store.set("s", s);
  assert.equal(
    (
      await runtime.confirm({
        sessionId: "s",
        confirmationId: r.confirmation.id,
      })
    ).error.code,
    "CONFIRMATION_STALE",
  );
  r = await runtime.invoke({
    sessionId: "s",
    tool: "act",
    context: { tenant: "a" },
  });
  assert.equal(
    (
      await runtime.confirm({
        sessionId: "s",
        confirmationId: r.confirmation.id,
        context: { tenant: "b" },
      })
    ).error.code,
    "CONFIRMATION_STALE",
  );
  r = await runtime.invoke({ sessionId: "s", tool: "act" });
  await runtime.cancel({ sessionId: "s" });
  assert.equal(
    (
      await runtime.confirm({
        sessionId: "s",
        confirmationId: r.confirmation.id,
      })
    ).error.code,
    "CONFIRMATION_STALE",
  );
  assert.equal(calls, 0);
  runtime.dispose();
});
test("crash marker prevents implicit replay and session expiry removes state", async () => {
  const store = new MemorySessionStore(),
    runtime = await create([publicTool], {
      sessionStore: store,
      fetch: async () => Response.json({}),
    });
  await runtime.invoke({ sessionId: "s", tool: "read" });
  let s = await store.get("s");
  s.state = "EXECUTING";
  await store.set("s", s);
  assert.equal(
    (await runtime.invoke({ sessionId: "s", tool: "read" })).error.code,
    "TOOL_EXECUTION_UNCERTAIN",
  );
  s.expiresAt = 0;
  await store.set("s", s);
  assert.equal(
    (await runtime.invoke({ sessionId: "s", tool: "read" })).error.code,
    "SESSION_EXPIRED",
  );
  assert.equal(await store.get("s"), null);
  runtime.dispose();
});
test("redactor preserves normal strings and runtime IDs while removing nested credential names", () => {
  const value = redact({
    keyboard: "normal",
    token_count: 20,
    request_id: "r",
    slot_token: "slot",
    nested: { refreshToken: "bad", cookie: "bad" },
    note: "password=hunter2 Bearer abc.def",
  });
  assert.equal(value.keyboard, "normal");
  assert.equal(value.token_count, 20);
  assert.equal(value.slot_token, "slot");
  assert.equal(value.nested.refreshToken, "[REDACTED]");
  assert.equal(JSON.stringify(value).includes("hunter2"), false);
});
test("known secrets in config descriptions, instructions, user messages and API strings never reach a model", async () => {
  const seen = [];
  const secret = "private-server-key";
  const t = structuredClone(publicTool);
  t.tool.description += " " + secret;
  t.request.auth = { type: "api-key", env: "KEY" };
  t.response = { instructions: "Present " + secret };
  const model = {
    capabilities: () => ({ nativeTools: true, structuredOutput: true }),
    generateStructured: async (r) => {
      seen.push(r);
      return {
        data: { candidates: ["read"] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    selectTool: async (r) => {
      seen.push(r);
      return {
        call: { name: "read", arguments: {} },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    generateText: async (r) => {
      seen.push(r);
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runtime = await create([t], {
    env: { KEY: secret },
    model,
    presentation: "both",
    fetch: async () => Response.json({ echo: secret }),
  });
  assert.equal(
    (await runtime.chat({ sessionId: "s", message: "read " + secret })).status,
    "completed",
  );
  assert.equal(JSON.stringify(seen).includes(secret), false);
  assert.equal(JSON.stringify(runtime.getConfig()).includes(secret), false);
  runtime.dispose();
});
test("prototype and nested credential properties are rejected at compilation", () => {
  for (const properties of [
    JSON.parse('{"__proto__":{"type":"string"}}'),
    { user: { type: "object", properties: { password: { type: "string" } } } },
  ]) {
    const t = structuredClone(publicTool);
    t.tool.input_schema.properties = properties;
    assert.throws(
      () => compileConfig({ version: "2", tools: [t] }),
      (e) => e.code === "CONFIG_SCHEMA_INVALID",
    );
  }
});
test("presentation failure retains completed side-effect data and never suggests replay", async () => {
  let calls = 0;
  const runtime = await create([action], {
    presentation: "ai",
    presentationModel: {
      generateText: async () => {
        throw Error("provider failed");
      },
    },
    fetch: async () => {
      calls++;
      return Response.json({ id: 9 });
    },
  });
  const first = await runtime.invoke({ sessionId: "s", tool: "act" });
  const r = await runtime.confirm({
    sessionId: "s",
    confirmationId: first.confirmation.id,
  });
  assert.equal(r.status, "completed");
  assert.equal(r.data.id, 9);
  assert.equal(calls, 1);
  runtime.dispose();
});
test("transport credentials are opaque and the API owns authentication decisions", async () => {
  const t = structuredClone(publicTool);
  t.request.auth = { type: "session" };
  const headers = [];
  const runtime = await create([t], {
    fetch: async (_url, init) => {
      headers.push(init.headers.authorization);
      if (!init.headers.authorization)
        return new Response(JSON.stringify({ error: "login required" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      return Response.json({ ok: true });
    },
  });
  assert.equal(
    (
      await runtime.invoke({
        sessionId: "a",
        tool: "read",
        auth: { token: "opaque-token:alice" },
      })
    ).status,
    "completed",
  );
  assert.equal(headers[0], "Bearer opaque-token:alice");
  assert.equal(
    (
      await runtime.invoke({
        sessionId: "a",
        tool: "read",
        auth: { token: "opaque-token:bob" },
      })
    ).status,
    "completed",
  );
  assert.equal(headers[1], "Bearer opaque-token:bob");
  assert.equal(
    (await runtime.invoke({ sessionId: "b", tool: "read" })).error.code,
    "AUTH_REJECTED",
  );
  assert.equal(headers[2], undefined);
  runtime.dispose();
});
test("dependency facts are reused only while valid and invalidated by expiry", async () => {
  const store = new MemorySessionStore();
  let reads = 0;
  const parent = {
    id: "parent",
    tool: {
      description: "parent",
      input_schema: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
      },
    },
    request: { method: "GET", url: "https://api.test/parent" },
    depends_on: [{ tool: "read", map: { "$.id": "$.id" } }],
  };
  const runtime = await create([publicTool, parent], {
    sessionStore: store,
    fetch: async (u) => {
      if (u.endsWith("/read")) reads++;
      return Response.json({ id: 5 });
    },
  });
  await runtime.invoke({ sessionId: "s", tool: "parent" });
  await runtime.invoke({ sessionId: "s", tool: "parent" });
  assert.equal(reads, 1);
  const s = await store.get("s");
  for (const f of Object.values(s.facts)) f.expiresAt = 0;
  await store.set("s", s);
  await runtime.invoke({ sessionId: "s", tool: "parent" });
  assert.equal(reads, 2);
  runtime.dispose();
});
test("zero transcript retention still routes the current message", async () => {
  let content;
  const runtime = await AgentRuntime.create({
    config: {
      version: "2",
      tools: [publicTool],
      session: { max_history_messages: 0 },
    },
    model: {
      capabilities: () => ({ nativeTools: true }),
      selectTool: async (r) => {
        content = r.messages[0].content;
        return {
          call: { name: "read", arguments: {} },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
    fetch: async () => Response.json({}),
  });
  await runtime.chat({ sessionId: "s", message: "read data" });
  assert.equal(content, "read data");
  runtime.dispose();
});

test("tampering with a prepared request invalidates confirmation", async () => {
  const store = new MemorySessionStore();
  let calls = 0;
  const runtime = await create([action], {
    sessionStore: store,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  const first = await runtime.invoke({ sessionId: "s", tool: "act" });
  const state = await store.get("s");
  state.confirmation.prepared.body = '{"amount":9000}';
  await store.set("s", state);
  assert.equal(
    (
      await runtime.confirm({
        sessionId: "s",
        confirmationId: first.confirmation.id,
      })
    ).error.code,
    "CONFIRMATION_STALE",
  );
  assert.equal(calls, 0);
  runtime.dispose();
});
test("selection cannot cross changed context and action previews omit internal dependency inputs", async () => {
  const dep = {
    id: "items",
    tool: { description: "items", input_schema: empty },
    request: { method: "GET", url: "https://api.test/items" },
  };
  const parent = {
    ...action,
    tool: {
      description: "act",
      input_schema: {
        type: "object",
        properties: { internal_id: { type: "string" } },
        required: ["internal_id"],
      },
    },
    depends_on: [
      {
        tool: "items",
        select: { items_path: "$", id_path: "$.id", label_path: "$.label" },
        map: { "$.internal_id": "$.id" },
      },
    ],
  };
  const runtime = await create([dep, parent], {
    fetch: async () =>
      Response.json([
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ]),
  });
  const r = await runtime.invoke({
    sessionId: "s",
    tool: "act",
    context: { tenant: "a" },
  });
  assert.equal(r.status, "needs_selection");
  const changed = await runtime.select({
    sessionId: "s",
    selectionId: r.selection.id,
    choice: "one",
    context: { tenant: "b" },
  });
  assert.equal(changed.error.code, "INPUT_SELECTION_STALE");
  const again = await runtime.invoke({
    sessionId: "s",
    tool: "act",
    context: { tenant: "a" },
  });
  const confirmed = await runtime.select({
    sessionId: "s",
    selectionId: again.selection.id,
    choice: "one",
  });
  assert.equal(confirmed.status, "needs_confirmation");
  assert.deepEqual(confirmed.confirmation.preview, {});
  runtime.dispose();
});
test("model-view projection enforces object field allowlist and character limits", async () => {
  const t = structuredClone(publicTool);
  t.response = {
    model_view: { path: "$.data", include: ["title"], max_chars: 40 },
  };
  let request;
  const runtime = await create([t], {
    presentation: "both",
    presentationModel: {
      generateText: async (r) => {
        request = r;
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
    fetch: async () =>
      Response.json({
        data: { title: "a".repeat(200), private: "private-data" },
      }),
  });
  assert.equal(
    (await runtime.invoke({ sessionId: "s", tool: "read" })).status,
    "completed",
  );
  assert.equal(JSON.stringify(request).includes("private-data"), false);
  assert.equal(JSON.parse(request.messages[0].content).preview.length, 40);
  runtime.dispose();
});
test("failed confirmed transport marks possible side effects without exposing error bodies", async () => {
  const runtime = await create([action], {
    fetch: async () => {
      throw new Error("secret raw transport error");
    },
  });
  const first = await runtime.invoke({ sessionId: "s", tool: "act" });
  const result = await runtime.confirm({
    sessionId: "s",
    confirmationId: first.confirmation.id,
  });
  assert.equal(result.error.details.executionMayHaveOccurred, true);
  assert.equal(JSON.stringify(result).includes("secret raw"), false);
  runtime.dispose();
});
