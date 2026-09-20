import { readFile } from "node:fs/promises";
import {
  compileConfig,
  ProviderModel,
  evaluateRouting,
} from "../../dist/v2/index.js";
const provider = process.env.AGENTO_PROVIDER ?? "openai";
if (!process.env.AGENTO_MODEL)
  throw new Error(
    "Set AGENTO_MODEL to your exact deployment model ID. Set AGENTO_API_KEY for hosted providers.",
  );
if (!["openai", "anthropic", "mistral", "cohere", "ollama"].includes(provider))
  throw new Error("Unsupported AGENTO_PROVIDER.");
const config = compileConfig(
  await readFile(new URL("../../evals/v2/tools.yml", import.meta.url), "utf8"),
);
const fixtures = JSON.parse(
  await readFile(
    new URL("../../evals/v2/routing.json", import.meta.url),
    "utf8",
  ),
);
const model = new ProviderModel({
  provider,
  model: process.env.AGENTO_MODEL,
  api_key: provider === "ollama" ? undefined : "$ENV:AGENTO_API_KEY",
  base_url: process.env.AGENTO_BASE_URL,
  timeout_ms: 30000,
});
// This sends model requests and consumes provider quota. It never invokes the configured APIs.
console.log(
  JSON.stringify(await evaluateRouting(config, model, fixtures), null, 2),
);
