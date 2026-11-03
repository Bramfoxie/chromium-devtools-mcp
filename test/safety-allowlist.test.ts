import { describe, expect, it } from "vitest";
import { describeUrlHost, isHostAllowed, isUrlAllowed } from "../src/safety/index.js";

const allow = (url: string, ...patterns: string[]) => isUrlAllowed(url, patterns);

describe("isUrlAllowed", () => {
    it("allows everything when the list is empty", () => {
        expect(allow("https://anything.example/")).toBe(true);
        expect(allow("file:///etc/hosts")).toBe(true);
    });

    it("matches an exact host on any port and either scheme", () => {
        expect(allow("https://example.com/a", "example.com")).toBe(true);
        expect(allow("http://example.com:8080/", "example.com")).toBe(true);
        expect(allow("https://EXAMPLE.com./", "example.com")).toBe(true);
        expect(allow("https://www.example.com/", "example.com")).toBe(false);
        expect(allow("https://badexample.com/", "example.com")).toBe(false);
    });

    it("matches subdomains with a wildcard but not the bare domain", () => {
        expect(allow("https://a.example.com/", "*.example.com")).toBe(true);
        expect(allow("https://a.b.example.com/", "*.example.com")).toBe(true);
        expect(allow("https://example.com/", "*.example.com")).toBe(false);
        expect(allow("https://evilexample.com/", "*.example.com")).toBe(false);
        expect(allow("https://example.com.evil.test/", "*.example.com")).toBe(false);
    });

    it("pins the port only when the pattern carries one", () => {
        expect(allow("http://localhost:3000/", "localhost:3000")).toBe(true);
        expect(allow("http://localhost:3001/", "localhost:3000")).toBe(false);
        expect(allow("http://localhost/", "localhost:80")).toBe(true);
        expect(allow("https://example.com/", "example.com:443")).toBe(true);
        expect(allow("https://example.com:444/", "example.com:443")).toBe(false);
        expect(allow("http://[::1]:3000/", "[::1]:3000")).toBe(true);
    });

    it("refuses other schemes, bad URLs and bad patterns", () => {
        expect(allow("file:///etc/hosts", "example.com")).toBe(false);
        expect(allow("data:text/html,x", "example.com")).toBe(false);
        expect(allow("chrome://settings", "example.com")).toBe(false);
        expect(allow("not a url", "example.com")).toBe(false);
        expect(allow("https://example.com/", "https://example.com")).toBe(false);
        expect(allow("https://example.com/", "*")).toBe(false);
    });

    it("always allows about:blank", () => {
        expect(allow("about:blank", "example.com")).toBe(true);
    });

    it("accepts any matching pattern of several", () => {
        expect(allow("https://b.test/", "a.test", "b.test")).toBe(true);
    });
});

describe("isHostAllowed and describeUrlHost", () => {
    it("checks a bare host", () => {
        expect(isHostAllowed("a.example.com", ["*.example.com"])).toBe(true);
        expect(isHostAllowed("example.org", ["*.example.com"])).toBe(false);
    });

    it("names the host of a URL for messages", () => {
        expect(describeUrlHost("https://a.example.com:8443/x")).toBe("a.example.com:8443");
        expect(describeUrlHost("file:///etc/hosts")).toBe("a file page");
        expect(describeUrlHost("garbage")).toBe("an unknown page");
    });
});
