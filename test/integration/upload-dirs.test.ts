import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    await writeFile(join(allowed, "stable.txt"), "original");
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
    env.fixture.pages.set("/consumed", html(`<input id="f" type="file">
        <script>document.querySelector('#f').addEventListener('change', (event) => {
            document.body.dataset.received = event.target.files[0].name;
            event.target.value = '';
        });</script>`));
    env.fixture.pages.set("/removed", html(`<input id="f" type="file">
        <script>document.querySelector('#f').addEventListener('change', (event) => {
            document.body.dataset.received = event.target.files[0].name;
            event.target.remove();
        });</script>`));
});

afterAll(async () => {
    await env?.stop();
    if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!present)("input_upload with safety.uploadDirs in a real browser", () => {
    it("does not report a failure when the page consumes and clears the input", async () => {
        const tab = await env.open("/consumed");
        const result = await env.call("input_upload", {
            tab,
            target: { selector: "#f" },
            files : [join(allowed, "ok.txt")],
        });

        expect(result.isError).toBe(false);
        expect(result.data).toMatchObject({ ok: true, inputFilesMatch: false });
        expect(result.data.effect).toContain("verify");
        const page = await env.ok("js_evaluate", { tab, expression: "document.body.dataset.received" });

        expect(page.value).toBe("ok.txt");
    });

    it("attaches a file from an allowed directory", async () => {
        const tab = await env.open("/form");
        const attached = await env.ok("input_upload", {
            tab,
            target: { selector: "#f" },
            files : [join(allowed, "ok.txt")],
        });

        expect(attached.files).toEqual([{ name: "ok.txt", size: 4 }]);
        expect(attached.inputFilesMatch).toBe(true);
    });

    it.skipIf(process.platform === "win32")("reports the name the page receives for a symbolic link", async () => {
        const alias = join(allowed, "alias.txt");

        await symlink(join(allowed, "ok.txt"), alias);
        const tab = await env.open("/form");
        const attached = await env.ok("input_upload", {
            tab, target: { selector: "#f" }, files: [alias],
        });
        const page = await env.ok("js_evaluate", {
            tab, expression: "document.querySelector('#f').files[0].name",
        });

        expect(attached.files).toEqual([{ name: page.value, size: 4 }]);
    });

    it("keeps selected contents available after the original file changes", async () => {
        const tab = await env.open("/form");
        const file = join(allowed, "stable.txt");
        const modified = (await stat(file)).mtimeMs;

        await env.ok("input_upload", { tab, target: { selector: "#f" }, files: [file] });
        const metadata = await env.ok("js_evaluate", {
            tab, expression: "document.querySelector('#f').files[0].lastModified",
        });

        expect(Math.abs(Number(metadata.value) - modified)).toBeLessThan(2);
        await writeFile(file, "replacement");
        const result = await env.ok("js_evaluate", {
            tab, expression: "document.querySelector('#f').files[0].text()",
        });

        expect(result.value).toBe("original");
    });

    it("does not report a failure when the page removes the input after consuming it", async () => {
        const tab = await env.open("/removed");
        const result = await env.call("input_upload", {
            tab,
            target: { selector: "#f" },
            files : [join(allowed, "ok.txt")],
        });

        expect(result.isError).toBe(false);
        expect(result.data).toMatchObject({ ok: true, inputFilesMatch: false });
        const page = await env.ok("js_evaluate", { tab, expression: "document.body.dataset.received" });

        expect(page.value).toBe("ok.txt");
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
