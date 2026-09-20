import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { AgentRuntime } from "../../dist/index.js";
import { loadExampleConfig } from "./config.mjs";

/** Interactive host for live API execution; every selection and approval comes from the operator. */
export async function runConsole(
  configFile,
  {
    direct = false,
    initialTool,
    initialArguments = {},
    env = process.env,
  } = {},
) {
  const config = await loadExampleConfig(configFile, env, { direct });
  const runtime = await AgentRuntime.create({
    config,
    env,
    presentation: direct ? "raw" : "both",
  });
  const rl = createInterface({ input: stdin, output: stdout });
  const sessionId = randomUUID();
  const token =
    env.AGENTO_USER_ACCESS_TOKEN ||
    env.USER_ACCESS_TOKEN ||
    env.AGENTO_API_TOKEN;
  const base = () => ({ sessionId, ...(token ? { auth: { token } } : {}) });
  let result;
  let pending = initialTool
    ? { tool: initialTool, arguments: initialArguments }
    : undefined;
  try {
    console.log(
      "AGENTO V2 — live API. /tools, /invoke <tool> <JSON>, /cancel, /reset, /exit.",
    );
    if (initialTool) result = await runtime.invoke({ ...base(), ...pending });
    while (true) {
      if (result) console.log(JSON.stringify(result, null, 2));
      if (direct && result?.status === "error") process.exitCode = 1;
      const line = (await rl.question("You: ")).trim();
      if (line === "/exit") break;
      if (!line) continue;
      if (line === "/tools") {
        console.log(
          runtime
            .listTools()
            .map((t) => `${t.name}: ${t.description}`)
            .join("\n"),
        );
        result = undefined;
        continue;
      }
      if (line === "/reset") {
        await runtime.clearSession(sessionId);
        result = undefined;
        pending = undefined;
        console.log("Session cleared.");
        continue;
      }
      if (line === "/cancel" || /^(cancel|إلغاء|الغاء)$/i.test(line)) {
        result = await runtime.cancel(base());
        pending = undefined;
        continue;
      }
      if (line.startsWith("/invoke ")) {
        const match = /^\/invoke\s+(\S+)(?:\s+([\s\S]+))?$/.exec(line);
        try {
          const args = JSON.parse(match?.[2] ?? "{}");
          if (!args || Array.isArray(args) || typeof args !== "object")
            throw Error();
          pending = { tool: match[1], arguments: args };
          result = await runtime.invoke({ ...base(), ...pending });
        } catch {
          console.log('Usage: /invoke tool-id {"field":"value"}');
        }
        continue;
      }
      if (result?.status === "needs_confirmation") {
        if (line !== "CONFIRM") {
          console.log(
            "Type CONFIRM to execute the displayed action, or /cancel.",
          );
          continue;
        }
        result = await runtime.confirm({
          ...base(),
          confirmationId: result.confirmation.id,
        });
      } else if (result?.status === "needs_selection") {
        const options = result.selection.options;
        const option = options.find((o) => o.id === line || o.label === line);
        if (!option) {
          console.log("Choose an ID or exact label from the current options.");
          continue;
        }
        result = await runtime.select({
          ...base(),
          selectionId: result.selection.id,
          choice: option.id,
        });
      } else if (direct) {
        console.log(
          "Use /invoke <tool> <JSON> with complete inputs, /tools, or /exit.",
        );
      } else {
        result = await runtime.chat({ ...base(), message: line });
      }
      if (result?.status === "needs_confirmation")
        console.log("Type CONFIRM only after reviewing this real API action.");
    }
  } catch (error) {
    if (error?.code !== "ERR_USE_AFTER_CLOSE") throw error;
  } finally {
    rl.close();
    runtime.dispose();
  }
}
