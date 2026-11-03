import { describe, expect, it } from "vitest";
import { daemonIdentity, differingFields } from "../src/daemon/identity.js";

const attach = {
    browser   : "chrome",
    mode      : "attach",
    debugPort : 9222,
    allowFocus: false,
    headless  : false,
    profileDir: "/p",
} as const;

describe("daemon identity with an explicit endpoint", () => {
    it("carries the endpoint in attach mode only", () => {
        const wsEndpoint = "ws://127.0.0.1:9444/devtools/browser/abc";

        expect(daemonIdentity({ ...attach, wsEndpoint }).wsEndpoint).toBe(wsEndpoint);
        expect("wsEndpoint" in daemonIdentity(attach)).toBe(false);
        expect(daemonIdentity({ ...attach, mode: "managed", wsEndpoint })).not.toHaveProperty(
            "wsEndpoint",
        );
    });

    it("names the endpoint as a differing field", () => {
        const first = daemonIdentity({ ...attach, wsEndpoint: "ws://127.0.0.1:1/devtools/browser/a" });
        const second = daemonIdentity({ ...attach, wsEndpoint: "ws://127.0.0.1:2/devtools/browser/b" });

        expect(differingFields(first, second)).toEqual(["wsEndpoint"]);
        expect(differingFields(first, daemonIdentity(attach))).toEqual(["wsEndpoint"]);
        expect(differingFields(first, first)).toEqual([]);
    });
});
