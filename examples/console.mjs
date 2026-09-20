import { runConsole } from "./shared/console.mjs";
const args = process.argv.slice(2);
const index = args.indexOf("--config");
const config =
  index >= 0
    ? args[index + 1]
    : new URL("./discord-bot/agent-config.yml", import.meta.url);
if (!config) throw new Error("--config requires a YAML file path.");
try {
  await runConsole(config, { direct: args.includes("--direct") });
} catch (error) {
  console.error(
    error?.code ? `${error.code}: ${error.message}` : error.message,
  );
  if (error?.details?.variable) console.error(`Set ${error.details.variable}.`);
  process.exitCode = 1;
}
