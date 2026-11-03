export { BROWSERS } from "./browsers.js";

export {
    type BrowserName,
    BrowserNotFoundError,
    browserCandidates,
    type DiscoveryContext,
    type DiscoveryOptions,
    findBrowserExecutable,
} from "./discovery.js";

export {
    BrowserLaunchError,
    buildLaunchArgs,
    type ChildHandle,
    launchManaged,
    type LaunchDeps,
    type ManagedBrowser,
    type ManagedConfig,
    parseListeningUrl,
} from "./launch.js";

export {
    AttachError,
    attachBrowser,
    type AttachConfig,
    type AttachDeps,
    type AttachEndpoint,
    browserUserDataDir,
    endpointUnreachableMessage,
    explicitEndpoint,
    findAttachEndpoint,
    probePort,
    type EndpointSource,
    parseActivePortFile,
    resolveAttachEndpoint,
    runningInProfile,
    setupInstructions,
} from "./attach.js";
