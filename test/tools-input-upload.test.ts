import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
    allTools,
    ElementRegistry,
    inputUpload,
    runTool,
    ToolRuntime,
    UPLOAD_MAX_BYTES,
    validateUploadFiles,
    type UploadEnvironment,
    type UploadFileSystem,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const BOX_MODEL = {
    model: {
        content: [10, 20, 110, 20, 110, 70, 10, 70],
        padding: [10, 20, 110, 20, 110, 70, 10, 70],
        border : [10, 20, 110, 20, 110, 70, 10, 70],
        margin : [10, 20, 110, 20, 110, 70, 10, 70],
    },
};

interface MemoryEntry {
    file    : boolean;
    size    : number;
    readable: boolean;
}

function memoryFs(
    entries: Record<string, MemoryEntry>,
    links  : Record<string, string> = {},
): UploadFileSystem {
    return {
        stat: async (path) => {
            const entry = entries[path];

            if (entry === undefined) throw new Error("ENOENT");

            return { isFile: () => entry.file, size: entry.size };
        },
        access: async (path) => {
            if (entries[path]?.readable !== true) throw new Error("EACCES");
        },
        realpath: async (path) => links[path] ?? path,
    };
}

interface UploadWorld {
    state?           : Record<string, unknown>;
    files?           : number;
    hidden?          : boolean;
    navigateOnAttach?: boolean;
    failCount?       : boolean;
}

function uploadFake(world: UploadWorld = {}): FakeAccess {
    const fake = new FakeAccess();
    let navigated = false;

    fake.respond = (_targetId, method, params) => {
        switch (method) {
            case "DOM.getDocument":
                return { root: { nodeId: 1 } };
            case "DOM.querySelector":
                return { nodeId: 11 };
            case "DOM.resolveNode":
                return { object: { objectId: "obj-11" } };
            case "DOM.describeNode":
                return { node: { backendNodeId: 101 } };
            case "DOM.scrollIntoViewIfNeeded":
                return {};
            case "DOM.getBoxModel":
                if (world.hidden === true) {
                    throw new Error("hidden element has no box model");
                }

                return BOX_MODEL;
            case "DOM.setFileInputFiles":
                navigated = world.navigateOnAttach === true;

                return {};
            case "Emulation.setFocusEmulationEnabled":
                return {};
            case "Runtime.evaluate":
                return {
                    result: {
                        type : "string",
                        value: navigated ? "https://page.example/uploaded" : "https://page.example/",
                    },
                };

            case "Runtime.callFunctionOn": {
                const declaration = String(
                    (params as { functionDeclaration?: unknown })?.functionDeclaration ?? "",
                );

                if (declaration.includes("element.files")) {
                    if (navigated) throw new Error("Cannot find context with specified id");
                    if (world.failCount) throw new Error("element detached");

                    return { result: { type: "object", value: { files: world.files ?? 2 } } };
                }

                return {
                    result: {
                        type : "object",
                        value: {
                            tag       : "input",
                            id        : "resume",
                            classes   : [],
                            disabled  : false,
                            connected : true,
                            editable  : "none",
                            selectable: false,
                            fileInput : true,
                            multiple  : true,
                            ...world.state,
                        },
                    },
                };
            }

            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

function runtimeWith(fake: FakeAccess): { fake: FakeAccess; runtime: ToolRuntime } {
    const runtime = new ToolRuntime({
        access  : fake.asAccess(),
        config  : managedConfig,
        elements: new ElementRegistry(),
    });

    runtime.tabs.refresh(
        [{ targetId: "tab1", url: "https://page.example/", title: "t", owned: true, created: true }],
        "tab1",
    );
    runtime.elements.nextGeneration("tab1");
    runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);

    return { fake, runtime };
}

function contentOf(result: { content: unknown }): string {
    return JSON.stringify(result.content);
}

describe("validateUploadFiles", () => {
    const posixEnv = (fs: UploadFileSystem): UploadEnvironment => ({ fs, path: posix });
    const fs = posixEnv(memoryFs({
        "/tmp/a.txt"   : { file: true, size: 12, readable: true },
        "/tmp/b.txt"   : { file: true, size: 34, readable: true },
        "/tmp/dir"     : { file: false, size: 0, readable: true },
        "/tmp/locked"  : { file: true, size: 8, readable: false },
        "/tmp/huge.bin": { file: true, size: UPLOAD_MAX_BYTES + 1, readable: true },
    }));

    it("accepts absolute readable files and reports names and sizes", async () => {
        await expect(validateUploadFiles(fs, ["/tmp/a.txt", "/tmp/b.txt"])).resolves.toEqual([
            { path: "/tmp/a.txt", name: "a.txt", size: 12 },
            { path: "/tmp/b.txt", name: "b.txt", size: 34 },
        ]);
    });

    it("refuses relative paths, missing paths, directories and unreadable files", async () => {
        await expect(validateUploadFiles(fs, ["relative.txt"])).rejects.toThrow("not absolute");
        await expect(validateUploadFiles(fs, ["/tmp/missing.txt"])).rejects.toThrow("does not exist");
        await expect(validateUploadFiles(fs, ["/tmp/dir"])).rejects.toThrow("not a regular file");
        await expect(validateUploadFiles(fs, ["/tmp/locked"])).rejects.toThrow("not readable");
    });

    it("attaches the resolved real path and keeps the name the caller used", async () => {
        const linked = posixEnv(memoryFs(
            {
                "/tmp/link.txt" : { file: true, size: 3, readable: true },
                "/data/real.txt": { file: true, size: 3, readable: true },
            },
            { "/tmp/link.txt": "/data/real.txt" },
        ));

        await expect(validateUploadFiles(linked, ["/tmp/link.txt"])).resolves.toEqual([
            { path: "/data/real.txt", name: "real.txt", size: 3 },
        ]);
    });

    it("refuses the same file listed twice, also through a link", async () => {
        const linked = posixEnv(memoryFs(
            {
                "/tmp/link.txt" : { file: true, size: 3, readable: true },
                "/data/real.txt": { file: true, size: 3, readable: true },
            },
            { "/tmp/link.txt": "/data/real.txt" },
        ));

        await expect(validateUploadFiles(fs, ["/tmp/a.txt", "/tmp/a.txt"])).rejects.toThrow(
            "more than once",
        );
        await expect(
            validateUploadFiles(linked, ["/data/real.txt", "/tmp/link.txt"]),
        ).rejects.toThrow("more than once");
    });

    it("validates win32 paths with the injected win32 module", async () => {
        const windows: UploadEnvironment = {
            fs  : memoryFs({ "C:\\data\\a.txt": { file: true, size: 5, readable: true } }),
            path: win32,
        };

        await expect(validateUploadFiles(windows, ["C:\\data\\a.txt"])).resolves.toEqual([
            { path: "C:\\data\\a.txt", name: "a.txt", size: 5 },
        ]);
        await expect(validateUploadFiles(windows, ["data\\a.txt"])).rejects.toThrow("not absolute");
        await expect(validateUploadFiles(posixEnv(windows.fs), ["C:\\data\\a.txt"])).rejects
            .toThrow("not absolute");
    });

    it("refuses files over the 100 MiB limit", async () => {
        await expect(validateUploadFiles(fs, ["/tmp/huge.bin"])).rejects.toThrow(
            String(UPLOAD_MAX_BYTES),
        );
    });
});

describe("input_upload", () => {
    it("does not attach a prepared file after cancellation", async () => {
        const fake = uploadFake({ files: 1 });
        const access = fake.asAccess();
        const controller = new AbortController();
        let cleaned: () => void = () => undefined;
        const cleanup = new Promise<void>((resolve) => { cleaned = resolve; });

        access.prepareUploads = async () => {
            controller.abort();

            return { ticket: "a".repeat(32), files: [{ path: "/private/copy", size: 5 }] };
        };

        access.cancelUploads = async () => { cleaned(); };

        const config = { ...managedConfig, safety: { ...managedConfig.safety, uploadDirs: ["/tmp"] } };
        const upload = {
            fs: memoryFs({ "/tmp/file.txt": { file: true, size: 5, readable: true } }), path: posix,
        };
        const runtime = new ToolRuntime({
            access, config, upload, elements: new ElementRegistry(),
        });

        runtime.tabs.refresh(
            [{ targetId: "tab1", url: "https://page.example/", title: "t", owned: true, created: true }],
            "tab1",
        );
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        await runTool(inputUpload, { target: { uid: "1_1" }, files: ["/tmp/file.txt"] },
            { signal: controller.signal } as Extra, runtime);
        await cleanup;
        expect(fake.sent.some((call) => call.method === "DOM.setFileInputFiles")).toBe(false);
    });

    it("cancels prepared files while the attachment request is in flight", async () => {
        const fake = uploadFake({ files: 1 });
        const access = fake.asAccess();
        const controller = new AbortController();
        let started: () => void = () => undefined;
        let cleaned: () => void = () => undefined;
        let finish: () => void = () => undefined;
        const entered = new Promise<void>((resolve) => { started = resolve; });
        const cleanup = new Promise<void>((resolve) => { cleaned = resolve; });
        const gate = new Promise<void>((resolve) => { finish = resolve; });
        const respond = fake.respond;

        fake.respond = (tab, method, params) => {
            if (method === "DOM.setFileInputFiles") {
                started();

                return gate;
            }

            return respond?.(tab, method, params);
        };

        access.prepareUploads = async () => ({
            ticket: "a".repeat(32), files: [{ path: "/private/copy", size: 5 }],
        });

        access.cancelUploads = async () => { cleaned(); };

        const config = { ...managedConfig, safety: { ...managedConfig.safety, uploadDirs: ["/tmp"] } };
        const upload = {
            fs: memoryFs({ "/tmp/file.txt": { file: true, size: 5, readable: true } }), path: posix,
        };
        const runtime = new ToolRuntime({
            access, config, upload, elements: new ElementRegistry(),
        });

        runtime.tabs.refresh(
            [{ targetId: "tab1", url: "https://page.example/", title: "t", owned: true, created: true }],
            "tab1",
        );
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const call = runTool(inputUpload, { target: { uid: "1_1" }, files: ["/tmp/file.txt"] },
            { signal: controller.signal } as Extra, runtime);

        await entered;
        controller.abort();
        await call;
        await cleanup;
        finish();
        expect(fake.sent.some((entry) => entry.method === "DOM.setFileInputFiles")).toBe(true);
    });

    it("is a dangerous mutate tool", () => {
        const dangerous = allTools
            .filter((tool) => tool.dangerous === true)
            .map((tool) => tool.name);

        expect(dangerous).toContain("input_upload");
        expect(inputUpload.access).toBe("mutate");
    });

    it("refuses several files for an input without multiple before attaching", async () => {
        const { fake, runtime } = runtimeWith(uploadFake({ state: { multiple: false } }));
        const real = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs/promises");
        const dir = await fs.mkdtemp(path.join(real.tmpdir(), "cdm-upload-"));

        try {
            const first = path.join(dir, "first.txt");
            const second = path.join(dir, "second.txt");

            await fs.writeFile(first, "alpha");
            await fs.writeFile(second, "beta");

            const result = await runTool(
                inputUpload,
                { target: { uid: "1_1" }, files: [first, second] },
                extra(),
                runtime,
            );

            expect(result.isError).toBe(true);
            expect(contentOf(result)).toContain("multiple");
            expect(fake.sent.map((entry) => entry.method)).not.toContain("DOM.setFileInputFiles");
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it("attaches validated files through DOM.setFileInputFiles without contents", async () => {
        const { fake, runtime } = runtimeWith(uploadFake());

        const real = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs/promises");
        const dir = await fs.mkdtemp(path.join(real.tmpdir(), "cdm-upload-"));

        try {
            const first = path.join(dir, "first.txt");
            const second = path.join(dir, "second.txt");

            await fs.writeFile(first, "alpha");
            await fs.writeFile(second, "beta");

            const result = await runTool(
                inputUpload,
                { target: { uid: "1_1" }, files: [first, second] },
                extra(),
                runtime,
            );

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({
                ok    : true,
                target: { uid: "1_1", tag: "input", id: "resume" },
                files : [{ name: "first.txt", size: 5 }, { name: "second.txt", size: 4 }],
            });
            expect(contentOf(result)).not.toContain("alpha");
            expect(contentOf(result)).not.toContain("beta");
            expect(fake.sent.find((entry) => entry.method === "DOM.setFileInputFiles")?.params)
                .toEqual({
                    backendNodeId: 101,
                    files        : [await fs.realpath(first), await fs.realpath(second)],
                });
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it("attaches to a hidden file input without a box", async () => {
        const fake = uploadFake({ hidden: true, files: 1 });
        const { runtime } = runtimeWith(fake);
        const real = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs/promises");
        const dir = await fs.mkdtemp(path.join(real.tmpdir(), "cdm-upload-"));

        try {
            const first = path.join(dir, "hidden.txt");

            await fs.writeFile(first, "hidden");

            const result = await runTool(
                inputUpload,
                { target: { uid: "1_1" }, files: [first] },
                extra(),
                runtime,
            );

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({ ok: true });
            expect(fake.sent.find((entry) => entry.method === "DOM.setFileInputFiles")?.params).toMatchObject({
                backendNodeId: 101,
                files        : [expect.stringContaining("hidden.txt")],
            });
            expect(fake.sent.filter((entry) => entry.method === "DOM.getBoxModel")).toEqual([]);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it("refuses a missing path before touching the browser", async () => {
        const { fake, runtime } = runtimeWith(uploadFake());

        const result = await runTool(
            inputUpload,
            { target: { uid: "1_1" }, files: ["/tmp/cdm-no-such-file.txt"] },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(contentOf(result)).toContain("does not exist");
        expect(
            fake.sent.filter((entry) => entry.method === "DOM.setFileInputFiles"),
        ).toHaveLength(0);
    });

    it("refuses a non file input", async () => {
        const { runtime } = runtimeWith(uploadFake({ state: { tag: "input", fileInput: false } }));
        const real = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs/promises");
        const dir = await fs.mkdtemp(path.join(real.tmpdir(), "cdm-upload-"));

        try {
            const file = path.join(dir, "a.txt");

            await fs.writeFile(file, "x");
            const result = await runTool(
                inputUpload,
                { target: { uid: "1_1" }, files: [file] },
                extra(),
                runtime,
            );

            expect(result.isError).toBe(true);
            expect(contentOf(result)).toContain("not a file input");
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it.each([{ files: 1 }, { failCount: true }])("reports an unverified selection for %j", async (world) => {
        const { runtime } = runtimeWith(uploadFake(world));
        const real = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs/promises");
        const dir = await fs.mkdtemp(path.join(real.tmpdir(), "cdm-upload-"));

        try {
            const first = path.join(dir, "first.txt");
            const second = path.join(dir, "second.txt");

            await fs.writeFile(first, "a");
            await fs.writeFile(second, "b");
            const result = await runTool(
                inputUpload,
                { target: { uid: "1_1" }, files: [first, second] },
                extra(),
                runtime,
            );

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({ ok: true, inputFilesMatch: false });
            expect(contentOf(result)).toContain("verify the attachment");
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it("reports success with the new url when attaching navigates the page", async () => {
        const { runtime } = runtimeWith(uploadFake({ navigateOnAttach: true }));
        const real = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs/promises");
        const dir = await fs.mkdtemp(path.join(real.tmpdir(), "cdm-upload-"));

        try {
            const first = path.join(dir, "first.txt");

            await fs.writeFile(first, "a");
            const result = await runTool(
                inputUpload,
                { target: { uid: "1_1" }, files: [first] },
                extra(),
                runtime,
            );

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({
                ok      : true,
                urlAfter: "https://page.example/uploaded",
            });
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it("never sends a focus stealing call", async () => {
        const { fake, runtime } = runtimeWith(uploadFake({ files: 1 }));
        const real = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs/promises");
        const dir = await fs.mkdtemp(path.join(real.tmpdir(), "cdm-upload-"));

        try {
            const file = path.join(dir, "a.txt");

            await fs.writeFile(file, "x");
            await runTool(inputUpload, { target: { uid: "1_1" }, files: [file] }, extra(), runtime);
            expect(fake.sent.map((entry) => entry.method)).not.toContain("Page.bringToFront");
            expect(fake.sent.map((entry) => entry.method)).not.toContain("Target.activateTarget");
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

describe("input_upload in frames", () => {
    it("sets files on an input inside a frame", async () => {
        const fake = uploadFake({ files: 1 });
        const inner = fake.respond?.bind(fake);

        fake.respond = (_targetId, method, params) => {
            if (method === "DOM.querySelectorAll") return { nodeIds: [10] };

            if (method === "DOM.querySelector") {
                const selector = (params as { selector?: unknown })?.selector;

                if (selector === "#frame") return { nodeId: 10 };

                return { nodeId: 41 };
            }

            if (method === "DOM.describeNode") {
                const nodeId = (params as { nodeId?: unknown })?.nodeId;

                if (nodeId === 10) {
                    return {
                        node: {
                            nodeName       : "IFRAME",
                            backendNodeId  : 20,
                            frameId        : "frame1",
                            contentDocument: { nodeId: 11 },
                        },
                    };
                }
            }

            return inner?.(_targetId, method, params);
        };

        const { runtime } = runtimeWith(fake);
        const real = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs/promises");
        const dir = await fs.mkdtemp(path.join(real.tmpdir(), "cdm-upload-"));

        try {
            const file = path.join(dir, "resume.txt");

            await fs.writeFile(file, "cv");
            const result = await runTool(
                inputUpload,
                { target: { selector: "#resume", frame: "#frame" }, files: [file] },
                extra(),
                runtime,
            );

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({ ok: true });
            expect(fake.sent.find((entry) => entry.method === "DOM.setFileInputFiles")?.params)
                .toEqual({ backendNodeId: 101, files: [await fs.realpath(file)] });
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

describe("validateUploadFiles with upload directories", () => {
    const files = {
        "/srv/up/a.txt"    : { file: true, size: 1, readable: true },
        "/srv/up/sub/b.txt": { file: true, size: 2, readable: true },
        "/srv/other/c.txt" : { file: true, size: 3, readable: true },
        "/srv/up/link.txt" : { file: true, size: 4, readable: true },
        "/srv/upload/d.txt": { file: true, size: 5, readable: true },
        "/home/u/.ssh/key" : { file: true, size: 6, readable: true },
    };
    const env = (links: Record<string, string> = {}): UploadEnvironment => ({
        fs  : memoryFs(files, links),
        path: posix,
    });

    it("accepts files inside a listed directory, also nested ones", async () => {
        await expect(
            validateUploadFiles(env(), ["/srv/up/a.txt", "/srv/up/sub/b.txt"], ["/srv/up"]),
        ).resolves.toHaveLength(2);
    });

    it("refuses a file outside every listed directory and names the option", async () => {
        await expect(validateUploadFiles(env(), ["/srv/other/c.txt"], ["/srv/up"])).rejects.toThrow(
            "safety.uploadDirs",
        );
        await expect(validateUploadFiles(env(), ["/srv/upload/d.txt"], ["/srv/up"])).rejects.toThrow(
            "safety.uploadDirs",
        );
    });

    it("judges a symbolic link by the file it points to", async () => {
        await expect(
            validateUploadFiles(env({ "/srv/up/link.txt": "/home/u/.ssh/key" }), ["/srv/up/link.txt"], ["/srv/up"]),
        ).rejects.toThrow("safety.uploadDirs");
    });

    it("judges a listed directory that is a link by where it points", async () => {
        await expect(
            validateUploadFiles(env({ "/srv/up": "/srv/other" }), ["/srv/other/c.txt"], ["/srv/up"]),
        ).resolves.toHaveLength(1);
    });

    it("applies no limit without directories and matches Windows paths without regard to case", async () => {
        await expect(validateUploadFiles(env(), ["/home/u/.ssh/key"], [])).resolves.toHaveLength(1);

        const windows: UploadEnvironment = {
            fs  : memoryFs({ "C:\\Up\\a.txt": { file: true, size: 1, readable: true } }),
            path: win32,
        };

        await expect(validateUploadFiles(windows, ["C:\\Up\\a.txt"], ["c:\\up"])).resolves.toHaveLength(1);
    });
});
