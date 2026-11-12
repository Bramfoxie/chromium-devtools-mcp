import { describe, expect, it } from "vitest";
import { addressesArePrivate, hostToResolve, isPrivateHost } from "../src/safety/index.js";

const open = { allowedDomains: [], deniedDomains: [], allowPrivateNetworks: false };

describe("hostToResolve", () => {
    it("names the host of a public web address", () => {
        expect(hostToResolve("https://Example.com:8443/a?b=1", open)).toBe("example.com");
        expect(hostToResolve("http://sub.example.org./", open)).toBe("sub.example.org");
    });

    it("skips what needs no lookup", () => {
        expect(hostToResolve("https://example.com/", { ...open, allowPrivateNetworks: true })).toBeUndefined();
        expect(hostToResolve("http://127.0.0.1/", open)).toBeUndefined();
        expect(hostToResolve("http://[2001:db8::1]/", open)).toBeUndefined();
        expect(hostToResolve("about:blank", open)).toBeUndefined();
        expect(hostToResolve("file:///etc/hosts", open)).toBeUndefined();
        expect(hostToResolve("not a url", open)).toBeUndefined();
    });

    it("skips a host that an allowedDomains entry names, also with a wildcard", () => {
        const named = { ...open, allowedDomains: ["dev.example.com:3000", "*.corp.example"] };

        expect(hostToResolve("http://dev.example.com:3000/", named)).toBeUndefined();
        expect(hostToResolve("http://app.corp.example/", named)).toBeUndefined();
    });
});

describe("addressesArePrivate", () => {
    it("is true when any address is private", () => {
        expect(addressesArePrivate(["93.184.216.34", "10.0.0.5"])).toBe(true);
        expect(addressesArePrivate(["127.0.0.1"])).toBe(true);
        expect(addressesArePrivate(["::1"])).toBe(true);
        expect(addressesArePrivate(["fe80::1%en0"])).toBe(true);
        expect(addressesArePrivate(["::ffff:192.168.1.1"])).toBe(true);
    });

    it("is false for public addresses and for none", () => {
        expect(addressesArePrivate(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])).toBe(false);
        expect(addressesArePrivate([])).toBe(false);
    });

    it("ignores the 198.18.0.0/15 range that proxy tools hand out for public names", () => {
        expect(addressesArePrivate(["198.18.0.7"])).toBe(false);
        expect(addressesArePrivate(["198.19.255.1"])).toBe(false);
        expect(addressesArePrivate(["198.18.0.7", "10.0.0.1"])).toBe(true);
        expect(isPrivateHost("198.18.0.7")).toBe(true);
    });

    it("treats an address that cannot be read as private", () => {
        expect(addressesArePrivate(["nonsense"])).toBe(true);
    });
});
