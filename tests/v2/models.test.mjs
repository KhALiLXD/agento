import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderModel } from "../../dist/v2/models/providers.js";
import { compileConfig } from "../../dist/v2/config/compiler.js";
import { LexicalToolRetriever } from "../../dist/v2/tools/retriever.js";
import { ToolRouter } from "../../dist/v2/tools/router.js";
const definition = {
  name: "search",
  description: "Find products",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
    additionalProperties: false,
  },
};
for (const provider of ["openai", "anthropic", "mistral", "cohere", "ollama"]) {
  test(`${provider}: native tool protocol, system instructions, arguments, usage`, async () => {
    let captured;
    const payload =
      provider === "anthropic"
        ? {
            content: [
              { type: "tool_use", name: "search", input: { q: "hair" } },
            ],
            usage: { input_tokens: 3, output_tokens: 4 },
          }
        : provider === "ollama"
          ? {
              message: {
                tool_calls: [
                  { function: { name: "search", arguments: { q: "hair" } } },
                ],
              },
              prompt_eval_count: 3,
              eval_count: 4,
            }
          : provider === "cohere"
            ? {
                message: {
                  tool_calls: [
                    { function: { name: "search", arguments: '{"q":"hair"}' } },
                  ],
                },
                usage: { tokens: { input_tokens: 3, output_tokens: 4 } },
              }
            : {
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          function: {
                            name: "search",
                            arguments: '{"q":"hair"}',
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 3, completion_tokens: 4 },
              };
    const model = new ProviderModel(
      {
        provider,
        model: "fixture",
        api_key: provider === "ollama" ? undefined : "$ENV:KEY",
        timeout_ms: 1000,
      },
      {
        env: { KEY: "provider-secret" },
        fetch: async (url, init) => {
          captured = {
            url,
            body: JSON.parse(init.body),
            headers: init.headers,
          };
          return Response.json(payload);
        },
      },
    );
    const result = await model.selectTool({
      system: "Required instruction",
      messages: [{ role: "user", content: "hair" }],
      tools: [definition],
    });
    assert.equal(result.call.name, "search");
    assert.equal(result.call.arguments.q, "hair");
    assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4 });
    assert.equal(
      provider === "anthropic"
        ? captured.body.system
        : captured.body.messages[0].content,
      "Required instruction",
    );
    assert.equal(
      JSON.stringify(captured.body).includes("provider-secret"),
      false,
    );
    if (provider === "ollama")
      assert.equal(captured.body.options.temperature, 0);
    if (provider === "anthropic")
      assert.deepEqual(
        captured.body.tools[0].input_schema,
        definition.inputSchema,
      );
  });
  test(`${provider}: errors never contain provider response or credentials`, async () => {
    const model = new ProviderModel(
      {
        provider,
        model: "fixture",
        api_key: provider === "ollama" ? undefined : "$ENV:KEY",
        timeout_ms: 1000,
      },
      {
        env: { KEY: "secret" },
        fetch: async () => new Response("secret", { status: 401 }),
      },
    );
    await assert.rejects(
      model.generateText({ system: "s", messages: [] }),
      (e) =>
        e.code === "MODEL_PROVIDER_ERROR" &&
        !JSON.stringify(e).includes("secret"),
    );
  });
}
const config = {
  version: "2",
  tools: [
    {
      id: "search",
      tool: {
        description: "search hair products خدمات شعر",
        input_schema: definition.inputSchema,
      },
      trigger_hints: ["hair"],
      request: { method: "GET", url: "https://example.test" },
    },
  ],
};
test("routing is candidate constrained and bounded validated JSON fallback", async () => {
  const c = compileConfig(config),
    router = new ToolRouter(c, new LexicalToolRetriever(c));
  let calls = 0;
  const model = {
    capabilities: () => ({ nativeTools: false, structuredOutput: false }),
    generateText: async () => ({
      text:
        ++calls === 1 ? "bad" : '{"tool":"search","arguments":{"q":"hair"}}',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
  const r = await router.route(
    "hair",
    [{ role: "user", content: "hair" }],
    model,
    { onCall: async () => {}, onUsage: () => {} },
  );
  assert.equal(calls, 2);
  assert.equal(r.call.arguments.q, "hair");
  model.generateText = async () => ({
    text: "garbage",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  await assert.rejects(
    router.route("hair", [], model, {
      onCall: async () => {},
      onUsage: () => {},
    }),
    (e) => e.code === "MODEL_RESPONSE_MALFORMED",
  );
});
test("candidate retrieval supports Arabic, ties and no-match without model calls", async () => {
  const c = compileConfig(config),
    r = new LexicalToolRetriever(c);
  assert.equal((await r.retrieve("خدمات شعر", { limit: 1 }))[0].tool, "search");
  assert.deepEqual(await r.retrieve("unrelated zebra", { limit: 1 }), []);
});

for (const provider of ["openai", "anthropic", "mistral", "cohere", "ollama"])
  test(`${provider}: text protocol and usage`, async () => {
    const data =
      provider === "anthropic"
        ? {
            content: [{ type: "text", text: "answer" }],
            usage: { input_tokens: 1, output_tokens: 2 },
          }
        : provider === "cohere"
          ? {
              message: { content: [{ type: "text", text: "answer" }] },
              usage: { tokens: { input_tokens: 1, output_tokens: 2 } },
            }
          : provider === "ollama"
            ? {
                message: { content: "answer" },
                prompt_eval_count: 1,
                eval_count: 2,
              }
            : {
                choices: [{ message: { content: "answer" } }],
                usage: { prompt_tokens: 1, completion_tokens: 2 },
              };
    const model = new ProviderModel(
      {
        provider,
        model: "fixture",
        api_key: provider === "ollama" ? undefined : "$ENV:KEY",
        timeout_ms: 1000,
      },
      { env: { KEY: "secret" }, fetch: async () => Response.json(data) },
    );
    const r = await model.generateText({
      system: "sys",
      messages: [{ role: "user", content: "question" }],
    });
    assert.equal(r.text, "answer");
    assert.deepEqual(r.usage, { inputTokens: 1, outputTokens: 2 });
  });
for (const provider of ["openai", "mistral", "cohere", "ollama"])
  test(`${provider}: structured wire format and validation`, async () => {
    let body;
    const content = '{"value":3}',
      data =
        provider === "cohere"
          ? { message: { content: [{ type: "text", text: content }] } }
          : provider === "ollama"
            ? { message: { content } }
            : { choices: [{ message: { content } }] };
    const model = new ProviderModel(
      {
        provider,
        model: "fixture",
        api_key: provider === "ollama" ? undefined : "$ENV:KEY",
        timeout_ms: 1000,
      },
      {
        env: { KEY: "secret" },
        fetch: async (u, o) => {
          body = JSON.parse(o.body);
          return Response.json(data);
        },
      },
    );
    const schema = {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
    };
    const r = await model.generateStructured({
      system: "JSON",
      messages: [],
      schema,
    });
    assert.equal(r.data.value, 3);
    assert.deepEqual(
      provider === "ollama"
        ? body.format
        : provider === "cohere"
          ? body.response_format.schema
          : body.response_format.json_schema.schema,
      schema,
    );
    await assert.rejects(
      model.generateStructured({
        system: "JSON",
        messages: [],
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      }),
      (e) => e.code === "MODEL_SCHEMA_VIOLATION",
    );
  });
test("provider timeout, malformed envelope and multiple tool calls have explicit errors", async () => {
  const config = {
    provider: "openai",
    model: "fixture",
    api_key: "$ENV:KEY",
    timeout_ms: 5,
  };
  const timed = new ProviderModel(config, {
    env: { KEY: "secret" },
    fetch: async (u, o) =>
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
  });
  await assert.rejects(
    timed.generateText({ system: "s", messages: [] }),
    (e) => e.code === "MODEL_TIMEOUT",
  );
  for (const [data, code] of [
    [{ choices: [{ message: {} }] }, "MODEL_RESPONSE_MALFORMED"],
    [
      { choices: [{ message: { tool_calls: [{}, {}] } }] },
      "MODEL_TOOL_SELECTION_FAILED",
    ],
  ]) {
    const model = new ProviderModel(config, {
      env: { KEY: "secret" },
      fetch: async () => Response.json(data),
    });
    await assert.rejects(
      model.selectTool({ system: "s", messages: [], tools: [definition] }),
      (e) => e.code === code,
    );
  }
});
test("fallback retries valid JSON with schema-invalid arguments instead of hiding the error", async () => {
  const c = compileConfig({
    version: "2",
    tools: [
      {
        id: "search",
        tool: {
          description: "search hair",
          input_schema: definition.inputSchema,
        },
        request: { method: "GET", url: "https://example.test" },
      },
    ],
  });
  let calls = 0;
  const model = {
    capabilities: () => ({ nativeTools: false, structuredOutput: false }),
    generateText: async () => ({
      text: JSON.stringify({
        tool: "search",
        arguments: { q: ++calls === 1 ? 42 : "hair" },
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
  const result = await new ToolRouter(c, new LexicalToolRetriever(c)).route(
    "search hair",
    [],
    model,
    { onCall: async () => {}, onUsage: () => {} },
  );
  assert.equal(calls, 2);
  assert.equal(result.call.arguments.q, "hair");
});
