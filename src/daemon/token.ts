import { randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathFor } from "../config/index.js";
import { DaemonError, errorCode } from "./errors.js";
import { ensurePrivateDir } from "./private-dir.js";

const LOCK_WAIT_MS = 5000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function generateToken(): string {
    return randomBytes(32).toString("hex");
}

export async function readToken(file: string): Promise<string | undefined> {
    let content: string;

    try {
        content = (await readFile(file, "utf8")).trim();
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;

        throw error;
    }

    return TOKEN_PATTERN.test(content) ? content : undefined;
}

export async function ensureToken(
    file: string,
    platform: NodeJS.Platform,
    uid: number | undefined,
    options: { lockWaitMs?: number } = {},
): Promise<string> {
    const existing = await readToken(file);

    if (existing) return existing;

    await ensurePrivateDir(pathFor(platform).dirname(file), platform, uid);
    const token = generateToken();
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;

    try {
        await writeFile(temporary, token, { mode: 0o600, flag: "wx" });
        await publishToken(file, temporary, options.lockWaitMs ?? LOCK_WAIT_MS);

        return (await readToken(file)) ?? token;
    } finally {
        await rm(temporary, { force: true });
    }
}

async function publishToken(file: string, temporary: string, lockWaitMs: number): Promise<void> {
    try {
        await link(temporary, file);

        return;
    } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
    }

    const lock = `${file}.lock`;
    const deadline = Date.now() + lockWaitMs;

    for (;;) {
        try {
            await mkdir(lock);
            break;
        } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;

            const winner = await readToken(file);

            if (winner) return;

            if (Date.now() >= deadline) {
                throw new DaemonError(
                    `Timed out waiting for the token lock ${lock}. If no other daemon is starting, remove that directory and retry.`,
                );
            }

            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    try {
        try {
            await link(temporary, file);

            return;
        } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
        }

        if (await readToken(file)) return;

        await rm(file, { force: true });
        await link(temporary, file);
    } finally {
        await rm(lock, { recursive: true, force: true });
    }
}

export function tokensMatch(expected: string, provided: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);

    return a.length === b.length && timingSafeEqual(a, b);
}
