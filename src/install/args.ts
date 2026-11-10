import { ConfigError } from "../config/index.js";
import { CLIENTS } from "./clients.js";

export interface InstallArgs {
    clients    : string[];
    dryRun     : boolean;
    remove     : boolean;
    serverFlags: string[];
}

const NAMES = CLIENTS.map((client) => client.name);
const ALL = CLIENTS.filter((client) => client.inAll !== false).map((client) => client.name);

export function parseInstallArgs(argv: string[]): InstallArgs {
    const requested: string[] = [];
    const serverFlags: string[] = [];
    let dryRun = false;
    let remove = false;

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

    return { clients: [...new Set(clients)], dryRun, remove, serverFlags };
}
