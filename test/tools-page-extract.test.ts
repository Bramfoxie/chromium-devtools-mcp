import { execFile } from "node:child_process";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { extractExpression, newTab, pageExtract, runTool, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(evaluate: unknown) {
    const fake = new FakeAccess({ evaluate: evaluate as never });
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    return { fake, runtime };
}

async function inEngine(expression: string): Promise<unknown> {
    const script = `
class Node { get baseURI() { return "https://a.example/page?x=1"; } }
class Element extends Node {
  constructor(tag, attrs = {}, props = {}) { super(); this.tag = tag; this.attrs = attrs; Object.assign(this, props); }
  get tagName() { return this.tag; }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
}
class HTMLFormElement extends Element { get elements() { return this.controls; } }
const links = [
  new Element("A", { href: "/one", rel: "nofollow" }, { innerText: "  One \\n link " }),
  new Element("A", { href: "https://b.example/two", "aria-label": "Two label" }),
  new Element("A", { href: "three" }, { innerText: "Three" }),
];
const headings = [
  new Element("H1", {}, { innerText: "Title" }),
  new Element("H3", {}, { textContent: "Sub" }),
];
const metas = [new Element("META", { name: "description", content: "About it" })];
const control = (attrs, props = {}) => new Element("INPUT", attrs, { labels: [], ...props });
const form = new HTMLFormElement("FORM", { id: "login", method: "POST", action: "/login", name: "signin" });
form.controls = [
  control({ type: "text", name: "user", placeholder: "User name", required: "" }, { value: "typed" }),
  control({ type: "password", name: "pass" }, {
    value: "SECRET-VALUE",
    labels: [new Element("LABEL", {}, { innerText: "Password" })],
  }),
  control({ type: "hidden", name: "csrf" }, { value: "HIDDEN-VALUE" }),
];
const rootElement = new Element("HTML", { lang: "en" });
const lists = {
  "a[href]": links,
  "h1,h2,h3,h4,h5,h6": headings,
  "meta[name],meta[property],meta[http-equiv]": metas,
  "link[rel~='canonical'][href]": [new Element("LINK", { href: "/c" })],
};
class Document extends Node {
  get forms() { return [form]; }
  get title() { return "T"; }
  get documentElement() { return rootElement; }
  querySelectorAll(selector) { return lists[selector] ?? []; }
}
globalThis.Element = Element;
globalThis.Node = Node;
globalThis.Document = Document;
globalThis.HTMLFormElement = HTMLFormElement;
globalThis.document = new Document();
globalThis.location = { href: "https://a.example/page?x=1" };
console.log(JSON.stringify(eval(${JSON.stringify(expression)})));`;

    const output = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) =>
            error ? reject(error) : resolve(stdout),
        );
    });

    return JSON.parse(output);
}

describe("extractExpression", () => {
    it("lists links, headings, meta tags and forms in a real JavaScript engine", async () => {
        const page = (await inEngine(
            extractExpression(["links", "headings", "meta", "forms"], 2),
        )) as Record<string, unknown>;

        expect(page).toMatchObject({
            url      : "https://a.example/page?x=1",
            title    : "T",
            lang     : "en",
            canonical: "https://a.example/c",
            links    : {
                total: 3,
                items: [
                    { text: "One link", href: "https://a.example/one", rel: "nofollow" },
                    { text: "Two label", href: "https://b.example/two", rel: "" },
                ],
            },
            headings: { total: 2, items: [{ level: 1, text: "Title" }, { level: 3, text: "Sub" }] },
            meta    : { total: 1, items: [{ name: "description", content: "About it" }] },
        });
    });

    it("never reads the value of a form control", async () => {
        const page = await inEngine(extractExpression(["forms"], 10));
        const text = JSON.stringify(page);

        expect(text).not.toContain("SECRET-VALUE");
        expect(text).not.toContain("HIDDEN-VALUE");
        expect(page).toMatchObject({
            forms: {
                total: 1,
                items: [{
                    id        : "login",
                    name      : "signin",
                    method    : "post",
                    action    : "https://a.example/login",
                    fieldTotal: 3,
                    fields    : [
                        { type: "text", name: "user", label: "User name", required: true },
                        { type: "password", name: "pass", label: "Password" },
                        { type: "hidden", name: "csrf" },
                    ],
                }],
            },
        });
    });

    it("reads only the requested kinds", async () => {
        const page = (await inEngine(extractExpression(["meta"], 5))) as Record<string, unknown>;

        expect(Object.keys(page)).toEqual(["url", "title", "lang", "canonical", "meta"]);
    });
});

describe("page_extract", () => {
    const base = { url: "https://example.org/p?token=abc123", title: "T", lang: "", canonical: "" };

    it("hides secrets in addresses, clips long text and marks a truncated list", async () => {
        const long = "x".repeat(900);
        const { runtime } = setup({
            result: {
                type : "object",
                value: {
                    ...base,
                    links: {
                        total: 5,
                        items: [
                            { text: long, href: "https://example.org/a?access_token=s3cret&page=2", rel: "" },
                        ],
                    },
                    forms: {
                        total: 1,
                        items: [{
                            id        : "", name      : "", method    : "post", action    : "https://u:pw@example.org/go?key=abc",
                            fieldTotal: 1, fields    : [{ tag: "input", type: "text", name: "q", label: "", required: false }],
                        }],
                    },
                },
            },
        });

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(pageExtract, { kinds: ["links", "forms"] }, extra(), runtime);
        const text = JSON.stringify(result.structuredContent);
        const shaped = result.structuredContent as { links: { items: Array<{ text: string }> } };
        const links = shaped.links;

        expect(result.isError).toBeUndefined();
        expect(text).not.toContain("abc123");
        expect(text).not.toContain("s3cret");
        expect(text).not.toContain("pw@");
        expect(text).not.toContain("key=abc");
        expect(links.items[0]?.text).toHaveLength(300);
        expect(result.structuredContent).toMatchObject({
            links: { total: 5, truncated: true },
            forms: { total: 1, truncated: false },
        });
    });

    it("hides the content of meta tags whose name looks like a secret", async () => {
        const { runtime } = setup({
            result: {
                type : "object",
                value: {
                    ...base,
                    meta: {
                        total: 3,
                        items: [
                            { name: "csrf-token", content: "CSRF-SECRET" },
                            { name: "api_key", content: "KEY-SECRET" },
                            { name: "description", content: "kept text" },
                        ],
                    },
                },
            },
        });

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(pageExtract, { kinds: ["meta"] }, extra(), runtime);
        const text = JSON.stringify(result.structuredContent);

        expect(text).not.toContain("CSRF-SECRET");
        expect(text).not.toContain("KEY-SECRET");
        expect(text).toContain("kept text");
    });

    it("reports a page exception and an unexpected answer as errors that say what to do", async () => {
        const failing = setup({ result: { type: "object" }, exceptionDetails: { text: "boom" } });

        await runTool(newTab, {}, extra(), failing.runtime);

        const thrown = await runTool(pageExtract, {}, extra(), failing.runtime);

        expect(thrown.isError).toBe(true);
        expect(JSON.stringify(thrown.content)).toContain("did not return its structure");

        const odd = setup({ result: { type: "object", value: { url: 5 } } });

        await runTool(newTab, {}, extra(), odd.runtime);

        const unexpected = await runTool(pageExtract, {}, extra(), odd.runtime);

        expect(unexpected.isError).toBe(true);
        expect(JSON.stringify(unexpected.content)).toContain("unexpected form");
    });

    it("needs a tab", async () => {
        const { runtime } = setup({ result: { type: "object", value: base } });
        const result = await runTool(pageExtract, {}, extra(), runtime);

        expect(result.isError).toBe(true);
    });
});
