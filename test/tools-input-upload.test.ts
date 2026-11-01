import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    allTools,
    ElementRegistry,
    inputUpload,
    runTool,
    ToolRuntime,
    UPLOAD_MAX_BYTES,
    validateUploadFiles,
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

function memoryFs(entries: Record<string, MemoryEntry>): UploadFileSystem {
    return {
        stat: async (path) => {
            const entry = entries[path];

            if (entry === undefined) throw new Error("ENOENT");

            return { isFile: () => entry.file, size: entry.size };
        },
        access: async (path) => {
            if (entries[path]?.readable !== true) throw new Error("EACCES");
        },
        realpath: async (path) => path,
    };
}

interface UploadWorld {
    state? : Record<string, unknown>;
    files? : number;
    hidden?: boolean;
}

function uploadFake(world: UploadWorld = {}): FakeAccess {
    const fake = new FakeAccess();

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
                return {};
            case "Emulation.setFocusEmulationEnabled":
                return {};
            case "Runtime.evaluate":
                return { result: { type: "string", value: "https://page.example/" } };

            case "Runtime.callFunctionOn": {
                const declaration = String(
                    (params as { functionDeclaration?: unknown })?.functionDeclaration ?? "",
                );

                if (declaration.includes("element.files")) {
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
    const fs = memoryFs({
        "/tmp/a.txt"   : { file: true, size: 12, readable: true },
        "/tmp/b.txt"   : { file: true, size: 34, readable: true },
        "/tmp/dir"     : { file: false, size: 0, readable: true },
        "/tmp/locked"  : { file: true, size: 8, readable: false },
        "/tmp/huge.bin": { file: true, size: UPLOAD_MAX_BYTES + 1, readable: true },
    });

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

    it("refuses files over the 100 MiB limit", async () => {
        await expect(validateUploadFiles(fs, ["/tmp/huge.bin"])).rejects.toThrow(
            String(UPLOAD_MAX_BYTES),
        );
    });
});

describe("input_upload", () => {
    it("is a dangerous mutate tool", () => {
        const dangerous = allTools
            .filter((tool) => tool.dangerous === true)
            .map((tool) => tool.name);

        expect(dangerous).toContain("input_upload");
        expect(inputUpload.access).toBe("mutate");
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
                .toEqual({ backendNodeId: 101, files: [first, second] });
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
            expect(fake.sent.find((entry) => entry.method === "DOM.setFileInputFiles")).toBeDefined();
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

    it("reports when the page accepted fewer files", async () => {
        const { runtime } = runtimeWith(uploadFake({ files: 1 }));
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

            expect(result.isError).toBe(true);
            expect(contentOf(result)).toContain("accepted 1 of 2 files");
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

            return inner?.(_targetId, method, params) as unknown;
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
                .toEqual({ backendNodeId: 101, files: [file] });
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
