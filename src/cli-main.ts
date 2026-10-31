import { type Config, ConfigError, loadConfig } from "./config/index.js";
import { AlreadyRunningError } from "./daemon/errors.js";
import { runDaemon, type RunningDaemon } from "./daemon/runner.js";
import { runMcpServer, type RunningMcp } from "./mcp/server.js";

const USAGE =
  "Usage: chromium-devtools-mcp [options]        run the MCP server on stdio\n       chromium-devtools-mcp daemon [options] run the browser daemon\nOptions: --browser chrome, --mode attach|managed, --headless, --profile-dir, --debug-port, --allow-focus, --read-only, --allowed-domains, --confirm-dangerous, --help\nBoolean flags also accept a --no- form, for example --no-headless.";

export interface CliDeps {
  run     : (config: Config) => Promise<RunningDaemon>;
  load    : typeof loadConfig;
  write   : (text: string) => void;
  serve   : (config: Config, flags: string[]) => Promise<RunningMcp>;
  onSignal: (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => void;
}

const defaults: CliDeps = {
  run     : (config) => runDaemon(config),
  load    : loadConfig,
  write   : (text) => void process.stderr.write(text),
  serve   : (config, flags) => runMcpServer(config, flags),
  onSignal: (signal, handler) => void process.once(signal, handler),
};

function loadOrExplain(deps: CliDeps, argv: string[]): Config | number {
  try {
    return deps.load({ argv });
  } catch (error) {
    deps.write(`${error instanceof ConfigError ? error.message : String(error)}\n${USAGE}\n`);

    return 2;
  }
}

async function runServe(deps: CliDeps, argv: string[]): Promise<number> {
  const config = loadOrExplain(deps, argv);

  if (typeof config === "number") return config;

  let running: RunningMcp;

  try {
    running = await deps.serve(config, argv);
  } catch (error) {
    deps.write(`${error instanceof Error ? error.message : String(error)}\n`);

    return 1;
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    deps.onSignal(signal, () => void running.stop());
  }

  await running.done;

  return 0;
}

async function runDaemonCommand(deps: CliDeps, argv: string[]): Promise<number> {
  const config = loadOrExplain(deps, argv);

  if (typeof config === "number") return config;

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

export async function main(argv: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...defaults, ...overrides };
  const [first, ...rest] = argv;

  if (argv.includes("--help") || argv.includes("-h")) {
    deps.write(`${USAGE}\n`);

    return 0;
  }

  if (first === "daemon") return runDaemonCommand(deps, rest);
  if (first === undefined || first.startsWith("-")) return runServe(deps, argv);

  deps.write(`${USAGE}\n`);

  return 2;
}
