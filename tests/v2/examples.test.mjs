import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  AgentRuntime,
  LexicalToolRetriever,
  compileConfig,
} from "../../dist/index.js";
import { loadExampleConfig } from "../../examples/shared/config.mjs";

const root = new URL("../../", import.meta.url);
const paths = [
  "examples/discord-bot/agent-config.yml",
  "examples/travel-agent/agent-config.yml",
  "examples/v2/catalog.yml",
  "examples/v2/booking.yml",
];
for (const file of paths)
  test(`live example ${file} compiles and can invoke without a model in direct mode`, async () => {
    const env = {
      OPENAI_API_KEY: "test-model-key",
      AGENTO_API_BASE_URL: "https://real-api.test",
    };
    const config = await loadExampleConfig(new URL(file, root), env);
    assert.ok(compileConfig(config, env).tools.size >= 3);
    const direct = await loadExampleConfig(
      new URL(file, root),
      { AGENTO_API_BASE_URL: env.AGENTO_API_BASE_URL },
      { direct: true },
    );
    assert.equal(direct.models, undefined);
    assert.ok(compileConfig(direct, {}).tools.size >= 3);
  });
test("URL override cannot inject YAML or change provider origin; HTTP auth requires explicit development opt-in", async () => {
  const file = new URL(paths[0], root);
  const noOptIn = await loadExampleConfig(file, {}, { direct: true });
  assert.throws(() => compileConfig(noOptIn), { code: "CONFIG_AUTH_INVALID" });
  const config = await loadExampleConfig(
    file,
    {
      AGENTO_API_BASE_URL: "http://localhost:3011",
      AGENTO_ALLOW_INSECURE_HTTP: "true",
    },
    { direct: true },
  );
  assert.equal(compileConfig(config).tools.size, 10);
  assert.equal(
    config.tools.find((t) => t.id === "get-service-employees").request.url,
    "http://localhost:3011/api/catalog/services/{service_id}/employees",
  );
  await assert.rejects(
    loadExampleConfig(file, {
      AGENTO_API_BASE_URL: "https://secret@example.test",
    }),
    /without credentials/,
  );
});
test("current salon tools compile with the scheduling flow and keep private slot data host-controlled", async () => {
  const config = await loadExampleConfig(
    new URL(paths[0], root),
    { AGENTO_API_BASE_URL: "https://real-api.test" },
    { direct: true },
  );
  const c = compileConfig(config);
  assert.deepEqual(
    c.tools
      .values()
      .map((t) => t.name)
      .sort(),
    [
      "search-services",
      "get-categories",
      "get-groups",
      "get-services",
      "get-service-details",
      "get-service-employees",
      "resolve-service-for-scheduling",
      "load-schedule-slots",
      "commit-selected-slot",
      "get-my-appointments",
    ].sort(),
  );
  const schedulingEntry = c.executions.get(
    "resolve-service-for-scheduling",
  ).config;
  assert.equal(schedulingEntry.navigates_to?.tool, "load-schedule-slots");

  const availability = c.executions.get("load-schedule-slots").config;
  assert.deepEqual(availability.selection, {
    items_path: "$.slots",
    id_path: "$.slot_token",
    label_path: "$.start_time",
    id_sensitive: true,
    facts: { appointment_time: "$.start_at", local_time: "$.start_time" },
  });
  assert.equal(availability.request.map.query.variant_ids, "$.variant_id");
  assert.equal(availability.navigates_to?.tool, "commit-selected-slot");

  const commit = c.executions.get("commit-selected-slot").config;
  assert.equal(commit.behavior.effect, "side-effect");
  assert.equal(commit.behavior.confirmation.required, true);
  assert.deepEqual(commit.request.map.body, {
    slot_token: "$.slot_token",
    notes: "$.notes",
  });
  assert.equal(
    "slot_token" in c.tools.get("commit-selected-slot").inputSchema.properties,
    false,
  );
});
test("salon Arabic requests have lexical candidates before semantic recall", async () => {
  const config = await loadExampleConfig(
    new URL(paths[0], root),
    { AGENTO_API_BASE_URL: "https://real-api.test" },
    { direct: true },
  );
  const retriever = new LexicalToolRetriever(compileConfig(config));
  for (const message of [
    "شو خدمات الشعر عندكم؟",
    "بدي احجز صبغة بكرة",
    "عندكم مناكير؟",
  ])
    assert.ok(
      (await retriever.retrieve(message, { limit: 8 })).length > 0,
      message,
    );
});
test("salon navigation preserves selected IDs, obtains slot data from the API and confirms one real HTTP request", async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      auth: req.headers.authorization,
    });
    res.setHeader("content-type", "application/json");
    let data;
    if (url.pathname.endsWith("/categories"))
      data = [{ id: 1, slug: "hair", name_ar: "Hair" }];
    else if (url.pathname.endsWith("/categories/hair/groups"))
      data = { groups: [{ id: 7, name_ar: "Coloring" }] };
    else if (url.pathname.endsWith("/groups/7/services"))
      data = { ok: true, services: [{ id: 9, name_ar: "Hair color" }] };
    else if (url.pathname.endsWith("/services/search"))
      data = { services: [{ id: 9, name_ar: "Hair color" }] };
    else if (url.pathname.endsWith("/services/9"))
      data = {
        ok: true,
        service: {
          id: 9,
          name_ar: "Hair color",
          ServiceVariants: [
            {
              id: 12,
              service_id: 9,
              name_ar: "Full color",
              price: "20.00",
              duration_minutes: 25,
            },
            {
              id: 13,
              service_id: 9,
              name_ar: "Roots",
              price: "21.00",
              duration_minutes: 20,
            },
          ],
        },
      };
    else if (url.pathname.endsWith("/availability"))
      data = {
        slots: [
          {
            slot_token: "slot-from-api-1",
            start_time: "10:00",
            start_at: "2026-10-01T10:00:00Z",
          },
          {
            slot_token: "slot-from-api-2",
            start_time: "11:00",
            start_at: "2026-10-01T11:00:00Z",
          },
        ],
      };
    else if (url.pathname.endsWith("/from-availability")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.at(-1).body = JSON.parse(body);
      data = { booking_id: 88 };
    } else {
      res.statusCode = 404;
      data = { error: "not found" };
    }
    res.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const config = await loadExampleConfig(
    new URL(paths[0], root),
    {
      AGENTO_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      AGENTO_ALLOW_INSECURE_HTTP: "true",
    },
    { direct: true },
  );
  const runtime = await AgentRuntime.create({ config });
  t.after(() => runtime.dispose());
  let r = await runtime.invoke({ sessionId: "s", tool: "get-categories" });
  for (const choice of ["1", "7", "9"]) {
    assert.equal(r.status, "needs_selection");
    r = await runtime.select({
      sessionId: "s",
      selectionId: r.selection.id,
      choice,
    });
  }
  assert.equal(r.status, "completed");
  assert.equal(r.data.service.id, 9);
  assert.deepEqual(
    calls.map((c) => c.path),
    [
      "/api/catalog/categories",
      "/api/catalog/categories/hair/groups",
      "/api/catalog/groups/7/services",
      "/api/catalog/services/9",
    ],
  );
  calls.length = 0;
  r = await runtime.invoke({
    sessionId: "booking",
    tool: "resolve-service-for-scheduling",
    arguments: {
      q: "Hair color",
      date: "2026-10-01",
      notes: "quiet",
    },
    auth: { token: "user:opaque" },
  });

  // The service name matches exactly, so scheduling advances to variant choice.
  assert.equal(r.status, "needs_selection");
  assert.equal(r.selection.options.some((option) => option.id === "13"), true);

  r = await runtime.select({
    sessionId: "booking",
    selectionId: r.selection.id,
    choice: "13",
  });

  // Slot IDs are sensitive, so select by the public opaque option ID.
  assert.equal(r.status, "needs_selection");
  const eleven = r.selection.options.find((option) => option.label === "11:00");
  assert.ok(eleven);
  assert.notEqual(eleven.id, "slot-from-api-2");

  r = await runtime.select({
    sessionId: "booking",
    selectionId: r.selection.id,
    choice: eleven.id,
  });

  assert.equal(r.status, "needs_confirmation");
  const confirmationId = r.confirmation.id;
  assert.equal(
    calls.filter((c) => c.path.endsWith("/from-availability")).length,
    0,
  );

  r = await runtime.confirm({ sessionId: "booking", confirmationId });
  assert.equal(r.status, "completed");
  assert.deepEqual(calls.at(-1).body, {
    slot_token: "slot-from-api-2",
    notes: "quiet",
  });
  assert.equal(calls.at(-1).auth, "Bearer user:opaque");
  assert.equal(
    calls.find((c) => c.path.endsWith("/availability")).query.variant_ids,
    "13",
  );
  assert.deepEqual(
    calls.map((c) => c.path),
    [
      "/api/catalog/services/search",
      "/api/catalog/services/9",
      "/api/availability",
      "/api/bookings/from-availability",
    ],
  );
  assert.equal(
    (await runtime.confirm({ sessionId: "booking", confirmationId })).error
      .code,
    "CONFIRMATION_STALE",
  );
  assert.equal(
    calls.filter((c) => c.path.endsWith("/from-availability")).length,
    1,
  );
});
