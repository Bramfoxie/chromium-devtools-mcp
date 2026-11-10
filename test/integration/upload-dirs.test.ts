import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;
let root: string;
let allowed: string;
let outside: string;

beforeAll(async () => {
    if (!present) return;

    root = await realpath(await mkdtemp(join(tmpdir(), "cdm-upload-dirs-")));
    allowed = join(root, "allowed");
    outside = join(root, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(join(allowed, "ok.txt"), "fine");
    await writeFile(join(outside, "secret.txt"), "secret");

    try {
        await symlink(join(outside, "secret.txt"), join(allowed, "link.txt"));
    } catch {
        // Links may be unavailable; the symbolic link case is then skipped.
    }

    env = await startEnv({
        readOnly            : false,
        allowedDomains      : [],
        deniedDomains       : [],
        allowPrivateNetworks: true,
        confirmDangerous    : false,
        uploadDirs          : [allowed],
    });
    env.fixture.pages.set("/form", html('<input id="f" type="file">'));
});

afterAll(async () => {
    await env?.stop();
    if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!present)("input_upload with safety.uploadDirs in a real browser", () => {
    it("attaches a file from an allowed directory", async () => {
        const tab = await env.open("/form");
        const attached = await env.ok("input_upload", {
            tab,
            target: { selector: "#f" },
            files : [join(allowed, "ok.txt")],
        });

        expect(attached.files).toEqual([{ name: "ok.txt", size: 4 }]);
    });

    it("refuses a file outside the allowed directories and a link that leaves them", async () => {
        const tab = await env.open("/form");
        const outsideFile = await env.call("input_upload", {
            tab,
            target: { selector: "#f" },
            files : [join(outside, "secret.txt")],
        });

        expect(outsideFile.isError).toBe(true);
        expect(outsideFile.text).toContain("safety.uploadDirs");

        const viaLink = await env.call("input_upload", {
            tab,
            target: { selector: "#f" },
            files : [join(allowed, "link.txt")],
        });

        expect(viaLink.isError).toBe(true);
    });
});
