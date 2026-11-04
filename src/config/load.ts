import os from "node:os";
import { parseArgs } from "node:util";
import { configFilePath, defaultProfileDir, pathFor, type PathContext } from "./paths.js";
import { type Config, ConfigError, configSchema } from "./schema.js";
import { isRecord } from "../util/is-record.js";
import { readIfExistsSync } from "../util/read-if-exists.js";

type Layer = { [key: string]: unknown; safety?: Record<string, unknown> };

export interface LoadOptions {
    argv?    : string[];
    env?     : NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homedir? : string;
    readFile?: (file: string) => string | undefined;
}

function readConfigFile(file: string): string | undefined {
    try {
        return readIfExistsSync(file);
    } catch (error) {
        throw new ConfigError(`cannot read config file ${file}: ${(error as Error).message}`);
    }
}

function toBool(value: string): boolean | string {
    const v = value.trim().toLowerCase();

    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;

    return value;
}

function toInt(value: string): number | string {
    return /^\d+$/.test(value.trim()) ? Number(value) : value;
}

function toList(value: string): string[] {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function compact(layer: Layer): Layer {
    const result: Layer = {};

    for (const [key, value] of Object.entries(layer)) {
        if (key === "safety") continue;
        if (value !== undefined) result[key] = value;
    }

    if (layer.safety) {
        const safety: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(layer.safety)) {
            if (value !== undefined) safety[key] = value;
        }

        if (Object.keys(safety).length > 0) result.safety = safety;
    }

    return result;
}

function envLayer(env: NodeJS.ProcessEnv): Layer {
    const get = (name: string) => {
        const value = env[`CHROMIUM_DEVTOOLS_MCP_${name}`];

        return value === undefined || value.trim() === "" ? undefined : value;
    };
    const bool = (name: string) => {
        const value = get(name);

        return value === undefined ? undefined : toBool(value);
    };
    const port = get("DEBUG_PORT");
    const domains = get("ALLOWED_DOMAINS");
    const denied = get("DENIED_DOMAINS");

    return compact({
        browser   : get("BROWSER"),
        mode      : get("MODE"),
        headless  : bool("HEADLESS"),
        profileDir: get("PROFILE_DIR"),
        debugPort : port === undefined ? undefined : toInt(port),
        wsEndpoint: get("WS_ENDPOINT"),
        allowFocus: bool("ALLOW_FOCUS"),
        isolated  : bool("ISOLATED"),
        safety    : {
            readOnly            : bool("READ_ONLY"),
            allowedDomains      : domains === undefined ? undefined : toList(domains),
            deniedDomains       : denied === undefined ? undefined : toList(denied),
            allowPrivateNetworks: bool("ALLOW_PRIVATE_NETWORKS"),
            confirmDangerous    : bool("CONFIRM_DANGEROUS"),
        },
    });
}

function parseFlags(argv: string[]) {
    try {
        return parseArgs({
            args            : argv,
            strict          : true,
            allowPositionals: false,
            allowNegative   : true,
            options         : {
                browser                 : { type: "string" },
                mode                    : { type: "string" },
                headless                : { type: "boolean" },
                "profile-dir"           : { type: "string" },
                "debug-port"            : { type: "string" },
                "ws-endpoint"           : { type: "string" },
                "allow-focus"           : { type: "boolean" },
                isolated                : { type: "boolean" },
                "read-only"             : { type: "boolean" },
                "allowed-domains"       : { type: "string" },
                "denied-domains"        : { type: "string" },
                "allow-private-networks": { type: "boolean" },
                "confirm-dangerous"     : { type: "boolean" },
            },
        });
    } catch (error) {
        const reason = (error as Error).message.split(". ")[0] ?? "unreadable arguments";

        throw new ConfigError(`invalid command line: ${reason}`);
    }
}

function argvLayer(argv: string[]): Layer {
    const { values } = parseFlags(argv);
    const port = values["debug-port"];
    const domains = values["allowed-domains"];
    const denied = values["denied-domains"];

    return compact({
        browser   : values.browser,
        mode      : values.mode,
        headless  : values.headless,
        profileDir: values["profile-dir"],
        debugPort : typeof port === "string" ? toInt(port) : port,
        wsEndpoint: values["ws-endpoint"],
        allowFocus: values["allow-focus"],
        isolated  : values.isolated,
        safety    : {
            readOnly            : values["read-only"],
            allowedDomains      : typeof domains === "string" ? toList(domains) : domains,
            deniedDomains       : typeof denied === "string" ? toList(denied) : denied,
            allowPrivateNetworks: values["allow-private-networks"],
            confirmDangerous    : values["confirm-dangerous"],
        },
    });
}

function fileLayer(file: string, content: string | undefined): Layer {
    if (content === undefined) return {};

    let parsed: unknown;

    try {
        parsed = JSON.parse(content);
    } catch (error) {
        throw new ConfigError(`invalid JSON in ${file}: ${(error as Error).message}`);
    }

    if (!isRecord(parsed)) throw new ConfigError(`${file} must contain a JSON object`);

    if (parsed.safety !== undefined && !isRecord(parsed.safety)) {
        throw new ConfigError(`invalid value at safety in ${file}: expected an object`);
    }

    return parsed;
}

function merge(base: Layer, layer: Layer): Layer {
    return { ...base, ...layer, safety: { ...base.safety, ...layer.safety } };
}

export function loadConfig(options: LoadOptions = {}): Config {
    const ctx: PathContext = {
        env     : options.env ?? process.env,
        platform: options.platform ?? process.platform,
        homedir : options.homedir ?? os.homedir(),
    };
    const read = options.readFile ?? readConfigFile;
    const file = configFilePath(ctx);
    const override = ctx.env.CHROMIUM_DEVTOOLS_MCP_CONFIG;
    const content = read(file);

    if (content === undefined && override) {
        throw new ConfigError(`config file ${file} does not exist (from CHROMIUM_DEVTOOLS_MCP_CONFIG)`);
    }

    const defaults: Layer = {
        browser   : "chrome",
        mode      : "attach",
        headless  : false,
        profileDir: defaultProfileDir(ctx),
        allowFocus: false,
        isolated  : false,
        safety    : {
            readOnly            : false,
            allowedDomains      : [],
            deniedDomains       : [],
            allowPrivateNetworks: false,
            confirmDangerous    : false,
        },
    };

    const layers = [
        fileLayer(file, content),
        envLayer(ctx.env),
        argvLayer(options.argv ?? process.argv.slice(2)),
    ];
    const layered = layers.reduce(merge, defaults);
    const merged = { ...layered, debugPort: layered.debugPort ?? (layered.mode === "managed" ? 0 : 9222) };

    const result = configSchema.safeParse(merged);

    if (result.success) {
        if (!pathFor(ctx.platform).isAbsolute(result.data.profileDir)) {
            throw new ConfigError(
                `invalid configuration: profileDir: must be an absolute path, got ${JSON.stringify(result.data.profileDir)}. A leading ~ is not expanded.`,
            );
        }

        return result.data;
    }

    const details = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");

    throw new ConfigError(`invalid configuration: ${details}`);
}
