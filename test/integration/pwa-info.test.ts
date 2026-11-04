import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

function crc32(buffer: Buffer): number {
    let crc = ~0;

    for (const byte of buffer) {
        let value = (crc ^ byte) & 0xff;

        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }

        crc = (crc >>> 8) ^ value;
    }

    return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    const crc = Buffer.alloc(4);
    const body = Buffer.concat([Buffer.from(type), data]);

    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));

    return Buffer.concat([length, body, crc]);
}

function png(size: number): Buffer {
    const header = Buffer.alloc(13);

    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 2;

    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x66)]);
    const raw = Buffer.concat(Array.from({ length: size }, () => row));

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const MANIFEST = {
    name            : "Demo App",
    short_name      : "Demo",
    id              : "/app",
    start_url       : "/app?utm_source=pwa&token=secret123",
    scope           : "/",
    display         : "standalone",
    theme_color     : "#336699",
    background_color: "#ffffff",
    description     : "A demo",
    icons           : [
        { src: "/i192.png", sizes: "192x192", type: "image/png" },
        { src: "/i512.png?key=hidden456", sizes: "512x512", type: "image/png" },
    ],
    shortcuts: [{ name: "New", url: "/new" }],
};

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    const pages = env.other.pages;

    pages.set("/manifest.webmanifest", {
        body  : JSON.stringify(MANIFEST),
        status: 200,
        type  : "application/manifest+json",
    });
    pages.set("/i192.png", { body: png(192), status: 200, type: "image/png" });
    pages.set("/i512.png", { body: png(512), status: 200, type: "image/png" });
    pages.set("/sw.js", {
        body  : "self.addEventListener('fetch', () => {});",
        status: 200,
        type  : "text/javascript",
    });
    pages.set("/app", {
        body: `<!doctype html><title>app</title><link rel="manifest" href="/manifest.webmanifest">
<p>app</p><script>navigator.serviceWorker.register("/sw.js")</script>`,
        status: 200,
        type  : "text/html",
    });
    pages.set("/plain", {
        body  : "<!doctype html><title>plain</title><p>no manifest</p>",
        status: 200,
        type  : "text/html",
    });
});

afterAll(async () => {
    await env?.stop();
});

async function open(path: string): Promise<string> {
    const created = await env.ok("new_tab", { url: `${env.other.origin}${path}` });

    return String((created.tab as { tab: string }).tab);
}

type Info = {
    installable : boolean;
    manifestUrl?: string;
    appId?      : { id: string; recommended?: string };
    manifest?           : {
        name?      : string;
        shortName? : string;
        display?   : string;
        startUrl?  : string;
        scope?     : string;
        themeColor?: string;
        icons      : Array<{ url: string; sizes?: string }>;
        shortcuts  : Array<{ name: string; url: string }>;
    };
    manifestErrors      : unknown[];
    installabilityErrors: Array<{ id: string; message: string }>;
    serviceWorkers      : Array<{ scope: string; script: string; state: string }>;
};

describe.skipIf(!present)("pwa_info in a real browser", () => {
    it("reads the manifest, the app id and the service worker, and reports the private window of an isolated session", async () => {
        const tab = await open("/app");
        let info: Info | undefined;

        await eventually(async () => {
            info = (await env.ok("pwa_info", { tab })) as unknown as Info;

            return info.serviceWorkers.length > 0 ? true : undefined;
        }, 15_000);

        expect(info?.installabilityErrors.map((problem) => problem.id)).toEqual(["in-incognito"]);
        expect(info?.installable).toBe(false);
        expect(info?.manifestUrl).toBe(`${env.other.origin}/manifest.webmanifest`);
        expect(info?.manifest).toMatchObject({
            name      : "Demo App",
            shortName : "Demo",
            display   : "standalone",
            scope     : `${env.other.origin}/`,
            themeColor: "rgba(51,102,153,1)",
        });
        expect(info?.manifest?.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
        expect(info?.manifest?.shortcuts).toEqual([{ name: "New", url: `${env.other.origin}/new` }]);
        expect(info?.appId?.id).toBe(`${env.other.origin}/app`);
        expect(info?.serviceWorkers[0]).toMatchObject({
            scope : `${env.other.origin}/`,
            script: `${env.other.origin}/sw.js`,
            state : "activated",
        });
    }, 30_000);

    it("redacts secrets in the addresses of the manifest", async () => {
        const tab = await open("/app");
        const info = (await env.ok("pwa_info", { tab })) as unknown as Info;
        const json = JSON.stringify(info);

        expect(json).not.toContain("secret123");
        expect(json).not.toContain("hidden456");
        expect(info.manifest?.startUrl).toContain("/app");
    });

    it("says why a page without a manifest cannot be installed", async () => {
        const tab = await open("/plain");
        const info = (await env.ok("pwa_info", { tab })) as unknown as Info;

        expect(info.installable).toBe(false);
        expect(info.manifestUrl).toBeUndefined();
        expect(info.manifest).toBeUndefined();
        expect(info.installabilityErrors).toContainEqual({
            id     : "no-manifest",
            message: "The page has no web app manifest.",
        });
    });

    it("works on a blank tab and installs nothing", async () => {
        const created = await env.ok("new_tab", {});
        const tab = String((created.tab as { tab: string }).tab);
        const info = (await env.ok("pwa_info", { tab })) as unknown as Info;

        expect(info.installable).toBe(false);
        expect(info.manifestUrl).toBeUndefined();
    });
});
