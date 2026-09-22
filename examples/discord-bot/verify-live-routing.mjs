import { readFile } from "node:fs/promises";
import {
  compileConfig,
  evaluateRouting,
  ProviderModel,
  LexicalToolRetriever,
} from "../../dist/index.js";
import { loadExampleConfig } from "../shared/config.mjs";

// Billable model-only evaluation. evaluateRouting never executes business APIs.
const compiled = compileConfig(
  await loadExampleConfig(new URL("./agent-config.yml", import.meta.url)),
);
const fixtures = JSON.parse(
  await readFile(
    new URL("../../evals/v2/salon-routing.json", import.meta.url),
    "utf8",
  ),
);
const lexical = new LexicalToolRetriever(compiled);
const model = new ProviderModel(compiled.policies.models.routing);
for (const fixture of fixtures) {
  const candidates = await lexical.retrieve(fixture.input, {
    limit: compiled.policies.routing.candidate_limit,
  });
  const report = await evaluateRouting(compiled, model, [fixture]);
  console.log(
    JSON.stringify({
      input: fixture.input,
      expected: fixture.expectedTool,
      lexical: candidates.map((candidate) => candidate.tool),
      report,
    }),
  );
  if (report.toolSelectionAccuracy !== 1) process.exitCode = 1;
}
