import { describe, expect, it } from "vitest";
import { declaredTimeoutMs, timeoutClassOf } from "../src/daemon/request-timeouts.js";

describe("request timeout classes", () => {
    it.each([
        ["cdp.send", "cdp-bound"],
        ["tab.create", "cdp-bound"],
        ["frame.list", "multi-step"],
        ["tab.list", "multi-step"],
        ["session.open", "plain"],
        ["nope", "plain"],
        ["__proto__", "plain"],
        ["toString", "plain"],
    ])("classifies %s as %s", (method, expected) => {
        expect(timeoutClassOf(method)).toBe(expected);
    });

    it.each([
        [{ timeoutMs: 1200 }, 1200],
        [{ timeoutMs: "1200" }, undefined],
        [{ timeoutMs: Number.NaN }, undefined],
        [{}, undefined],
        [null, undefined],
        [undefined, undefined],
        ["text", undefined],
    ])("reads the declared timeout of %j", (params, expected) => {
        expect(declaredTimeoutMs(params)).toBe(expected);
    });
});
