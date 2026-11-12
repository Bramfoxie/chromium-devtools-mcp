export {
    DOMAIN_RULE_FORMS,
    describeUrlHost,
    isHostAllowed,
    isRestricted,
    isUrlAllowed,
    isValidDomainRule,
} from "./allowlist.js";

export { originOfUrl, webOrigin } from "./origin.js";

export { addressesArePrivate, isPrivateHost } from "./private-network.js";

export {
    describeBlock,
    domainBlock,
    hostBlock,
    hostToResolve,
    isPolicyActive,
    navigationBlock,
    type Block,
    type DomainPolicy,
    type NavigationPolicy,
} from "./policy.js";
