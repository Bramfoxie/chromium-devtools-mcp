import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpProtocolError } from "../src/cdp/index.js";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import { PermissionLedger } from "../src/daemon/permissions.js";
import { SessionRegistry } from "../src/daemon/sessions.js";
import { FakeBackend } from "./helpers/fake-backend.js";

afterEach(() => {
    vi.restoreAllMocks();
});

const SITE = "https://a.example";
const OTHER = "https://b.example";

function setup() {
    const backend = new FakeBackend();
    const registry = new SessionRegistry<string>(backend, { allowFocus: false });
    const open = (
        key    : string,
        options: { isolated?: boolean; safety?: Parameters<typeof registry.open>[2]["safety"] } = {},
    ) =>
        registry.open(key, () => undefined, {
            isolated  : options.isolated ?? false,
            clientName: key,
            ...(options.safety === undefined ? {} : { safety: options.safety }),
        });

    return { backend, registry, open };
}

const grant = { name: "geolocation", setting: "granted" } as const;
const reset = { name: "geolocation", setting: "reset" } as const;

async function code(promise: Promise<unknown>): Promise<string | undefined> {
    const error = await promise.then(() => undefined, (failure: unknown) => failure);

    return error instanceof RpcError ? error.code : undefined;
}

describe("PermissionLedger", () => {
    it("keeps a grant that is made while another holder lets go of the same origin", async () => {
        const calls: string[] = [];
        let open: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        const ledger = new PermissionLedger({
            setPermission: async (entry) => {
                calls.push(`set ${entry.origin}`);
                await gate;
            },
            resetPermissions: async () => {
                calls.push("reset");
            },
        });
        const first = {};
        const second = {};
        const entry = { name: "geolocation", origin: SITE, contextId: undefined } as const;

        open?.();
        await ledger.grant(first, entry);

        const release = ledger.release(first, entry);
        const regrant = ledger.grant(second, entry);

        await Promise.all([release, regrant]);

        expect(calls).toEqual(["set " + SITE, "reset", "set " + SITE]);
    });

    it("removes an override only when the last holder lets go and keeps the others", async () => {
        const backend = new FakeBackend();
        const ledger = new PermissionLedger(backend);
        const first = {};
        const second = {};
        const a = { name: "geolocation", origin: SITE, contextId: undefined } as const;
        const b = { name: "geolocation", origin: OTHER, contextId: undefined } as const;

        await ledger.grant(first, a);
        await ledger.grant(second, a);
        await ledger.grant(first, b);

        await ledger.release(first, a);
        expect(backend.permissions.size).toBe(2);
        expect(backend.log).not.toContain("resetPermissions default");

        await ledger.release(second, a);
        expect([...backend.permissions.values()].map((entry) => entry.origin)).toEqual([OTHER]);
        expect(backend.log.filter((line) => line === "resetPermissions default")).toHaveLength(1);
    });

    it("ignores a release by a holder that never granted", async () => {
        const backend = new FakeBackend();
        const ledger = new PermissionLedger(backend);

        await ledger.release({}, { name: "geolocation", origin: SITE, contextId: undefined });

        expect(backend.log).toEqual([]);
    });

    it("does not reset a context that is being disposed", async () => {
        const backend = new FakeBackend();
        const ledger = new PermissionLedger(backend);
        const holder = {};

        await ledger.grant(holder, { name: "geolocation", origin: SITE, contextId: "ctx9" });
        await ledger.releaseAll(holder, "ctx9");

        expect(backend.log.some((line) => line.startsWith("resetPermissions"))).toBe(false);
    });

    it("keeps going and logs when the browser refuses a reset", async () => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const backend = new FakeBackend();
        const ledger = new PermissionLedger(backend);
        const holder = {};
        const entry = { name: "geolocation", origin: SITE, contextId: undefined } as const;

        await ledger.grant(holder, entry);

        backend.resetPermissions = async () => {
            throw new Error("browser went away");
        };

        await expect(ledger.release(holder, entry)).resolves.toBeUndefined();
    });
});

describe("permission.set on a session", () => {
    it("grants geolocation for an origin and resets it", async () => {
        const { backend, open } = setup();
        const session = await open("a");

        await session.setPermission({ ...grant, origin: SITE });
        expect(backend.log).toContain(`setPermission geolocation ${SITE} default`);

        await session.setPermission({ ...reset, origin: SITE });
        expect(backend.permissions.size).toBe(0);
    });

    it("grants inside the isolated context of the session", async () => {
        const { backend, open } = setup();
        const session = await open("a", { isolated: true });

        await session.setPermission({ ...grant, origin: SITE });

        expect([...backend.permissions.values()][0]?.contextId).toBe(session.contextId);
    });

    it.each([
        "example.com",
        "ftp://example.com",
        "https://example.com/path",
        "https://example.com/",
        "javascript:alert(1)",
        "not a url",
    ])("rejects the malformed origin %s", async (origin) => {
        const { backend, open } = setup();
        const session = await open("a");

        expect(await code(session.setPermission({ ...grant, origin }))).toBe(ErrorCode.badRequest);
        expect(backend.permissions.size).toBe(0);
    });

    it("is refused in read-only mode", async () => {
        const { backend, open } = setup();
        const session = await open("a", {
            safety: {
                readOnly            : true,
                allowedDomains      : [],
                deniedDomains       : [],
                allowPrivateNetworks: true,
                confirmDangerous    : false,
            },
        });

        expect(await code(session.setPermission({ ...grant, origin: SITE }))).toBe(
            ErrorCode.forbiddenMethod,
        );
        expect(backend.permissions.size).toBe(0);
    });

    it("is refused for an origin outside allowedDomains", async () => {
        const { backend, open } = setup();
        const session = await open("a", {
            safety: { readOnly: false, allowedDomains: ["a.example"], deniedDomains: [], allowPrivateNetworks: true, confirmDangerous: false },
        });

        expect(await code(session.setPermission({ ...grant, origin: OTHER }))).toBe(
            ErrorCode.forbiddenMethod,
        );
        await session.setPermission({ ...grant, origin: SITE });
        expect(backend.permissions.size).toBe(1);
    });

    it("lets go of its grants when the session closes and leaves other sessions alone", async () => {
        const { backend, registry, open } = setup();
        const first = await open("a");
        const second = await open("b");

        await first.setPermission({ ...grant, origin: SITE });
        await second.setPermission({ ...grant, origin: SITE });
        await first.setPermission({ ...grant, origin: OTHER });
        await registry.close("a");

        expect([...backend.permissions.values()].map((entry) => entry.origin)).toEqual([SITE]);

        await registry.close("b");
        expect(backend.permissions.size).toBe(0);
    });

    it("does not reset the browser when an isolated session closes", async () => {
        const { backend, registry, open } = setup();
        const session = await open("a", { isolated: true });

        await session.setPermission({ ...grant, origin: SITE });
        await registry.close("a");

        expect(backend.log.some((line) => line.startsWith("resetPermissions"))).toBe(false);
    });

    it("reports a browser failure as a cdp error", async () => {
        const { backend, open } = setup();
        const session = await open("a");

        backend.permissionFailure = new CdpProtocolError("Browser.setPermission", -32000, "denied");

        const outcome = await code(session.setPermission({ ...grant, origin: SITE }));

        expect(outcome).toBe(ErrorCode.cdpError);
    });

    it("refuses a closed session", async () => {
        const { registry, open } = setup();
        const session = await open("a");

        await registry.close("a");

        const outcome = await code(session.setPermission({ ...grant, origin: SITE }));

        expect(outcome).toBe(ErrorCode.sessionClosed);
    });
});
