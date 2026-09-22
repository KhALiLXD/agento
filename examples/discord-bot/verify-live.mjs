// Read-only contract smoke test. No model calls, credentials, or booking writes.
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/index.js";
import { loadExampleConfig } from "../shared/config.mjs";

const config = await loadExampleConfig(
  new URL("./agent-config.yml", import.meta.url),
  {
    ...process.env,
    AGENTO_API_BASE_URL:
      process.env.AGENTO_API_BASE_URL ?? "http://127.0.0.1:3000",
    AGENTO_ALLOW_INSECURE_HTTP: "true",
  },
  { direct: true },
);
const calls = [];
const runtime = await AgentRuntime.create({
  config,
  fetch: async (url, init) => {
    assert.equal(init.method, "GET", "Live verifier prohibits all writes");
    const response = await fetch(url, init);
    calls.push({ path: new URL(url).pathname, status: response.status });
    return response;
  },
});
try {
  const request = { sessionId: "live_readonly" };
  let result = await runtime.invoke({
    ...request,
    tool: "search-services",
    arguments: { q: process.env.AGENTO_LIVE_QUERY ?? "Hair", limit: 5 },
  });
  assert.equal(result.status, "needs_selection", JSON.stringify(result.error));
  result = await runtime.select({
    ...request,
    selectionId: result.selection.id,
    choice: result.selection.options[0].id,
  });
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  const serviceId = result.data.service.id;
  result = await runtime.invoke({ ...request, tool: "get-service-variants" });
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.ok(Array.isArray(result.data) && result.data.length);
  assert.ok(result.data.every((variant) => variant.service_id === serviceId));
  const date =
    process.env.AGENTO_LIVE_DATE ??
    new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  result = await runtime.invoke({
    ...request,
    tool: "book-appointment",
    arguments: { date, notes: "Read-only verification; never submitted" },
  });
  for (let step = 0; result.status === "needs_selection" && step < 8; step++) {
    assert.ok(result.selection.options.length);
    result = await runtime.select({
      ...request,
      selectionId: result.selection.id,
      choice: result.selection.options[0].id,
    });
  }
  assert.equal(
    result.status,
    "needs_confirmation",
    JSON.stringify({
      status: result.status,
      missing: result.missing,
      error: result.error,
    }),
  );
  assert.equal(
    JSON.stringify(result.confirmation.preview).includes("slot_token"),
    false,
  );
  console.log(
    JSON.stringify(
      {
        verified: true,
        mode: "GET-only; confirmation NOT submitted",
        serviceId,
        preview: result.confirmation.preview,
        calls,
      },
      null,
      2,
    ),
  );
} finally {
  runtime.dispose();
}
