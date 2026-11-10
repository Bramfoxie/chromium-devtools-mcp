import { lookup } from "node:dns/promises";

export type HostResolver = (host: string) => Promise<string[]>;

const LOOKUP_TIMEOUT_MS = 3000;

const MISSING_NAME_CODES = new Set(["ENOTFOUND", "ENODATA"]);

// Resolves to no addresses when the name does not exist and rejects on any other failure.
export function systemResolver(timeoutMs: number = LOOKUP_TIMEOUT_MS): HostResolver {
    return async (host) => {
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("The lookup timed out.")), timeoutMs);
        });

        try {
            const lookedUp = lookup(host, { all: true, verbatim: true });
            const found = await Promise.race([lookedUp, expired]);

            return found.map((entry) => entry.address);
        } catch (error) {
            const code = (error as { code?: unknown } | null)?.code;

            if (typeof code === "string" && MISSING_NAME_CODES.has(code)) return [];

            throw error;
        } finally {
            clearTimeout(timer);
        }
    };
}
