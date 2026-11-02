import { describe, expect, it } from "vitest";
import { DEVICES } from "../src/tools/emulation/devices.js";
import { chromeMajorOf, withChromeMajor } from "../src/tools/emulation/user-agent.js";

describe("chromeMajorOf", () => {
    it("reads the major of Chrome and headless Chrome products", () => {
        expect(chromeMajorOf("Chrome/131.0.6778.86")).toBe(131);
        expect(chromeMajorOf("HeadlessChrome/140.0.7339.5")).toBe(140);
    });

    it("returns undefined for anything else", () => {
        expect(chromeMajorOf("Safari/605.1.15")).toBeUndefined();
        expect(chromeMajorOf(undefined)).toBeUndefined();
        expect(chromeMajorOf(12)).toBeUndefined();
    });
});

describe("withChromeMajor", () => {
    it("replaces the reduced Chrome token", () => {
        expect(
            withChromeMajor("Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0.0.0 Safari/537.36", 131),
        ).toBe("Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0 Safari/537.36");
    });

    it("keeps the agent without a major or without a Chrome token", () => {
        const chrome = "Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36";
        const safari = "Mozilla/5.0 (iPhone) Version/18.6 Mobile/15E148 Safari/604.1";

        expect(withChromeMajor(chrome, undefined)).toBe(chrome);
        expect(withChromeMajor(safari, 131)).toBe(safari);
    });
});

describe("device table user agents", () => {
    it("keeps the iPhone OS version and the Version token consistent for iOS Safari", () => {
        const ios = DEVICES.filter((device) => /iPhone OS|CPU OS/.test(device.userAgent));

        expect(ios.length).toBeGreaterThan(0);

        for (const device of ios) {
            const os = /OS (\d+)_(\d+) like Mac OS X/.exec(device.userAgent);
            const version = /Version\/(\d+)\.(\d+) /.exec(device.userAgent);

            expect(`${device.name} ${os?.[1]}.${os?.[2]}`).toBe(`${device.name} ${version?.[1]}.${version?.[2]}`);
            expect(Number(os?.[1])).toBeGreaterThanOrEqual(18);
        }
    });
});
