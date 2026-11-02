import type { DaemonAccess } from "../../mcp/index.js";

const PRODUCT_MAJOR = /^(?:Headless)?Chrome\/(\d+)\./;
const UA_CHROME_TOKEN = /Chrome\/\d+\.0\.0\.0/;

export function chromeMajorOf(product: unknown): number | undefined {
    if (typeof product !== "string") return undefined;

    const match = PRODUCT_MAJOR.exec(product);

    return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function withChromeMajor(userAgent: string, major: number | undefined): string {
    if (major === undefined) return userAgent;

    return userAgent.replace(UA_CHROME_TOKEN, `Chrome/${major}.0.0.0`);
}

export async function connectedChromeMajor(
    access  : DaemonAccess,
    targetId: string,
): Promise<number | undefined> {
    try {
        const version = await access.send(targetId, "Browser.getVersion", {});

        return chromeMajorOf((version as { product?: unknown } | null)?.product);
    } catch {
        return undefined;
    }
}
