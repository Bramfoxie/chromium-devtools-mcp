import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ignoreStreamErrors } from "../src/util/log.js";

describe("ignoreStreamErrors", () => {
    it("keeps a stream error from becoming an unhandled exception", () => {
        const stream = new PassThrough();
        const broken = new Error("write EPIPE");

        expect(() => stream.emit("error", broken)).toThrow(broken);

        ignoreStreamErrors(stream);

        expect(() => stream.emit("error", broken)).not.toThrow();
    });
});
