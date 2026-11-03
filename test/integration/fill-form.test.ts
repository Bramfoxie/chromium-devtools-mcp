import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

const FORM = `<form id="f" onsubmit="return false">
<input id="name"><input id="mail" type="email"><input id="pw" type="password">
<textarea id="note"></textarea>
<select id="color"><option value="r">Red</option><option value="g">Green</option></select>
<select id="many" multiple><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select>
<input id="agree" type="checkbox"><input id="news" type="checkbox" checked>
<input id="a" type="radio" name="g" value="a"><input id="b" type="radio" name="g" value="b">
<input id="file" type="file"><input id="go" type="submit" value="go">
<div id="log"></div></form>
<script>
for (const id of ["name", "color", "agree"]) {
  document.getElementById(id).addEventListener("change", () => {
    document.getElementById("log").textContent += id + ";";
  });
}
</script>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/form", html(FORM));
});

afterAll(async () => {
    await env?.stop();
});

async function read(tab: string, expression: string): Promise<unknown> {
    const result = (await env.ok("js_evaluate", { tab, expression })) as { value?: unknown };

    return result.value;
}

describe.skipIf(!present)("fill_form in a real browser", () => {
    it("fills every kind of field in one call", async () => {
        const tab = await env.open("/form");
        const result = await env.ok("fill_form", {
            tab,
            fields: [
                { target: { selector: "#name" }, value: "Ada Lovelace" },
                { target: { selector: "#mail" }, value: "ada@example.com" },
                { target: { selector: "#pw" }, value: "s3cret" },
                { target: { selector: "#note" }, value: "line one" },
                { target: { selector: "#color" }, value: "g" },
                { target: { selector: "#many" }, value: ["Alpha", "c"] },
                { target: { selector: "#agree" }, value: true },
                { target: { selector: "#news" }, value: false },
                { target: { selector: "#b" }, value: true },
            ],
        });

        expect(result).toMatchObject({ ok: true, filled: 9 });
        expect(JSON.stringify(result)).not.toContain("s3cret");
        expect(
            await read(
                tab,
                `({
                  name: document.getElementById("name").value,
                  mail: document.getElementById("mail").value,
                  pw: document.getElementById("pw").value,
                  note: document.getElementById("note").value,
                  color: document.getElementById("color").value,
                  many: [...document.getElementById("many").selectedOptions].map((o) => o.value),
                  agree: document.getElementById("agree").checked,
                  news: document.getElementById("news").checked,
                  b: document.getElementById("b").checked,
                  a: document.getElementById("a").checked,
                })`,
            ),
        ).toEqual({
            name : "Ada Lovelace",
            mail : "ada@example.com",
            pw   : "s3cret",
            note : "line one",
            color: "g",
            many : ["a", "c"],
            agree: true,
            news : false,
            b    : true,
            a    : false,
        });
        expect(await read(tab, "document.getElementById('log').textContent")).toContain("color;");
    });

    it("replaces existing text and clears a field with an empty string", async () => {
        const tab = await env.open("/form");

        await env.ok("fill_form", { tab, fields: [{ target: { selector: "#name" }, value: "first" }] });
        await env.ok("fill_form", { tab, fields: [{ target: { selector: "#name" }, value: "second" }] });
        expect(await read(tab, "document.getElementById('name').value")).toBe("second");

        await env.ok("fill_form", { tab, fields: [{ target: { selector: "#name" }, value: "" }] });
        expect(await read(tab, "document.getElementById('name').value")).toBe("");
    });

    it("leaves a checkbox that already has the wanted state alone", async () => {
        const tab = await env.open("/form");
        const result = await env.ok("fill_form", {
            tab,
            fields: [{ target: { selector: "#news" }, value: true }],
        });

        expect(JSON.stringify(result)).toContain("already checked");
        expect(await read(tab, "document.getElementById('log').textContent")).toBe("");
    });

    it("stops at the first failing field and says what was filled", async () => {
        const tab = await env.open("/form");
        const result = await env.call("fill_form", {
            tab,
            fields: [
                { target: { selector: "#name" }, value: "kept" },
                { target: { selector: "#color" }, value: "blue" },
                { target: { selector: "#note" }, value: "never typed" },
            ],
        });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("Field 2 of 3");
        expect(result.text).toContain("Available options");
        expect(result.text).toContain("Field 1 was filled, field 3 was not attempted.");
        expect(await read(tab, "document.getElementById('name').value")).toBe("kept");
        expect(await read(tab, "document.getElementById('note').value")).toBe("");
    });

    it("refuses a file input, a button, a wrong value and an unchecked radio", async () => {
        const tab = await env.open("/form");
        const attempt = (target: string, value: unknown) =>
            env.call("fill_form", { tab, fields: [{ target: { selector: target }, value }] });

        expect((await attempt("#file", "x")).text).toContain("input_upload");
        expect((await attempt("#go", "x")).text).toContain("not a field");
        expect((await attempt("#agree", "yes")).text).toContain("true or false");
        expect((await attempt("#name", true)).text).toContain("a string");
        expect((await attempt("#a", false)).text).toContain("cannot be unchecked");
    });
});
