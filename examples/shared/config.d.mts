import type { AgentConfigV2 } from "../../dist/index.js";
export function loadExampleConfig(
  file: string | URL,
  env?: NodeJS.ProcessEnv,
  options?: { direct?: boolean },
): Promise<AgentConfigV2>;
