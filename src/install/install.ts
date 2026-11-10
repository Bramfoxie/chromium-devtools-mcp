import { ConfigError, loadConfig } from "../config/index.js";
import { parseInstallArgs } from "./args.js";
import { CLIENTS, type ClientContext, type ClientTarget } from "./clients.js";
import { buildEntry, type ServerEntry } from "./entry.js";
import { type InstallFs } from "./fs.js";

export interface InstallDeps extends ClientContext {
    fs : InstallFs;
    now: () => Date;
    out: (text: string) => void;
    err: (text: string) => void;
}

function stamp(date: Date): string {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function manual(target: ClientTarget, entry: ServerEntry | undefined, deps: InstallDeps): void {
    if (entry === undefined) {
        deps.out(`${target.name}: ${target.label} keeps its servers in its own settings. Remove chromium-devtools in Settings, MCP Servers.\n`);

        return;
    }

    deps.out(
        `${target.name}: ${target.label} has no config file to edit. Open Settings, MCP Servers, Add, Import from JSON, and paste:\n${target.preview(entry)}\n`,
    );
}

function apply(
    target: ClientTarget,
    entry : ServerEntry | undefined,
    dryRun: boolean,
    deps  : InstallDeps,
): boolean {
    if (target.file === undefined || target.merge === undefined) {
        manual(target, entry, deps);

        return true;
    }

    const file = target.file(deps);
    let text: string | undefined;

    try {
        text = deps.fs.read(file);
    } catch (error) {
        deps.err(`${target.name}: cannot read ${file}: ${(error as Error).message}. Check its permissions and run again.\n`);

        return false;
    }

    const result = target.merge(text, entry);

    if (result.status === "invalid") {
        deps.err(`${target.name}: ${file} was not changed because ${result.reason}. Fix or move the file and run again.\n`);

        return false;
    }

    if (result.status === "unchanged") {
        deps.out(`${target.name}: already up to date in ${file}, nothing changed\n`);

        return true;
    }

    const verb = { added: "add", updated: "update", removed: "remove" }[result.action];

    if (dryRun) {
        const shown = entry === undefined ? "" : `:\n${target.preview(entry)}`;

        deps.out(`${target.name}: dry run, would ${verb} chromium-devtools in ${file}${shown}\n`);

        return true;
    }

    try {
        let backup = "";

        if (text !== undefined) {
            backup = `${file}.bak-${stamp(deps.now())}`;
            deps.fs.copy(file, backup);
        }

        deps.fs.writeFile(file, result.text);
        deps.out(`${target.name}: ${result.action} chromium-devtools in ${file}${backup ? ` (backup: ${backup})` : ""}\n`);

        return true;
    } catch (error) {
        deps.err(`${target.name}: cannot write ${file}: ${(error as Error).message}. Check permissions and free space, then run again.\n`);

        return false;
    }
}

function describeState(target: ClientTarget, deps: InstallDeps): boolean {
    if (target.file === undefined || target.merge === undefined) {
        deps.out(`${target.name}: no config file, add it in the app\n`);

        return true;
    }

    const file = target.file(deps);
    let text: string | undefined;

    try {
        text = deps.fs.read(file);
    } catch (error) {
        deps.err(`${target.name}: cannot read ${file}: ${(error as Error).message}\n`);

        return false;
    }

    if (text === undefined) {
        deps.out(`${target.name}: not installed (no file at ${file})\n`);

        return true;
    }

    const result = target.merge(text, buildEntry(deps.platform, []));

    if (result.status === "invalid") {
        deps.err(`${target.name}: cannot read ${file} because ${result.reason}\n`);

        return false;
    }

    const state = result.status === "unchanged"
        ? "installed, up to date"
        : result.action === "updated" ? "installed, differs from the current entry" : "not installed";

    deps.out(`${target.name}: ${state} (${file})\n`);

    return true;
}

export function runInstall(argv: string[], deps: InstallDeps): number {
    let args;

    try {
        args = parseInstallArgs(argv);

        if (args.serverFlags.length > 0) {
            loadConfig({
                argv    : args.serverFlags,
                env     : {},
                platform: deps.platform,
                homedir : deps.home,
                readFile: () => undefined,
            });
        }
    } catch (error) {
        deps.err(`${error instanceof ConfigError ? error.message : String(error)}\nUsage: chromium-devtools-mcp install --client <${CLIENTS.map((client) => client.name).join("|")}|all> [--dry-run] [--remove] [server options]\n       chromium-devtools-mcp install --list\n`);

        return 2;
    }

    if (args.list) {
        const states = CLIENTS.map((target) => describeState(target, deps));

        return states.every(Boolean) ? 0 : 1;
    }

    const entry = args.remove ? undefined : buildEntry(deps.platform, args.serverFlags);
    const results = args.clients.map((name) => {
        const target = CLIENTS.find((client) => client.name === name) as ClientTarget;

        return apply(target, entry, args.dryRun, deps);
    });

    return results.every(Boolean) ? 0 : 1;
}
