import { access } from "node:fs/promises";
import {
    BROWSERS,
    BrowserNotFoundError,
    type BrowserName,
    findAttachEndpoint,
    findBrowserExecutable,
    probePort,
    type AttachEndpoint,
} from "./browser/index.js";
import { pathFor, type Config } from "./config/index.js";
import {
    connectToDaemon,
    currentLayout,
    DaemonNotRunningError,
    daemonIdentity,
    type DaemonIdentity,
    describeIdentity,
    differingFields,
    helloIdentity,
    IpcClosedError,
} from "./daemon/index.js";
import { findOnPath } from "./tools/perf/video.js";
import { messageOf } from "./util/message-of.js";

export type CheckLevel = "ok" | "info" | "warn" | "fail";

export interface DoctorCheck {
    level : CheckLevel;
    title : string;
    detail: string;
    fix?  : string[];
}

export type DaemonProbe =
    | { kind: "not-running" }
    | { kind: "unreachable"; message: string }
    | { kind: "running"; state: string; message?: string; identity?: DaemonIdentity };

export interface DoctorDeps {
    nodeVersion       : string;
    platform          : NodeJS.Platform;
    findBrowser       : (browser: BrowserName) => string;
    findAttachEndpoint: (config: Config) => Promise<AttachEndpoint | undefined>;
    isPortOpen        : (port: number) => Promise<boolean>;
    isWritable        : (dir: string) => Promise<boolean>;
    probeDaemon       : () => Promise<DaemonProbe>;
    findProgram       : (name: OptionalProgram) => Promise<string | undefined>;
}

const MIN_NODE_MAJOR = 22;

export type OptionalProgram = "ffmpeg" | "lighthouse";

const OPTIONAL_PROGRAMS: Record<OptionalProgram, { use: string; install: string }> = {
    ffmpeg: {
        use    : "screencast_stop makes a video with it",
        install: "Install ffmpeg, for example with brew install ffmpeg or apt install ffmpeg.",
    },
    lighthouse: {
        use    : "lighthouse_audit runs it",
        install: "Install it with npm install -g lighthouse (it needs Node.js 22.19 or newer).",
    },
};

async function nearestExisting(dir: string, platform: NodeJS.Platform): Promise<string> {
    const p = pathFor(platform);
    let current = dir;

    for (;;) {
        try {
            await access(current);

            return current;
        } catch {
            const parent = p.dirname(current);

            if (parent === current) return current;

            current = parent;
        }
    }
}

async function writableOrCreatable(dir: string, platform: NodeJS.Platform): Promise<boolean> {
    try {
        await access(await nearestExisting(dir, platform), 2);

        return true;
    } catch {
        return false;
    }
}

async function probeDaemon(): Promise<DaemonProbe> {
    let client;

    try {
        client = await connectToDaemon({ clientName: "doctor", layout: currentLayout() });
    } catch (error) {
        if (error instanceof DaemonNotRunningError || error instanceof IpcClosedError) {
            return { kind: "not-running" };
        }

        return { kind: "unreachable", message: messageOf(error) };
    }

    try {
        const status = (await client.request("daemon.status")) as {
            state?  : unknown;
            message?: unknown;
        };
        const identity = helloIdentity(client);

        return {
            kind : "running",
            state: typeof status.state === "string" ? status.state : "unknown",
            ...(typeof status.message === "string" ? { message: status.message } : {}),
            ...(identity === undefined ? {} : { identity }),
        };
    } catch (error) {
        return { kind: "unreachable", message: messageOf(error) };
    } finally {
        await client.close();
    }
}

export function realDoctorDeps(): DoctorDeps {
    return {
        nodeVersion       : process.versions.node,
        platform          : process.platform,
        findBrowser       : (browser) => findBrowserExecutable(browser),
        findAttachEndpoint: (config) => findAttachEndpoint(config),
        isPortOpen        : (port) => probePort(port),
        isWritable        : (dir) => writableOrCreatable(dir, process.platform),
        probeDaemon,
        findProgram       : (name) => findOnPath(process.env, process.platform, name),
    };
}

function checkNode(deps: DoctorDeps): DoctorCheck {
    const major = Number(deps.nodeVersion.replace(/^v/, "").split(".")[0]);

    return major >= MIN_NODE_MAJOR
        ? { level: "ok", title: "Node.js", detail: deps.nodeVersion }
        : {
            level : "fail",
            title : "Node.js",
            detail: `${deps.nodeVersion} is too old, version ${MIN_NODE_MAJOR} or newer is required`,
            fix   : [`Install Node.js ${MIN_NODE_MAJOR} or newer and start the client again.`],
        };
}

function checkConfig(config: Config): DoctorCheck {
    const target = config.wsEndpoint === undefined ? "" : `, endpoint ${config.wsEndpoint}`;

    return {
        level : "ok",
        title : "Settings",
        detail: `browser ${config.browser}, mode ${config.mode}${target}`,
    };
}

function checkBrowser(config: Config, deps: DoctorDeps): DoctorCheck {
    try {
        return {
            level : "ok",
            title : BROWSERS[config.browser].label,
            detail: deps.findBrowser(config.browser),
        };
    } catch (error) {
        if (!(error instanceof BrowserNotFoundError)) throw error;

        return {
            level : "fail",
            title : BROWSERS[config.browser].label,
            detail: error.message,
            fix   : ["Install the browser, or use attach mode with a browser that is already running."],
        };
    }
}

async function checkProfile(config: Config, deps: DoctorDeps): Promise<DoctorCheck> {
    return (await deps.isWritable(config.profileDir))
        ? { level: "ok", title: "Profile directory", detail: config.profileDir }
        : {
            level : "fail",
            title : "Profile directory",
            detail: `${config.profileDir} cannot be created or written`,
            fix   : ["Set profileDir to a directory you can write to."],
        };
}

async function checkAttach(config: Config, deps: DoctorDeps): Promise<DoctorCheck> {
    if (config.wsEndpoint !== undefined) {
        const port = Number(new URL(config.wsEndpoint).port);

        return (await deps.isPortOpen(port))
            ? { level: "ok", title: "Browser endpoint", detail: `port ${port} accepts connections` }
            : {
                level : "fail",
                title : "Browser endpoint",
                detail: `nothing listens on port ${port}`,
                fix   : [
                    "Start the browser with remote debugging.",
                    "Check that wsEndpoint is its current address: the id in it changes every time the browser starts.",
                ],
            };
    }

    const endpoint = await deps.findAttachEndpoint(config);

    return endpoint
        ? {
            level : "ok",
            title : "Browser endpoint",
            detail: `found on port ${endpoint.port} (${endpoint.source})`,
        }
        : {
            level : "fail",
            title : "Browser endpoint",
            detail: `remote debugging is not enabled: no browser was found through the profile or on port ${config.debugPort}`,
            fix   : BROWSERS[config.browser].attachSteps(config.debugPort),
        };
}

function checkDaemon(config: Config, probe: DaemonProbe): DoctorCheck {
    if (probe.kind === "not-running") {
        return {
            level : "ok",
            title : "Daemon",
            detail: "not running, it starts with the first MCP client",
        };
    }

    if (probe.kind === "unreachable") {
        return {
            level : "warn",
            title : "Daemon",
            detail: `running but not answering: ${probe.message}`,
            fix   : ["Run chromium-devtools-mcp daemon logs to see what it reports."],
        };
    }

    const fields = probe.identity
        ? differingFields(probe.identity, daemonIdentity(config))
        : [];

    if (probe.identity && fields.length > 0) {
        return {
            level : "warn",
            title : "Daemon",
            detail: `running with other settings (${describeIdentity(probe.identity, fields)}), so a client with these settings is refused`,
            fix   : ["Run chromium-devtools-mcp daemon stop, then start the client again."],
        };
    }

    if (probe.state !== "ready") {
        return {
            level : "warn",
            title : "Daemon",
            detail: `${probe.state}${probe.message === undefined ? "" : `: ${probe.message}`}`,
            fix   : ["Run chromium-devtools-mcp daemon logs to see what it is waiting for."],
        };
    }

    return { level: "ok", title: "Daemon", detail: "running and ready" };
}

async function checkOptional(name: OptionalProgram, deps: DoctorDeps): Promise<DoctorCheck> {
    const found = await deps.findProgram(name);

    return found === undefined
        ? {
            level : "info",
            title : name,
            detail: `not found, it is optional: ${OPTIONAL_PROGRAMS[name].use} when it is installed`,
            fix   : [OPTIONAL_PROGRAMS[name].install],
        }
        : { level: "ok", title: name, detail: found };
}

export async function runDoctor(config: Config, deps: DoctorDeps): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [checkNode(deps), checkConfig(config)];

    if (config.mode === "managed") {
        checks.push(checkBrowser(config, deps), await checkProfile(config, deps));
    } else {
        checks.push(await checkAttach(config, deps));
    }

    checks.push(
        checkDaemon(config, await deps.probeDaemon()),
        await checkOptional("ffmpeg", deps),
        await checkOptional("lighthouse", deps),
    );

    return checks;
}

export function formatChecks(checks: DoctorCheck[]): string {
    const lines = checks.flatMap((check) => [
        `[${check.level}] ${check.title}: ${check.detail}`,
        ...(check.fix ?? []).map((line) => `       ${line}`),
    ]);
    const failed = checks.filter((check) => check.level === "fail").length;
    const warned = checks.filter((check) => check.level === "warn").length;
    const summary =
        failed > 0
            ? `${failed} problem${failed === 1 ? "" : "s"} found.`
            : warned > 0
                ? "No problems, but see the warnings above."
                : "No problems found.";

    return `${lines.join("\n")}\n${summary}\n`;
}
