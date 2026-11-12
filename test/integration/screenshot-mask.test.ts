import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.other.pages.set("/password", html(`
        <style>body { margin: 0; background: white } input { position: absolute; left: 10px; top: 10px; width: 50px; height: 20px }</style>
        <input type="password" value="frame-secret">
    `));
    env.fixture.pages.set("/mask", html(`
        <style>body { margin: 0; background: white } input { position: absolute; left: 10px; top: 10px; width: 50px; height: 20px }</style>
        <input type="password" value="main-secret">
        <div id="shadow" style="position:absolute;left:10px;top:50px"></div>
        <iframe style="position:absolute;left:100px;top:100px;width:120px;height:80px;border:0" src="${env.other.origin}/password"></iframe>
        <script>document.querySelector('#shadow').attachShadow({mode:'closed'}).innerHTML = '<input type="password" value="shadow-secret" style="width:50px;height:20px">'</script>
    `));
    env.fixture.pages.set("/rotated", html(`
        <iframe style="transform:rotate(15deg)" src="${env.other.origin}/password"></iframe>
    `));
    env.fixture.pages.set("/scroll-mask", html(`
        <style>body { margin: 0; height: 2000px; background: white }</style>
        <input type="password" value="secret" style="position:absolute;left:20px;top:900px;width:50px;height:20px">
    `));
    env.fixture.pages.set("/leaf-mask", html(`
        <style>body { margin: 0 } input { position: absolute; left: 10px; top: 10px; width: 50px; height: 20px }</style>
        <input type="password" value="nested-secret">
    `));
    env.other.pages.set("/middle-mask", html(`
        <style>body { margin: 0 }</style>
        <iframe style="position:absolute;left:20px;top:20px;width:120px;height:80px;border:4px solid" src="${env.fixture.origin}/leaf-mask"></iframe>
    `));
    env.fixture.pages.set("/nested-mask", html(`
        <style>body { margin: 0 }</style>
        <iframe style="position:absolute;left:40px;top:30px;width:200px;height:150px;border:4px solid" src="${env.other.origin}/middle-mask"></iframe>
    `));
});

afterAll(async () => { await env?.stop(); });

describe.skipIf(!present)("password masking in a real browser", () => {
    it("covers fields in the main document, a closed shadow root and a cross site frame", async () => {
        const tab = await env.open("/mask");

        await eventually(async () => {
            const snapshot = await env.ok("dom_snapshot", { tab });
            const frames = snapshot.frames as Array<{ isolated?: boolean }>;

            return frames.some((frame) => frame.isolated === true) ? true : undefined;
        });
        const result = await env.client.callTool({
            name: "screenshot", arguments: { tab, format: "png", clip: { x: 0, y: 0, width: 260, height: 200 }, maskPasswords: true },
        });
        const image = (result.content as Array<{ type: string; data?: string }>).find((entry) => entry.type === "image");

        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            maskedPasswords: 3, maskIncomplete: true,
        });
        const bytes = Buffer.from(image?.data ?? "", "base64");
        const { data, info } = await sharp(bytes)
            .removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const pixel = (x: number, y: number) => data[(y * info.width + x) * info.channels] ?? -1;

        expect(pixel(20, 20)).toBeLessThan(10);
        expect(pixel(20, 60)).toBeLessThan(10);
        expect(pixel(120, 120)).toBeLessThan(10);
        expect(pixel(230, 180)).toBeGreaterThan(245);
    });

    it("masks a cross site frame in a scaled clip", async () => {
        const tab = await env.open("/mask");

        await eventually(async () => {
            const snapshot = await env.ok("dom_snapshot", { tab });
            const frames = snapshot.frames as Array<{ isolated?: boolean }>;

            return frames.some((frame) => frame.isolated === true) ? true : undefined;
        });
        const result = await env.client.callTool({
            name     : "screenshot", arguments: {
                tab, format       : "png", clip         : { x: 100, y: 100, width: 120, height: 80 },
                scale        : 0.5, maskPasswords: true,
            },
        });
        const image = (result.content as Array<{ type: string; data?: string }>)
            .find((entry) => entry.type === "image");

        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            maskedPasswords: 1, width: 60, height: 40,
        });
        const bytes = Buffer.from(image?.data ?? "", "base64");
        const { data, info } = await sharp(bytes).removeAlpha().raw()
            .toBuffer({ resolveWithObject: true });

        expect(data[(10 * info.width + 10) * info.channels]).toBeLessThan(10);
    });

    it("refuses a rotated cross site frame rather than returning an unmasked image", async () => {
        const tab = await env.open("/rotated");

        await eventually(async () => {
            const snapshot = await env.ok("dom_snapshot", { tab });
            const frames = snapshot.frames as Array<{ isolated?: boolean }>;

            return frames.some((frame) => frame.isolated === true) ? true : undefined;
        });
        const result = await env.client.callTool({
            name: "screenshot", arguments: { tab, maskPasswords: true },
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Password masking could not cover");
        expect((result.content as Array<{ type: string }>).some((entry) => entry.type === "image"))
            .toBe(false);
    });

    it("maps a scrolled document into a page-coordinate clip", async () => {
        const tab = await env.open("/scroll-mask");

        await env.ok("js_evaluate", { tab, expression: "window.scrollTo(0, 500)" });
        const result = await env.client.callTool({
            name     : "screenshot", arguments: {
                tab, format       : "png", clip         : { x: 0, y: 800, width: 200, height: 200 },
                maskPasswords: true,
            },
        });
        const image = (result.content as Array<{ type: string; data?: string }>)
            .find((entry) => entry.type === "image");

        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ maskedPasswords: 1 });
        const bytes = Buffer.from(image?.data ?? "", "base64");
        const { data, info } = await sharp(bytes).removeAlpha().raw()
            .toBuffer({ resolveWithObject: true });

        expect(data[(110 * info.width + 30) * info.channels]).toBeLessThan(10);
    });

    it("covers a password in nested cross site frames", async () => {
        const tab = await env.open("/nested-mask");

        await eventually(async () => {
            const snapshot = await env.ok("dom_snapshot", { tab });
            const frames = snapshot.frames as Array<{ isolated?: boolean }>;

            return frames.filter((frame) => frame.isolated === true).length >= 2 ? true : undefined;
        });
        const result = await env.client.callTool({
            name     : "screenshot", arguments: {
                tab, format       : "png", clip         : { x: 0, y: 0, width: 260, height: 200 },
                maskPasswords: true,
            },
        });
        const image = (result.content as Array<{ type: string; data?: string }>)
            .find((entry) => entry.type === "image");

        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ maskedPasswords: 1 });
        const bytes = Buffer.from(image?.data ?? "", "base64");
        const { data, info } = await sharp(bytes).removeAlpha().raw()
            .toBuffer({ resolveWithObject: true });

        expect(data[(75 * info.width + 90) * info.channels]).toBeLessThan(10);
    });
});
