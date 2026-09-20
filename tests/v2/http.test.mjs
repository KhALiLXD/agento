import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/v2/runtime/agent-runtime.js";
const t = (method = "GET", extra = {}) => ({
  id: "tool",
  tool: {
    description: "test",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  request: { method, url: "https://api.test", ...extra },
  ...(method === "GET" || method === "HEAD"
    ? {}
    : {
        behavior: { effect: "side-effect", confirmation: { required: true } },
      }),
});
const run = async (tool, fetch, extra = {}) => {
  const runtime = await AgentRuntime.create({
    config: { version: "2", tools: [tool] },
    fetch,
    ...extra,
  });
  let r = await runtime.invoke({ sessionId: "s", tool: "tool" });
  if (r.status === "needs_confirmation")
    r = await runtime.confirm({
      sessionId: "s",
      confirmationId: r.confirmation.id,
    });
  runtime.dispose();
  return r;
};
test("GET retries transient failures with configured bound", async () => {
  let calls = 0;
  const r = await run(
    t("GET", { retry: { attempts: 3, backoff_ms: 0 } }),
    async () =>
      ++calls < 3
        ? new Response("", { status: 503 })
        : Response.json({ ok: true }),
  );
  assert.equal(calls, 3);
  assert.equal(r.status, "completed");
  assert.equal(r.meta.retryCount, 2);
});
test("POST never retries without explicit idempotency", async () => {
  let calls = 0;
  const r = await run(
    t("POST", { retry: { attempts: 3, backoff_ms: 0 } }),
    async () => {
      calls++;
      return new Response("", { status: 503 });
    },
  );
  assert.equal(calls, 1);
  assert.equal(r.error.code, "TOOL_SERVER_ERROR");
});
test("idempotency header stays identical across action attempts", async () => {
  const keys = [];
  const r = await run(
    t("POST", { retry: { attempts: 3, backoff_ms: 0 }, idempotency: {} }),
    async (u, o) => {
      keys.push(o.headers["Idempotency-Key"]);
      return keys.length < 2
        ? new Response("", { status: 503 })
        : Response.json({});
    },
  );
  assert.equal(r.status, "completed");
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});
for (const method of ["HEAD", "PUT", "PATCH", "DELETE"])
  test(method + " handles 204", async () => {
    const r = await run(
      t(method),
      async () => new Response(null, { status: 204 }),
    );
    assert.equal(r.status, "completed");
    assert.equal(r.data, null);
  });
test("redirects never get followed", async () => {
  let init;
  const r = await run(t(), async (u, o) => {
    init = o;
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.test" },
    });
  });
  assert.equal(init.redirect, "manual");
  assert.equal(r.error.code, "TOOL_REDIRECT_BLOCKED");
});
test("malformed JSON and oversized responses are distinguished", async () => {
  assert.equal(
    (
      await run(
        t(),
        async () =>
          new Response("{bad", {
            headers: { "content-type": "application/json" },
          }),
      )
    ).error.code,
    "TOOL_RESPONSE_MALFORMED",
  );
  assert.equal(
    (
      await run(t("GET", { max_response_bytes: 3 }), async () =>
        Response.json({ large: "xxxx" }),
      )
    ).error.code,
    "TOOL_OUTPUT_LIMIT",
  );
});
test("timeouts cancel fetch and surface precise error", async () => {
  const r = await run(
    t("GET", { timeout_ms: 10 }),
    async (u, o) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({})), 100);
        o.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(o.signal.reason);
          },
          { once: true },
        );
      }),
  );
  assert.equal(r.error.code, "TOOL_TIMEOUT");
});
test("client failures do not open circuit; server failures do", async () => {
  let status = 400,
    calls = 0;
  const runtime = await AgentRuntime.create({
    config: {
      version: "2",
      tools: [t("GET", { circuit_breaker: { threshold: 2 } })],
    },
    fetch: async () => {
      calls++;
      return new Response("", { status });
    },
  });
  for (let i = 0; i < 3; i++)
    assert.equal(
      (await runtime.invoke({ sessionId: "s", tool: "tool" })).error.code,
      "TOOL_CLIENT_ERROR",
    );
  status = 503;
  for (let i = 0; i < 2; i++)
    await runtime.invoke({ sessionId: "s", tool: "tool" });
  assert.equal(
    (await runtime.invoke({ sessionId: "s", tool: "tool" })).error.code,
    "TOOL_CIRCUIT_OPEN",
  );
  assert.equal(calls, 5);
  runtime.dispose();
});
