import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function readIfExists(file: string): Promise<string | undefined> {
    try {
        return await readFile(file, "utf8");
    } catch (error) {
        if (isMissing(error)) return undefined;

        throw error;
    }
}

export function readIfExistsSync(file: string): string | undefined {
    try {
        return readFileSync(file, "utf8");
    } catch (error) {
        if (isMissing(error)) return undefined;

        throw error;
    }
}
