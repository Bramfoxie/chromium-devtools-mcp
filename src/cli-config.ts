import { type ConfigReport, ConfigError } from "./config/index.js";

function show(value: unknown): string {
    if (value === undefined) return "(unset)";

    if (Array.isArray(value)) return value.length === 0 ? "(empty)" : value.join(", ");

    return String(value);
}

function maskEndpoint(endpoint: string | undefined): string | undefined {
    return endpoint?.replace(/(\/devtools\/browser\/).*$/, "$1<id>");
}

export function formatConfigReport(report: ConfigReport): string {
    const { config } = report;
    const rows: Array<[string, unknown]> = [
        ["browser", config.browser],
        ["mode", config.mode],
        ["headless", config.headless],
        ["profileDir", config.profileDir],
        ["debugPort", config.debugPort],
        ["wsEndpoint", maskEndpoint(config.wsEndpoint)],
        ["allowFocus", config.allowFocus],
        ["isolated", config.isolated],
        ["tools", config.tools === undefined || config.tools.length === 0 ? "(all)" : config.tools],
        ["excludeTools", config.excludeTools],
        ["auditLog", config.auditLog],
        ["safety.readOnly", config.safety.readOnly],
        ["safety.allowedDomains", config.safety.allowedDomains],
        ["safety.deniedDomains", config.safety.deniedDomains],
        ["safety.allowPrivateNetworks", config.safety.allowPrivateNetworks],
        ["safety.confirmDangerous", config.safety.confirmDangerous],
    ];
    const nameWidth = Math.max(...rows.map(([name]) => name.length));
    const valueWidth = Math.max(...rows.map(([, value]) => show(value).length));
    const lines = rows.map(([name, value]) => {
        const source = report.sources[name] ?? "default";

        return `${name.padEnd(nameWidth)}  ${show(value).padEnd(valueWidth)}  ${source}`;
    });
    const file = report.exists ? "found" : "not found, the defaults apply";

    return [
        `Config file: ${report.file} (${file})`,
        "Each value comes from the last of: default, file, env (CHROMIUM_DEVTOOLS_MCP_*), flag.",
        "",
        ...lines,
        "",
        "The configuration is valid.",
        "",
    ].join("\n");
}

export function explainConfigError(error: unknown): string {
    return `${error instanceof ConfigError ? error.message : String(error)}\n`;
}
