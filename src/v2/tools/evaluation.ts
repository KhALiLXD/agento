import type { CompiledAgent } from "../config/compiler.js";
import type { ModelAdapter } from "../models/interface.js";
import { LexicalToolRetriever, type ToolRetriever } from "./retriever.js";
import { ToolRouter } from "./router.js";
import { AgentRuntimeError } from "../errors.js";
import { canonical } from "../config/paths.js";
export interface RoutingFixture {
  input: string;
  expectedTool: string | null;
  expectedArguments?: Record<string, unknown>;
}
export async function evaluateRouting(
  compiled: CompiledAgent,
  model: ModelAdapter,
  fixtures: readonly RoutingFixture[],
  retriever: ToolRetriever = new LexicalToolRetriever(compiled),
) {
  const router = new ToolRouter(compiled, retriever),
    results = [];
  let correct = 0,
    noMatch = 0,
    falsePositive = 0,
    argumentCorrect = 0,
    argumentCases = 0,
    schemaFailures = 0,
    tokens = 0,
    calls = 0;
  const started = Date.now();
  for (const fixture of fixtures) {
    const start = Date.now();
    try {
      const r = await router.route(
        fixture.input,
        [{ role: "user", content: fixture.input }],
        model,
        {
          onCall: async () => {
            calls++;
          },
          onUsage: (u) => {
            tokens += u.inputTokens + u.outputTokens;
          },
        },
      );
      const selected = r.call?.name ?? null,
        matched = selected === fixture.expectedTool;
      if (matched) correct++;
      if (!selected) noMatch++;
      if (fixture.expectedTool === null && selected) falsePositive++;
      if (fixture.expectedArguments) {
        argumentCases++;
        if (
          matched &&
          Object.entries(fixture.expectedArguments).every(
            ([k, v]) => canonical(r.call?.arguments[k]) === canonical(v),
          )
        )
          argumentCorrect++;
      }
      results.push({
        input: fixture.input,
        selected,
        matched,
        latencyMs: Date.now() - start,
      });
    } catch (error) {
      const code =
        error instanceof AgentRuntimeError
          ? error.code
          : "MODEL_PROVIDER_ERROR";
      if (code === "MODEL_SCHEMA_VIOLATION") schemaFailures++;
      if (fixture.expectedArguments) argumentCases++;
      results.push({
        input: fixture.input,
        error: code,
        latencyMs: Date.now() - start,
      });
    }
  }
  const count = fixtures.length,
    negative = fixtures.filter((f) => f.expectedTool === null).length;
  return {
    count,
    toolSelectionAccuracy: count ? correct / count : 0,
    noMatchRate: count ? noMatch / count : 0,
    falsePositiveRate: negative ? falsePositive / negative : 0,
    argumentAccuracy: argumentCases ? argumentCorrect / argumentCases : 0,
    schemaFailures,
    tokens,
    modelCalls: calls,
    durationMs: Date.now() - started,
    results,
  };
}
