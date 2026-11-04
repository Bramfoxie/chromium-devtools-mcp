import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    type ArtifactStore,
    DownloadState,
    downloads,
    runTool,
    safeFilename,
    ToolRuntime,
} from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const DIR = "/data/artifacts/downloads-1";

function setup(readOnly = false, sleep: (ms: number) => Promise<void> = async () => undefined) {
    const fake = new FakeAccess({
        tabs: [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
    });
    const artifacts: ArtifactStore = {
        write    : () => Promise.reject(new Error("not used")),
        directory: async () => ({
            path  : DIR,
            write : async () => 0,
            remove: async () => undefined,
        }),
    };
    const config = readOnly
        ? { ...managedConfig, safety: { ...managedConfig.safety, readOnly: true } }
        : managedConfig;
    const clock = { now: () => 0, sleep };
    const runtime = new ToolRuntime({ access: fake.asAccess(), config, artifacts, clock });

    runtime.attach();
    runtime.tabs.select("tab1");

    return { fake, runtime };
}

const begin = (fake: FakeAccess, guid: string, name = "report.csv", url = "https://a.example/f?token=s3cret") =>
    fake.emit("cdp.event", {
        targetId: "tab1",
        event   : "Page.downloadWillBegin",
        params  : { frameId: "f", guid, url, suggestedFilename: name },
    });

const progress = (
    fake    : FakeAccess,
    guid    : string,
    state   : "inProgress" | "completed" | "canceled",
    received: number,
    total = 100,
) =>
    fake.emit("cdp.event", {
        targetId: "tab1",
        event   : "Page.downloadProgress",
        params  : { guid, totalBytes: total, receivedBytes: received, state },
    });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("downloads allow and deny", () => {
    it("saves into a new private directory and subscribes to the download events", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(downloads, { action: "allow" }, extra(), runtime);

        expect(result.structuredContent).toEqual({ tab: "tab1", enabled: true, directory: DIR });
        expect(fake.subscribed.map((entry) => entry.event)).toEqual([
            "Page.downloadWillBegin",
            "Page.downloadProgress",
        ]);
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Page.enable",
            "Page.setDownloadBehavior",
        ]);
        expect(fake.sent[1]?.params).toEqual({ behavior: "allow", downloadPath: DIR });
    });

    it("turns downloads off again", async () => {
        const { fake, runtime } = setup();

        await runTool(downloads, { action: "allow" }, extra(), runtime);
        const result = await runTool(downloads, { action: "deny" }, extra(), runtime);

        expect(result.structuredContent).toEqual({ tab: "tab1", enabled: false });
        expect(fake.sent.at(-1)?.params).toEqual({ behavior: "deny" });
    });

    it("is refused in read-only mode, while list works", async () => {
        const { fake, runtime } = setup(true);
        const refused = await runTool(downloads, { action: "allow" }, extra(), runtime);
        const listed = await runTool(downloads, { action: "list" }, extra(), runtime);

        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.content)).toContain("read-only");
        expect(listed.isError).not.toBe(true);
        expect(fake.sent).toEqual([]);
    });

    it("takes id and timeoutMs for wait only", async () => {
        const { runtime } = setup();
        const result = await runTool(downloads, { action: "list", timeoutMs: 5 }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("wait only");
    });
});

describe("downloads list and wait", () => {
    it("lists a download from its start to its end with the address redacted", async () => {
        const { fake, runtime } = setup();

        await runTool(downloads, { action: "allow" }, extra(), runtime);
        begin(fake, "g1");
        progress(fake, "g1", "inProgress", 40);
        await tick();

        const during = await runTool(downloads, { action: "list" }, extra(), runtime);
        const item = (during.structuredContent as { downloads: Array<Record<string, unknown>> })
            .downloads[0];

        expect(item).toMatchObject({
            id           : "g1",
            filename     : "report.csv",
            state        : "inProgress",
            receivedBytes: 40,
            totalBytes   : 100,
        });
        expect(String(item?.url)).not.toContain("s3cret");

        progress(fake, "g1", "completed", 100);
        await tick();

        const after = await runTool(downloads, { action: "list" }, extra(), runtime);

        const afterList = (after.structuredContent as {
            downloads: Array<{ state: string }>;
        }).downloads;

        expect(afterList[0]?.state)
            .toBe("completed");
    });

    it("hands out each finished download once, also when it finished before the call", async () => {
        const { fake, runtime } = setup();

        await runTool(downloads, { action: "allow" }, extra(), runtime);
        begin(fake, "g1", "a.txt");
        progress(fake, "g1", "completed", 10, 10);
        begin(fake, "g2", "b.txt");
        progress(fake, "g2", "completed", 20, 20);
        await tick();

        const first = await runTool(downloads, { action: "wait", timeoutMs: 0 }, extra(), runtime);
        const second = await runTool(downloads, { action: "wait", timeoutMs: 0 }, extra(), runtime);
        const third = await runTool(downloads, { action: "wait", timeoutMs: 0 }, extra(), runtime);

        expect(first.structuredContent).toMatchObject({ met: true, download: { id: "g1" } });
        expect(second.structuredContent).toMatchObject({ met: true, download: { id: "g2" } });
        expect(third.structuredContent).toMatchObject({ met: false });
    });

    it("waits for a download that is still running and for a given id", async () => {
        const { fake, runtime } = setup(false, () => new Promise<void>(() => undefined));

        await runTool(downloads, { action: "allow" }, extra(), runtime);
        begin(fake, "g1", "a.txt");
        await tick();

        const pending = runTool(downloads, { action: "wait", id: "g1" }, extra(), runtime);

        await tick();
        progress(fake, "g1", "completed", 5, 5);

        expect((await pending).structuredContent).toMatchObject({
            met     : true,
            download: { id: "g1", state: "completed" },
        });
    });

    it("reports a canceled download as finished", async () => {
        const { fake, runtime } = setup();

        await runTool(downloads, { action: "allow" }, extra(), runtime);
        begin(fake, "g1");
        progress(fake, "g1", "canceled", 3);
        await tick();

        const result = await runTool(downloads, { action: "wait", timeoutMs: 0 }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ met: true, download: { state: "canceled" } });
    });

    it("says to allow downloads first when wait is called before allow", async () => {
        const { runtime } = setup();
        const result = await runTool(downloads, { action: "wait" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("action allow");
    });

    it("forgets the downloads of a tab that closed", async () => {
        const { fake, runtime } = setup();

        await runTool(downloads, { action: "allow" }, extra(), runtime);
        begin(fake, "g1");
        await tick();
        await runtime.forgetTab("tab1");

        expect(runtime.downloadState.list("tab1")).toEqual([]);
        expect(runtime.downloadState.directoryOf("tab1")).toBeUndefined();
    });
});

describe("DownloadState file lookup", () => {
    function state(files: string[], sizes: Record<string, number> = {}) {
        const fake = new FakeAccess();
        const value = new DownloadState(fake.asAccess(), {
            list: async () => files,
            size: async (file) => sizes[file],
        });

        value.attach();
        value.allow("tab1", "/d");

        return { fake, value };
    }

    async function finish(fake: FakeAccess, guid: string, name: string) {
        begin(fake, guid, name);
        progress(fake, guid, "completed", 7, 7);
        await tick();
    }

    it("finds the file by its suggested name and reads its size", async () => {
        const file = path.join("/d", "a.txt");
        const { fake, value } = state(["a.txt", "a.txt.crdownload"], { [file]: 4096 });

        await finish(fake, "g1", "a.txt");

        expect(value.list("tab1")[0]).toMatchObject({ path: file, receivedBytes: 4096 });
    });

    it("takes the only unclaimed file when the browser renamed it, and none when it is unsure", async () => {
        const one = state(["a (1).txt"]);

        await finish(one.fake, "g1", "a.txt");
        expect(one.value.list("tab1")[0]?.path).toBe(path.join("/d", "a (1).txt"));

        const many = state(["x", "y"]);

        await finish(many.fake, "g1", "a.txt");
        expect(many.value.list("tab1")[0]).not.toHaveProperty("path");
    });

    it("does not give one file to two downloads", async () => {
        const { fake, value } = state(["a.txt", "a (1).txt"]);

        await finish(fake, "g1", "a.txt");
        await finish(fake, "g2", "a.txt");

        const paths = value.list("tab1").map((item) => item.path);

        expect(new Set(paths).size).toBe(2);
    });
});

describe("DownloadState concurrency", () => {
    it("gives two downloads that finish together two different files", async () => {
        const fake = new FakeAccess();
        const value = new DownloadState(fake.asAccess(), {
            list: async () => {
                await tick();

                return ["one.txt"];
            },
            size: async () => 1,
        });

        value.attach();
        value.allow("tab1", "/d");
        begin(fake, "a", "x.txt");
        begin(fake, "b", "y.txt");
        progress(fake, "a", "completed", 1, 1);
        progress(fake, "b", "completed", 1, 1);
        await new Promise((resolve) => setTimeout(resolve, 20));

        const paths = value.list("tab1").map((item) => item.path).filter((item) => item !== undefined);

        expect(paths).toEqual([path.join("/d", "one.txt")]);
    });

    it("keeps waiting for the wanted download when another one ends first", async () => {
        const fake = new FakeAccess();
        const files = { list: async () => [], size: async () => undefined };
        const value = new DownloadState(fake.asAccess(), files);

        value.attach();
        value.allow("tab1", "/d");
        begin(fake, "wanted", "w.txt");
        begin(fake, "other", "o.txt");
        await tick();

        let settled = false;
        const pending = value.next("tab1", 10_000, () => new Promise<void>(() => undefined), "wanted")
            .then((item) => { settled = true;

                return item; });

        progress(fake, "other", "canceled", 0);
        await tick();
        expect(settled).toBe(false);

        progress(fake, "wanted", "completed", 1, 1);

        expect((await pending)?.id).toBe("wanted");
    });
});

describe("safeFilename", () => {
    it("keeps the last segment and drops control characters", () => {
        expect(safeFilename("../../etc/passwd")).toBe("passwd");
        expect(safeFilename("C:\\Users\\x\\evil.exe")).toBe("evil.exe");
        expect(safeFilename("a\u0000b\nc.txt")).toBe("abc.txt");
        expect(safeFilename("x".repeat(400))).toHaveLength(255);
        expect(safeFilename("dir/")).toBe("");
    });
});
