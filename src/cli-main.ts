import { ConfigError, loadConfig } from "./config/index.js";
import { AlreadyRunningError } from "./daemon/errors.js";
import { runDaemon, type RunningDaemon } from "./daemon/runner.js";

const USAGE =
  "Usage: chromium-devtools-mcp daemon [--browser chrome|arc] [--mode attach|managed] [options]";

export interface CliDeps {
  run: (config: ReturnType<typeof loadConfig>) => Promise<RunningDaemon>;
  load: typeof loadConfig;
  write: (text: string) => void;
  onSignal: (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => void;
}

const defaults: CliDeps = {
  run: (config) => runDaemon(config),
  load: loadConfig,
  write: (text) => void process.stderr.write(text),
  onSignal: (signal, handler) => void process.once(signal, handler),
};

export async function main(argv: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...defaults, ...overrides };
  const [command, ...rest] = argv;
  if (command !== "daemon") {
    deps.write(`${USAGE}\n`);
    return command === "--help" || command === "-h" ? 0 : 2;
  }
  let config: ReturnType<typeof loadConfig>;
  try {
    config = deps.load({ argv: rest });
  } catch (error) {
    deps.write(`${error instanceof ConfigError ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  let running: RunningDaemon;
  try {
    running = await deps.run(config);
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      deps.write(`${error.message}\n`);
      return 0;
    }
    deps.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    deps.onSignal(signal, () => void running.stop());
  }
  const outcome = await running.done;
  if (outcome.error) deps.write(`${outcome.error.message}\n`);
  return outcome.reason === "failed" ? 1 : 0;
}
