import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/v2/runtime/agent-runtime.js";
import { compileConfig } from "../../dist/v2/config/compiler.js";
import { LexicalToolRetriever } from "../../dist/v2/tools/retriever.js";

const emptyInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const categories = {
  id: "get-categories",
  tool: {
    title: "Browse Categories",
    description: "Browse the available service categories.",
    input_schema: emptyInput,
  },
  trigger_hints: ["browse categories"],
  request: {
    method: "GET",
    url: "https://private.example.test/categories",
  },
};
const search = {
  id: "search-services",
  tool: {
    title: "Search Services",
    description: "Search services by treatment, body area, or beauty need.",
    input_schema: {
      type: "object",
      properties: { q: { type: "string", minLength: 1 } },
      required: ["q"],
      additionalProperties: false,
    },
  },
  keywords: { "hair care": 2 },
  request: {
    method: "GET",
    url: "https://private.example.test/search",
    map: { query: { q: "$.q" } },
  },
};
const schedule = {
  id: "check-schedule",
  tool: {
    title: "Check Schedule",
    description: "Check the schedule for a requested date.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", format: "date" } },
      required: ["date"],
      additionalProperties: false,
    },
  },
  trigger_hints: ["check schedule"],
  request: {
    method: "GET",
    url: "https://private.example.test/schedule",
    map: { query: { date: "$.date" } },
  },
};

function multilingualModel(seen) {
  return {
    capabilities: () => ({
      nativeTools: true,
      structuredOutput: true,
    }),
    generateStructured: async (request) => {
      seen.push({ kind: "recall", request });
      const message = request.messages.at(-1)?.content ?? "";
      const candidates = /الأقسام|خدماتكم|catégories/i.test(message)
        ? ["get-categories", "invented-tool"]
        : /للشعر|للشَّعر/i.test(message)
          ? ["search-services"]
          : [];
      return {
        data: { candidates },
        usage: { inputTokens: 2, outputTokens: 1 },
      };
    },
    selectTool: async (request) => {
      seen.push({ kind: "selection", request });
      const message = request.messages.at(-1)?.content ?? "";
      if (/كيفك|how are you/i.test(message))
        return {
          call: null,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      const name = request.tools[0].name;
      const args =
        name === "search-services"
          ? { q: "شعر" }
          : name === "check-schedule" && /2026-10-01/.test(message)
            ? { date: "2026-10-01" }
            : {};
      return {
        call: { name, arguments: args },
        usage: { inputTokens: 2, outputTokens: 1 },
      };
    },
    generateText: async (request) => {
      seen.push({ kind: "conversation", request });
      const message = request.messages.at(-1)?.content ?? "";
      return {
        text: /[\u0600-\u06ff]/u.test(message)
          ? "أهلًا! كيف أقدر أساعدك؟"
          : "Hi! How can I help?",
        usage: { inputTokens: 2, outputTokens: 2 },
      };
    },
  };
}

const makeConfig = (extra = {}) => ({
  version: "2",
  assistant: {
    name: "Rozy",
    system_prompt: "Be friendly and grounded.",
    ...extra.assistant,
  },
  routing: extra.routing,
  tools: [categories, search, schedule],
});

test("English-only metadata supports Arabic and French recall while greetings remain conversation", async () => {
  const seen = [];
  let apiCalls = 0;
  const runtime = await AgentRuntime.create({
    config: makeConfig(),
    model: multilingualModel(seen),
    debug: true,
    fetch: async () => {
      apiCalls++;
      return Response.json([{ id: "hair", name: "Hair" }]);
    },
  });

  const hello = await runtime.chat({ sessionId: "arabic", message: "مرحبا" });
  assert.equal(hello.status, "completed");
  assert.match(hello.message, /أهلًا/);
  assert.equal(hello.meta.toolCalls, 0);
  assert.equal(hello.meta.modelRecallCalls, 1);
  assert.equal(hello.meta.conversationCalls, 1);
  assert.equal(hello.debug.routing.outcome, "conversation");

  const casual = await runtime.chat({ sessionId: "arabic", message: "كيفك؟" });
  assert.equal(casual.status, "completed");
  const casualPrompt = seen
    .filter((item) => item.kind === "conversation")
    .at(-1);
  assert.ok(
    casualPrompt.request.messages.some(
      (message) => message.role === "assistant",
    ),
  );

  const routed = await runtime.chat({
    sessionId: "arabic",
    message: "طيب اعرضلي الأقسام",
  });
  assert.equal(routed.status, "completed");
  assert.equal(routed.tool.id, "get-categories");
  assert.equal(routed.meta.modelRecallCalls, 1);
  assert.equal(routed.meta.toolSelectionCalls, 1);
  assert.ok(
    seen
      .filter((item) => item.kind === "recall")
      .at(-1)
      .request.messages.some((message) => message.role === "assistant"),
  );

  const french = await runtime.chat({
    sessionId: "french",
    message: "Montrez-moi les catégories",
  });
  assert.equal(french.tool.id, "get-categories");
  assert.equal(apiCalls, 2);
  runtime.dispose();
});

test("greeting plus tool intent routes, unknown recall IDs are discarded, and prompts stay lightweight", async () => {
  const seen = [];
  let url;
  const runtime = await AgentRuntime.create({
    config: makeConfig(),
    model: multilingualModel(seen),
    fetch: async (input) => {
      url = input;
      return Response.json([]);
    },
  });
  const result = await runtime.chat({
    sessionId: "mixed",
    message: "مرحبا، عندكم خدمات للشعر؟ bearer-secret",
    auth: { token: "bearer-secret" },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.tool.id, "search-services");
  assert.equal(new URL(url).searchParams.get("q"), "شعر");
  const recall = seen.find((item) => item.kind === "recall");
  const serialized = JSON.stringify(recall.request);
  assert.equal(serialized.includes("private.example.test"), false);
  assert.equal(serialized.includes("bearer-secret"), false);
  assert.equal(serialized.includes('"request"'), false);
  assert.deepEqual(
    seen
      .find((item) => item.kind === "selection")
      .request.tools.map((tool) => tool.name),
    ["search-services"],
  );
  runtime.dispose();
});

test("high-confidence lexical routing skips recall and supports Arabic normalization and keyword phrases", async () => {
  const compiled = compileConfig(makeConfig()),
    retriever = new LexicalToolRetriever(compiled);
  assert.equal(
    (await retriever.retrieve("أَلْشَّعْر hair care", { limit: 3 }))[0].tool,
    "search-services",
  );
  const seen = [];
  const runtime = await AgentRuntime.create({
    config: makeConfig(),
    model: multilingualModel(seen),
    fetch: async () => Response.json([]),
  });
  const result = await runtime.chat({
    sessionId: "lexical",
    message: "browse categories",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.meta.modelRecallCalls, 0);
  assert.equal(result.meta.modelCalls, 1);
  runtime.dispose();
});

test("conversation can be disabled and semantic recall failures remain model errors", async () => {
  const seen = [];
  const disabled = await AgentRuntime.create({
    config: makeConfig({
      assistant: { conversation: { enabled: false } },
    }),
    model: multilingualModel(seen),
  });
  const noMatch = await disabled.chat({ sessionId: "off", message: "Hello" });
  assert.equal(noMatch.status, "error");
  assert.equal(noMatch.error.code, "ROUTING_NO_MATCH");
  disabled.dispose();

  const brokenModel = multilingualModel([]);
  brokenModel.generateStructured = async () => {
    throw new Error("provider unavailable");
  };
  const broken = await AgentRuntime.create({
    config: makeConfig(),
    model: brokenModel,
  });
  const failed = await broken.chat({ sessionId: "failure", message: "مرحبا" });
  assert.equal(failed.status, "error");
  assert.equal(failed.error.code, "MODEL_PROVIDER_ERROR");
  assert.equal(failed.meta.conversationCalls, 0);
  broken.dispose();
});

test("a conversational detour preserves pending tool arguments and state", async () => {
  const seen = [];
  let apiCalls = 0;
  const runtime = await AgentRuntime.create({
    config: makeConfig(),
    model: multilingualModel(seen),
    fetch: async () => {
      apiCalls++;
      return Response.json({ open: true });
    },
  });
  const start = await runtime.chat({
    sessionId: "pending",
    message: "check schedule",
  });
  assert.equal(start.status, "needs_input");
  assert.deepEqual(start.missing, ["/date"]);

  const detour = await runtime.chat({ sessionId: "pending", message: "كيفك؟" });
  assert.equal(detour.status, "completed");
  assert.equal(detour.meta.toolCalls, 0);

  const finish = await runtime.chat({
    sessionId: "pending",
    message: "2026-10-01",
  });
  assert.equal(finish.status, "completed");
  assert.equal(finish.tool.id, "check-schedule");
  assert.equal(apiCalls, 1);
  runtime.dispose();
});

test("weak common words invoke recall and hybrid fusion retains lexical evidence", async () => {
  const decoys = Array.from({ length: 6 }, (_, index) => ({
    id: `generic-${index}`,
    tool: {
      title: `Generic ${index}`,
      description: `Perform a general service operation number ${index}.`,
      input_schema: emptyInput,
    },
    request: {
      method: "GET",
      url: `https://private.example.test/generic/${index}`,
    },
  }));
  const passport = {
    id: "passport-help",
    tool: {
      title: "Passport Help",
      description: "Provide passport assistance.",
      input_schema: emptyInput,
    },
    request: {
      method: "GET",
      url: "https://private.example.test/passport",
    },
  };
  let selections;
  const model = {
    capabilities: () => ({ nativeTools: true, structuredOutput: true }),
    generateStructured: async () => ({
      data: { candidates: decoys.map((tool) => tool.id) },
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    selectTool: async (request) => {
      selections = request.tools.map((tool) => tool.name);
      return {
        call: { name: "passport-help", arguments: {} },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const runtime = await AgentRuntime.create({
    config: { version: "2", tools: [...decoys, passport] },
    model,
    fetch: async () => Response.json({ ok: true }),
  });
  const result = await runtime.chat({
    sessionId: "fusion",
    message: "service passport",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.meta.modelRecallCalls, 1);
  assert.ok(selections.includes("passport-help"));
  runtime.dispose();
});

test("a failed conversation responder does not destroy pending input", async () => {
  const seen = [];
  const model = multilingualModel(seen);
  model.generateText = async () => {
    throw new Error("temporary presentation failure");
  };
  let apiCalls = 0;
  const runtime = await AgentRuntime.create({
    config: makeConfig(),
    model,
    fetch: async () => {
      apiCalls++;
      return Response.json({ open: true });
    },
  });
  const start = await runtime.chat({
    sessionId: "pending-failure",
    message: "check schedule",
  });
  assert.equal(start.status, "needs_input");

  const detour = await runtime.chat({
    sessionId: "pending-failure",
    message: "كيفك؟",
  });
  assert.equal(detour.status, "error");
  assert.equal(detour.error.code, "MODEL_PROVIDER_ERROR");

  const finish = await runtime.chat({
    sessionId: "pending-failure",
    message: "2026-10-01",
  });
  assert.equal(finish.status, "completed");
  assert.equal(finish.tool.id, "check-schedule");
  assert.equal(apiCalls, 1);
  runtime.dispose();
});
