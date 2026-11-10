import { ConfigError } from "../config/index.js";
import { CLIENTS } from "./clients.js";

export interface InstallArgs {
    clients    : string[];
    dryRun     : boolean;
    remove     : boolean;
    list       : boolean;
    scope      : "user" | "project";
    serverFlags: string[];
}

const NAMES = CLIENTS.map((client) => client.name);
const ALL = CLIENTS.filter((client) => client.inAll !== false).map((client) => client.name);

export function parseInstallArgs(argv: string[]): InstallArgs {
    const requested: string[] = [];
    const serverFlags: string[] = [];
    let dryRun = false;
    let remove = false;
    let scope: "user" | "project" = "user";

    if (argv.includes("--list")) {
        if (argv.length > 1) {
            throw new ConfigError("--list takes no other options");
        }

        return { clients: [], dryRun: false, remove: false, list: true, scope: "user", serverFlags: [] };
    }

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i] as string;

        if (arg === "--dry-run") dryRun = true;
        else if (arg === "--remove") remove = true;
        else if (arg === "--client") {
            const value = argv[i + 1];

            if (value === undefined || value.startsWith("-")) {
                throw new ConfigError(`--client needs a value: ${NAMES.join(", ")} or all`);
            }

            requested.push(value);
            i += 1;
        } else if (arg === "--scope" || arg.startsWith("--scope=")) {
            const value = arg === "--scope" ? argv[i + 1] : arg.slice("--scope=".length);

            if (value !== "user" && value !== "project") {
                throw new ConfigError("--scope needs a value: user or project");
            }

            scope = value;
            if (arg === "--scope") i += 1;
        } else if (arg.startsWith("--client=")) requested.push(arg.slice("--client=".length));
        else serverFlags.push(arg);
    }

    if (requested.length === 0) {
        throw new ConfigError(`--client is required: ${NAMES.join(", ")} or all`);
    }

    const clients = requested.includes("all") ? [...ALL, ...requested.filter((name) => name !== "all")] : requested;
    const unknown = clients.find((name) => !NAMES.includes(name));

    if (unknown !== undefined) {
        throw new ConfigError(`unknown client "${unknown}". Supported clients: ${NAMES.join(", ")}, all`);
    }

    if (remove && serverFlags.length > 0) {
        throw new ConfigError("--remove does not take server flags");
    }

    return { clients: [...new Set(clients)], dryRun, remove, list: false, scope, serverFlags };
}
