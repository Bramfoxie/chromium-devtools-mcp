import { describe, expect, it } from "vitest";
import {
    describeBlock,
    domainBlock,
    hostBlock,
    isPolicyActive,
    isPrivateHost,
    navigationBlock,
    type NavigationPolicy,
} from "../src/safety/index.js";

const open: NavigationPolicy = {
    allowedDomains      : [],
    deniedDomains       : [],
    allowPrivateNetworks: true,
};

const policy = (patch: Partial<NavigationPolicy>): NavigationPolicy => ({ ...open, ...patch });

describe("isPrivateHost", () => {
    it.each([
        "localhost",
        "LOCALHOST.",
        "app.localhost",
        "printer.local",
        "db.internal",
        "nas.lan",
        "127.0.0.1",
        "127.9.9.9",
        "10.0.0.5",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.100",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "198.18.0.1",
        "[::1]",
        "[::]",
        "[fe80::1]",
        "[fc00::1]",
        "[fd12:3456::1]",
        "[::ffff:127.0.0.1]",
        "[::ffff:7f00:1]",
        "[::ffff:192.168.1.1]",
        "[64:ff9b::a00:1]",
    ])("treats %s as private", (host) => {
        expect(isPrivateHost(host)).toBe(true);
    });

    it.each([
        "example.com",
        "localhost.example.com",
        "mylocalhost",
        "8.8.8.8",
        "172.15.0.1",
        "172.32.0.1",
        "100.63.0.1",
        "100.128.0.1",
        "192.169.0.1",
        "169.253.0.1",
        "[2001:4860:4860::8888]",
        "[::ffff:8.8.8.8]",
        "[2606:4700::1111]",
        "",
    ])("treats %s as public", (host) => {
        expect(isPrivateHost(host)).toBe(false);
    });

    it("sees through the numeric forms the URL parser normalizes", () => {
        for (const url of ["http://2130706433/", "http://0x7f.1/", "http://017700000001/", "http://127.1/"]) {
            expect(isPrivateHost(new URL(url).hostname)).toBe(true);
        }
    });

    it("treats an unreadable IPv6 literal as private", () => {
        expect(isPrivateHost("[zzzz::1]")).toBe(true);
        expect(isPrivateHost("[1:2:3]")).toBe(true);
    });
});

describe("domainBlock and hostBlock", () => {
    it("blocks nothing without rules", () => {
        expect(isPolicyActive(open)).toBe(false);
        expect(domainBlock("https://a.test/", open)).toBeUndefined();
        expect(hostBlock("a.test", open)).toBeUndefined();
    });

    it("blocks a denied host and a subdomain through a wildcard rule", () => {
        const denied = policy({ deniedDomains: ["bad.test", "*.evil.test"] });

        expect(isPolicyActive(denied)).toBe(true);
        expect(domainBlock("https://bad.test/x", denied)).toBe("denied");
        expect(domainBlock("https://sub.evil.test/", denied)).toBe("denied");
        expect(domainBlock("https://evil.test/", denied)).toBeUndefined();
        expect(domainBlock("https://good.test/", denied)).toBeUndefined();
        expect(hostBlock("bad.test", denied)).toBe("denied");
    });

    it("lets a denied-only policy pass pages that are not web pages", () => {
        const denied = policy({ deniedDomains: ["bad.test"] });

        expect(domainBlock("about:blank", denied)).toBeUndefined();
        expect(domainBlock("about:srcdoc", denied)).toBeUndefined();
        expect(domainBlock("chrome://settings", denied)).toBeUndefined();
    });

    it("lets a port in a deny rule match only that port", () => {
        const denied = policy({ deniedDomains: ["bad.test:8080"] });

        expect(domainBlock("http://bad.test:8080/", denied)).toBe("denied");
        expect(domainBlock("http://bad.test/", denied)).toBeUndefined();
    });

    it("lets a denial win over an allow rule", () => {
        const both = policy({ allowedDomains: ["*.site.test"], deniedDomains: ["secret.site.test"] });

        expect(domainBlock("https://www.site.test/", both)).toBeUndefined();
        expect(domainBlock("https://secret.site.test/", both)).toBe("denied");
        expect(domainBlock("https://other.test/", both)).toBe("outside-allowed");
        expect(hostBlock("secret.site.test", both)).toBe("denied");
        expect(hostBlock("other.test", both)).toBe("outside-allowed");
    });
});

describe("navigationBlock", () => {
    const closed = policy({ allowPrivateNetworks: false });

    it("blocks private addresses unless the owner allows them", () => {
        expect(navigationBlock("http://localhost:3000/", closed)).toBe("private");
        expect(navigationBlock("http://192.168.1.1/", closed)).toBe("private");
        expect(navigationBlock("http://169.254.169.254/latest/meta-data", closed)).toBe("private");
        expect(navigationBlock("http://[::1]:8080/", closed)).toBe("private");
        expect(navigationBlock("http://2130706433/", closed)).toBe("private");
        expect(navigationBlock("http://localhost:3000/", open)).toBeUndefined();
    });

    it("leaves public addresses and non-web pages alone", () => {
        expect(navigationBlock("https://example.com/", closed)).toBeUndefined();
        expect(navigationBlock("about:blank", closed)).toBeUndefined();
        expect(navigationBlock("chrome://version", closed)).toBeUndefined();
    });

    it("allows a private host that an allowedDomains rule names, with its port", () => {
        const named = policy({ allowPrivateNetworks: false, allowedDomains: ["localhost:3000"] });

        expect(navigationBlock("http://localhost:3000/app", named)).toBeUndefined();
        expect(navigationBlock("http://localhost:4000/", named)).toBe("outside-allowed");
        expect(navigationBlock("http://127.0.0.1:3000/", named)).toBe("outside-allowed");
    });

    it("does not let a wildcard rule for a public site open a private host", () => {
        const wild = policy({ allowPrivateNetworks: false, allowedDomains: ["*.example.com"] });

        expect(navigationBlock("https://www.example.com/", wild)).toBeUndefined();
        expect(navigationBlock("http://127.0.0.1/", wild)).toBe("outside-allowed");
    });

    it("keeps a denial ahead of the private rule", () => {
        const denied = policy({ allowPrivateNetworks: false, deniedDomains: ["localhost"] });

        expect(navigationBlock("http://localhost/", denied)).toBe("denied");
    });

    it("does not apply to page access, only to navigation", () => {
        expect(domainBlock("http://localhost:3000/", closed)).toBeUndefined();
    });
});

describe("describeBlock", () => {
    it("names the setting that the owner has to change", () => {
        expect(describeBlock("outside-allowed").hint).toContain("safety.allowedDomains");
        expect(describeBlock("denied").reason).toContain("safety.deniedDomains");
        expect(describeBlock("private").hint).toContain("safety.allowPrivateNetworks");
    });
});
