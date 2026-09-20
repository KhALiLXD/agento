import { readFile } from "node:fs/promises";
import { parseConfig } from "../../dist/index.js";

/** Load real API configuration; rewrite only tool URLs, never model URLs or YAML text. */
export async function loadExampleConfig(
  file,
  env = process.env,
  { direct = false } = {},
) {
  const config = parseConfig(await readFile(file, "utf8"));
  let base;
  if (env.AGENTO_API_BASE_URL) {
    base = new URL(env.AGENTO_API_BASE_URL);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error(
        "AGENTO_API_BASE_URL must be an HTTP(S) base URL without credentials, query or fragment.",
      );
  }
  for (const tool of config.tools) {
    const original = new URL(tool.request.url);
    if (base)
      tool.request.url =
        base.href.replace(/\/$/, "") +
        original.pathname.replace(/%7B([A-Za-z0-9_-]+)%7D/gi, "{$1}") +
        original.search;
    if (new URL(tool.request.url).hostname === "api.example.com")
      throw new Error(
        "Set AGENTO_API_BASE_URL to your running API, or edit the URLs in the YAML.",
      );
    if (
      env.AGENTO_ALLOW_INSECURE_HTTP === "true" &&
      new URL(tool.request.url).protocol === "http:"
    )
      tool.request.allow_insecure_http = true;
  }
  if (direct) delete config.models;
  else if (config.models && env.AGENTO_MODEL) {
    config.models.routing.model = env.AGENTO_MODEL;
    if (config.models.presentation)
      config.models.presentation.model = env.AGENTO_MODEL;
  }
  return config;
}
