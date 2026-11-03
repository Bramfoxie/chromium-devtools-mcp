import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realFs } from "../src/install/fs.js";

const dirs: string[] = [];

function temp(): string {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "install-fs-"));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true });
});

describe("realFs", () => {
    it("reads a missing file as undefined and rethrows other errors", () => {
        const dir = temp();

        expect(realFs.read(path.join(dir, "none"))).toBeUndefined();
        expect(() => realFs.read(dir)).toThrow();
    });

    it("creates missing directories and leaves no temp file", () => {
        const dir = temp();
        const file = path.join(dir, "a", "b", "c.json");

        realFs.writeFile(file, "x");

        expect(nodeFs.readFileSync(file, "utf8")).toBe("x");
        expect(nodeFs.readdirSync(path.dirname(file))).toEqual(["c.json"]);
    });

    it.skipIf(process.platform === "win32")("keeps the mode of an existing file", () => {
        const file = path.join(temp(), "f");

        nodeFs.writeFileSync(file, "old", { mode: 0o640 });
        realFs.writeFile(file, "new");

        expect(nodeFs.statSync(file).mode & 0o777).toBe(0o640);
        expect(nodeFs.readFileSync(file, "utf8")).toBe("new");
    });

    it.skipIf(process.platform === "win32")("writes through a symlink and keeps the link", () => {
        const dir = temp();
        const real = path.join(dir, "real");
        const link = path.join(dir, "link");

        nodeFs.writeFileSync(real, "old");
        nodeFs.symlinkSync(real, link);
        realFs.writeFile(link, "new");

        expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(nodeFs.readFileSync(real, "utf8")).toBe("new");
    });

    it("copies a file", () => {
        const dir = temp();

        nodeFs.writeFileSync(path.join(dir, "a"), "data");
        realFs.copy(path.join(dir, "a"), path.join(dir, "b"));

        expect(nodeFs.readFileSync(path.join(dir, "b"), "utf8")).toBe("data");
    });
});
