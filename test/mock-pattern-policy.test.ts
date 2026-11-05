import { describe, expect, it } from "vitest";
import { checkMockPattern } from "../src/tools/mock/pattern-policy.js";

const allow = { allowedDomains: ["api.example.com", "*.cdn.example.com", "localhost:3000"], deniedDomains: [] };

describe("checkMockPattern", () => {
    it("accepts a pattern whose host the allowed rules name", () => {
        expect(checkMockPattern("https://api.example.com/v1/*", allow)).toEqual({ ok: true });
        expect(checkMockPattern("*://api.example.com/*", allow)).toEqual({ ok: true });
        expect(checkMockPattern("http://api.example.com:8080/x", allow)).toEqual({ ok: true });
        expect(checkMockPattern("https://static.cdn.example.com/a.js", allow)).toEqual({ ok: true });
    });

    it("accepts a wildcard in front of a host that the rules accept", () => {
        expect(checkMockPattern("https://*.cdn.example.com/*", allow)).toEqual({ ok: true });
    });

    it("refuses a host outside the allowed rules and names it", () => {
        expect(checkMockPattern("https://evil.test/*", allow)).toEqual({
            ok    : false,
            reason: "host",
            host  : "evil.test",
            block : "outside-allowed",
        });
        expect(checkMockPattern("https://*.evil.test/*", allow)).toMatchObject({ ok: false, reason: "host" });
        expect(checkMockPattern("https://*.example.com/*", allow)).toMatchObject({ ok: false });
    });

    it("refuses a host that is denied, also under an allowed wildcard", () => {
        const policy = { allowedDomains: ["*.example.com"], deniedDomains: ["secret.example.com"] };

        expect(checkMockPattern("https://secret.example.com/*", policy)).toMatchObject({
            ok   : false,
            block: "denied",
        });
        expect(checkMockPattern("https://www.example.com/*", policy)).toEqual({ ok: true });
    });

    it("refuses a wildcard host that covers a denied host", () => {
        const policy = { allowedDomains: [], deniedDomains: ["secret.example.com", "*.internal.test:8443"] };

        expect(checkMockPattern("https://*.example.com/*", policy)).toMatchObject({ ok: false, block: "denied" });
        expect(checkMockPattern("https://*.test/*", policy)).toMatchObject({ ok: false, block: "denied" });
        expect(checkMockPattern("https://*.other.com/*", policy)).toEqual({ ok: true });
    });

    it("refuses a pattern that does not name a host", () => {
        for (const pattern of [
            "*",
            "**/api/*",
            "https://*/*",
            "https://api.*/x",
            "https://api.example.c?m/x",
            "https://user@api.example.com/x",
            "/api/*",
            "ftp://api.example.com/*",
            "",
        ]) {
            expect(checkMockPattern(pattern, allow), pattern).toEqual({ ok: false, reason: "unparsable" });
        }
    });

    it("understands an escaped character in the host and ignores case", () => {
        expect(checkMockPattern("https://API.Example.com/*", allow)).toEqual({ ok: true });
        expect(checkMockPattern("https://api\\.example\\.com/*", allow)).toEqual({ ok: true });
    });

    it("works with a block list alone", () => {
        const deny = { allowedDomains: [], deniedDomains: ["bad.test"] };

        expect(checkMockPattern("https://good.test/*", deny)).toEqual({ ok: true });
        expect(checkMockPattern("https://bad.test/*", deny)).toMatchObject({ ok: false, block: "denied" });
    });
});
