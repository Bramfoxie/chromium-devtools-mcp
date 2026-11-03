import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { checkSafety } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";

const readOnly: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, readOnly: true },
};

describe("checkSafety", () => {
    it("allows read tools in every mode", () => {
        expect(checkSafety({ tool: "list_tabs", access: "read", config: managedConfig })).toEqual({
            allowed: true,
        });
        expect(checkSafety({ tool: "page_info", access: "read", config: readOnly })).toEqual({
            allowed: true,
        });
    });

    it("allows mutate tools when read-only is off", () => {
        expect(checkSafety({ tool: "new_tab", access: "mutate", config: managedConfig })).toEqual({
            allowed: true,
        });
    });

    it("refuses mutate tools when read-only is on with a reason and a hint", () => {
        const decision = checkSafety({ tool: "new_tab", access: "mutate", config: readOnly });

        expect(decision).toEqual({
            allowed: false,
            reason : "new_tab changes page or browser state and is refused in read-only mode.",
            hint   : "Run without --read-only to allow changes.",
        });
    });
});

const restricted: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, allowedDomains: ["example.com", "*.test"] },
};

describe("checkSafety allowed domains", () => {
    const base = { tool: "page_navigate", access: "mutate", config: restricted } as const;

    it("does not restrict an empty list or read tools", () => {
        const url = "https://evil.example/";

        expect(checkSafety({ ...base, config: managedConfig, target: { url } }).allowed).toBe(true);
        expect(checkSafety({ ...base, access: "read", target: { url }, tabUrl: url }).allowed).toBe(
            true,
        );
    });

    it("refuses a requested URL outside the list and names the host", () => {
        const decision = checkSafety({ ...base, target: { url: "https://evil.example:8443/x" } });

        expect(decision).toEqual({
            allowed: false,
            reason : "page_navigate would open evil.example:8443, which is outside safety.allowedDomains.",
            hint   : "Use an allowed domain, or ask the owner to add it to safety.allowedDomains.",
        });
    });

    it("allows a requested URL on the list", () => {
        expect(checkSafety({ ...base, target: { url: "https://a.test/" } }).allowed).toBe(true);
    });

    it("refuses a tab that shows a forbidden page", () => {
        const decision = checkSafety({ ...base, tool: "click", tabUrl: "https://evil.example/" });

        expect(decision).toMatchObject({
            allowed: false,
            reason : "click acts on a tab that shows evil.example, which is outside safety.allowedDomains.",
            hint   : "Navigate the tab to an allowed domain with page_navigate first.",
        });
        expect(checkSafety({ ...base, tabUrl: "about:blank" }).allowed).toBe(true);
        expect(checkSafety({ ...base, tabUrl: "chrome://settings" }).allowed).toBe(false);
    });

    it("refuses a frame from a forbidden origin and allows inherited frames", () => {
        const frame = (url: string, origin?: string) => ({
            frameId: "f",
            url,
            ...(origin === undefined ? {} : { origin }),
        });

        expect(
            checkSafety({ ...base, frame: frame("https://evil.example/p", "https://evil.example") }),
        ).toMatchObject({ allowed: false, reason: expect.stringContaining("frame from evil.example") });
        expect(checkSafety({ ...base, frame: frame("about:srcdoc") }).allowed).toBe(true);
        expect(
            checkSafety({ ...base, frame: frame("https://example.com/p", "https://example.com") })
                .allowed,
        ).toBe(true);
    });
});
