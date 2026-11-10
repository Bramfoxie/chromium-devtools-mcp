import { addressesArePrivate, describeBlock, hostToResolve } from "../safety/index.js";
import type { Config } from "../config/index.js";
import type { HostResolver } from "./host-resolver.js";

export interface ResolutionProblem {
    reason: string;
    hint  : string;
}

// Returns why a public name must not be opened, or undefined when it may be.
export async function resolutionProblem(
    url    : string,
    safety : Config["safety"],
    resolve: HostResolver,
): Promise<ResolutionProblem | undefined> {
    const host = hostToResolve(url, safety);

    if (host === undefined) return undefined;

    let addresses: string[];

    try {
        addresses = await resolve(host);
    } catch {
        return {
            reason: `the name ${host} could not be resolved to check it against safety.allowPrivateNetworks`,
            hint  : "Try again, or ask the owner to list the host in safety.allowedDomains.",
        };
    }

    return addressesArePrivate(addresses) ? describeBlock("resolved-private") : undefined;
}
