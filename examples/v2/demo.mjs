import { runConsole } from "../shared/console.mjs";
const mode = process.argv[2] === "catalog" ? "catalog" : "booking";
try {
  await runConsole(new URL(`${mode}.yml`, import.meta.url), {
    direct: process.argv.includes("--direct"),
  });
} catch (error) {
  console.error(
    error?.code ? `${error.code}: ${error.message}` : error.message,
  );
  process.exitCode = 1;
}
