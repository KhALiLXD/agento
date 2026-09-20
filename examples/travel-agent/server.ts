import { runConsole } from "../shared/console.mjs";
try {
  await runConsole(new URL("./agent-config.yml", import.meta.url), {
    direct: process.argv.includes("--direct"),
  });
} catch (error) {
  const e = error as { code?: string; message: string };
  console.error(e.code ? `${e.code}: ${e.message}` : e.message);
  process.exitCode = 1;
}
