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
    const uploads = get("UPLOAD_DIRS");
    const tools = get("TOOLS");
    const excluded = get("EXCLUDE_TOOLS");
    const auditLog = get("AUDIT_LOG");
    const cdpLog = get("CDP_LOG");

    return compact({
        browser     : get("BROWSER"),
        mode        : get("MODE"),
        headless    : bool("HEADLESS"),
        profileDir  : get("PROFILE_DIR"),
        debugPort   : port === undefined ? undefined : toInt(port),
        wsEndpoint  : get("WS_ENDPOINT"),
        allowFocus  : bool("ALLOW_FOCUS"),
        isolated    : bool("ISOLATED"),
        tools       : tools === undefined ? undefined : toList(tools),
        excludeTools: excluded === undefined ? undefined : toList(excluded),
        auditLog    : auditLog,
        cdpLog,
        safety      : {
            readOnly            : bool("READ_ONLY"),
            allowedDomains      : domains === undefined ? undefined : toList(domains),
            deniedDomains       : denied === undefined ? undefined : toList(denied),
            allowPrivateNetworks: bool("ALLOW_PRIVATE_NETWORKS"),
            confirmDangerous    : bool("CONFIRM_DANGEROUS"),
            uploadDirs          : uploads === undefined ? undefined : toList(uploads),
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
                tools                   : { type: "string" },
                "exclude-tools"         : { type: "string" },
                "audit-log"             : { type: "string" },
                "cdp-log"               : { type: "string" },
                "confirm-dangerous"     : { type: "boolean" },
                "upload-dirs"           : { type: "string" },
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
    const uploads = values["upload-dirs"];
    const tools = values.tools;
    const excluded = values["exclude-tools"];
    const auditLog = values["audit-log"];
    const cdpLog = values["cdp-log"];

    return compact({
        browser     : values.browser,
        mode        : values.mode,
        headless    : values.headless,
        profileDir  : values["profile-dir"],
        debugPort   : typeof port === "string" ? toInt(port) : port,
        wsEndpoint  : values["ws-endpoint"],
        allowFocus  : values["allow-focus"],
        isolated    : values.isolated,
        tools       : typeof tools === "string" ? toList(tools) : tools,
        excludeTools: typeof excluded === "string" ? toList(excluded) : excluded,
        auditLog    : auditLog,
        cdpLog,
        safety      : {
            readOnly            : values["read-only"],
            allowedDomains      : typeof domains === "string" ? toList(domains) : domains,
            deniedDomains       : typeof denied === "string" ? toList(denied) : denied,
            allowPrivateNetworks: values["allow-private-networks"],
            confirmDangerous    : values["confirm-dangerous"],
            uploadDirs          : typeof uploads === "string" ? toList(uploads) : uploads,
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

interface Resolved {
    file    : string;
    exists  : boolean;
    defaults: Layer;
    layers  : Array<{ source: ConfigSource; layer: Layer }>;
    platform: NodeJS.Platform;
}

export type ConfigSource = "default" | "file" | "env" | "flag";

function resolveLayers(options: LoadOptions): Resolved {
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
            uploadDirs          : [],
        },
    };

    return {
        file,
        exists  : content !== undefined,
        defaults,
        platform: ctx.platform,
        layers  : [
            { source: "file", layer: fileLayer(file, content) },
            { source: "env", layer: envLayer(ctx.env) },
            { source: "flag", layer: argvLayer(options.argv ?? process.argv.slice(2)) },
        ],
    };
}

function validate(resolved: Resolved): Config {
    const layered = resolved.layers.reduce(
        (base, entry) => merge(base, entry.layer),
        resolved.defaults,
    );
    const merged = { ...layered, debugPort: layered.debugPort ?? (layered.mode === "managed" ? 0 : 9222) };

    const result = configSchema.safeParse(merged);

    if (result.success) {
        if (!pathFor(resolved.platform).isAbsolute(result.data.profileDir)) {
            throw new ConfigError(
                `invalid configuration: profileDir: must be an absolute path, got ${JSON.stringify(result.data.profileDir)}. A leading ~ is not expanded.`,
            );
        }

        if (
            result.data.auditLog !== undefined
            && !pathFor(resolved.platform).isAbsolute(result.data.auditLog)
        ) {
            throw new ConfigError(
                `invalid configuration: auditLog: must be an absolute path, got ${JSON.stringify(result.data.auditLog)}`,
            );
        }

        if (
            result.data.cdpLog !== undefined
            && !pathFor(resolved.platform).isAbsolute(result.data.cdpLog)
        ) {
            throw new ConfigError("invalid configuration: cdpLog: must be an absolute path");
        }

        return result.data;
    }

    const details = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");

    throw new ConfigError(`invalid configuration: ${details}`);
}

export function loadConfig(options: LoadOptions = {}): Config {
    return validate(resolveLayers(options));
}

export interface ConfigReport {
    file   : string;
    exists : boolean;
    config : Config;
    sources: Record<string, ConfigSource>;
}

const FIELDS = [
    "browser",
    "mode",
    "headless",
    "profileDir",
    "debugPort",
    "wsEndpoint",
    "allowFocus",
    "isolated",
    "tools",
    "excludeTools",
    "auditLog",
    "cdpLog",
] as const;

const SAFETY_FIELDS = [
    "readOnly",
    "allowedDomains",
    "deniedDomains",
    "allowPrivateNetworks",
    "confirmDangerous",
    "uploadDirs",
] as const;

// The effective configuration with the layer that set each value; the last layer that sets it wins.
export function describeConfig(options: LoadOptions = {}): ConfigReport {
    const resolved = resolveLayers(options);
    const config = validate(resolved);
    const sources: Record<string, ConfigSource> = {};
    const find = (read: (layer: Layer) => unknown): ConfigSource => {
        let source: ConfigSource = "default";

        for (const entry of resolved.layers) {
            if (read(entry.layer) !== undefined) source = entry.source;
        }

        return source;
    };

    for (const field of FIELDS) sources[field] = find((layer) => layer[field]);

    for (const field of SAFETY_FIELDS) {
        sources[`safety.${field}`] = find((layer) => layer.safety?.[field]);
    }

    return { file: resolved.file, exists: resolved.exists, config, sources };
}
