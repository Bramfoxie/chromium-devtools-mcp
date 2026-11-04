import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

interface Node {
    uid?    : string;
    role    : string;
    name?   : string;
    value?  : string;
    states  : Record<string, unknown>;
    level?  : number;
    href?   : string;
    depth   : number;
    unnamed?: true;
}

interface Result {
    nodes    : Node[];
    total    : number;
    truncated: boolean;
    summary  : { interactive: number; unnamedInteractive: number; roles: Record<string, number> };
}

const PAGE = `<header><nav aria-label="Main"><a id="home" href="/home?token=abc123">Home</a></nav></header>
<main>
  <h1>Checkout</h1>
  <h2>Payment</h2>
  <label for="email">Email address</label><input id="email" value="a@b.test" required>
  <label for="pw">Password</label><input id="pw" type="password" value="hunter2">
  <input type="checkbox" id="agree" aria-label="Agree to terms" checked>
  <button id="icon"><svg width="10" height="10"></svg></button>
  <button id="save" disabled>Save</button>
  <img src="/p.png" alt="Product photo">
  <div hidden><button>Hidden button</button></div>
</main>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/a11y", html(PAGE));
});

afterAll(async () => {
    await env?.stop();
});

const snapshot = async (tab: string, args: Record<string, unknown> = {}) =>
    (await env.ok("a11y_snapshot", { tab, ...args })) as unknown as Result;

describe.skipIf(!present)("a11y_snapshot in a real browser", () => {
    it("lists roles, names, values and states of the page", async () => {
        const tab = await env.open("/a11y");
        const result = await snapshot(tab);
        const find = (role: string, name?: string) =>
            result.nodes.find(
                (node) => node.role === role && (name === undefined || node.name === name),
            );

        expect(find("heading", "Checkout")?.level).toBe(1);
        expect(find("heading", "Payment")?.level).toBe(2);
        expect(find("link", "Home")?.href).toContain("/home");
        expect(find("textbox", "Email address")).toMatchObject({ value: "a@b.test" });
        expect(find("textbox", "Email address")?.states.required).toBe(true);
        expect(find("checkbox", "Agree to terms")?.states.checked).toBe(true);
        expect(find("button", "Save")?.states.disabled).toBe(true);
        expect(find("image", "Product photo")).toBeDefined();
        expect(find("navigation", "Main")).toBeDefined();
        expect(result.nodes.find((node) => node.name === "Hidden button")).toBeUndefined();
        expect(result.nodes.every((node) => typeof node.depth === "number")).toBe(true);
    });

    it("hides secrets: a password value and the token of a link", async () => {
        const tab = await env.open("/a11y");
        const result = await snapshot(tab);
        const password = result.nodes.find((node) => node.name === "Password");
        const text = JSON.stringify(result);

        expect(password?.value).toBeUndefined();
        expect(text).not.toContain("hunter2");
        expect(text).not.toContain("abc123");
    });

    it("counts the controls without an accessible name", async () => {
        const tab = await env.open("/a11y");
        const result = await snapshot(tab);
        const unnamed = result.nodes.filter((node) => node.unnamed === true);

        expect(unnamed.map((node) => node.role)).toEqual(["button"]);
        expect(result.summary.unnamedInteractive).toBe(1);
        expect(result.summary.interactive).toBeGreaterThanOrEqual(5);
    });

    it("filters by interactive nodes and by role, and cuts at maxNodes", async () => {
        const tab = await env.open("/a11y");
        const interactive = await snapshot(tab, { interactiveOnly: true });
        const headings = await snapshot(tab, { roles: ["heading"] });
        const cut = await snapshot(tab, { maxNodes: 2 });

        expect(interactive.nodes.every((node) => node.role !== "heading" && node.role !== "image")).toBe(true);
        expect(headings.nodes.map((node) => node.name)).toEqual(["Checkout", "Payment"]);
        expect(cut.nodes).toHaveLength(2);
        expect(cut.truncated).toBe(true);
        expect(cut.total).toBeGreaterThan(2);
    });

    it("gives uids that the element tools accept, and limits the tree to a root", async () => {
        const tab = await env.open("/a11y");
        const result = await snapshot(tab, { roles: ["link"] });
        const uid = result.nodes[0]?.uid;

        expect(uid).toMatch(/^\d+_\d+$/);

        await env.ok("dom_edit", {
            tab,
            target: { uid },
            action: "set_attribute",
            name  : "data-seen",
            value : "1",
        });

        const marked = (await env.ok("js_evaluate", {
            tab,
            expression: "document.getElementById('home').getAttribute('data-seen')",
        })) as { value?: unknown };

        expect(marked.value).toBe("1");

        const scoped = await snapshot(tab, { root: { selector: "nav" } });

        expect(scoped.nodes.map((node) => node.role)).not.toContain("heading");
        expect(scoped.nodes.some((node) => node.name === "Home")).toBe(true);
    });
});
