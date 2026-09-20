export function runConsole(
  configFile: string | URL,
  options?: {
    direct?: boolean;
    initialTool?: string;
    initialArguments?: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void>;
