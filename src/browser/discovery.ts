import { existsSync } from "node:fs";
import os from "node:os";
import { BROWSERS, type BrowserName, type DiscoveryContext } from "./browsers.js";
import { AppError } from "../util/app-error.js";

export type { BrowserName, DiscoveryContext };

export interface DiscoveryOptions extends Partial<DiscoveryContext> {
    exists?: (file: string) => boolean;
}

export class BrowserNotFoundError extends AppError {}

export function browserCandidates(browser: BrowserName, context: DiscoveryContext): string[] {
    return BROWSERS[browser].executables(context);
}

export function findBrowserExecutable(
    browser: BrowserName,
    options: DiscoveryOptions = {},
): string {
    const context: DiscoveryContext = {
        env     : options.env ?? process.env,
        platform: options.platform ?? process.platform,
        homedir : options.homedir ?? os.homedir(),
    };
    const exists = options.exists ?? existsSync;
    const candidates = browserCandidates(browser, context);

    const found = candidates.find((candidate) => exists(candidate));

    if (found) return found;

    if (candidates.length === 0) {
        throw new BrowserNotFoundError(
            `There is no ${browser} build for ${context.platform}. Choose another browser setting.`,
        );
    }

    throw new BrowserNotFoundError(
        `Could not find ${browser} on ${context.platform}. Install it or check these locations: ${candidates.join(", ")}.`,
    );
}
