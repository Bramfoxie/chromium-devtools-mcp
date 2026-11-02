import { describe, expect, it } from "vitest";
import { AX_NAME_CLIP, type AxNode, formatAxTree, toAxNodes } from "../src/tools/index.js";

function node(overrides: Partial<AxNode> & { nodeId: string }): AxNode {
    const { nodeId, ...rest } = overrides;

    return {
        nodeId,
        ignored      : false,
        role         : "generic",
        name         : "",
        description  : "",
        value        : undefined,
        hidden       : false,
        properties   : {},
        childIds     : [],
        backendNodeId: undefined,
        ...rest,
    };
}

function options(overrides: Record<string, unknown> = {}) {
    const assigned = new Map<number, string>();
    let counter = 0;

    return {
        interactiveOnly : false,
        includeHidden   : false,
        startBackendNode: undefined,
        uidFor          : (id: number) => {
            const known = assigned.get(id);

            if (known !== undefined) return known;

            counter += 1;
            const uid = `1_${counter}`;

            assigned.set(id, uid);

            return uid;
        },
        domFor: () => undefined,
        ...overrides,
    };
}

describe("toAxNodes", () => {
    it("parses the raw tree into typed nodes", () => {
        const nodes = toAxNodes({
            nodes: [
                {
                    nodeId          : "1",
                    ignored         : false,
                    role            : { value: "heading" },
                    name            : { value: "Hi" },
                    properties      : [{ name: "level", value: { value: 1 } }],
                    childIds        : ["2"],
                    backendDOMNodeId: 11,
                },
                { nodeId: "2", role: { value: "link" }, name: { value: "More" } },
            ],
        });

        expect(nodes).toEqual([
            {
                nodeId       : "1",
                ignored      : false,
                role         : "heading",
                name         : "Hi",
                description  : "",
                value        : undefined,
                hidden       : false,
                properties   : { level: 1 },
                childIds     : ["2"],
                backendNodeId: 11,
            },
            {
                nodeId       : "2",
                ignored      : false,
                role         : "link",
                name         : "More",
                description  : "",
                value        : undefined,
                hidden       : false,
                properties   : {},
                childIds     : [],
                backendNodeId: undefined,
            },
        ]);
    });

    it("marks hidden nodes and rejects a malformed tree", () => {
        const nodes = toAxNodes({
            nodes: [
                { nodeId: "1", properties: [{ name: "hidden", value: { value: true } }] },
                { nodeId: "2", properties: [{ name: "invisible", value: { value: true } }] },
            ],
        });

        expect(nodes.map((entry) => entry.hidden)).toEqual([true, true]);
        expect(() => toAxNodes({ nodes: [{ nodeId: 5 }] })).toThrow("unexpected accessibility tree");
    });
});

describe("formatAxTree", () => {
    it("renders nested nodes with uids and quoted names", () => {
        const result = formatAxTree(
            [
                node({ nodeId: "1", role: "heading", name: "Example Domain", childIds: ["2"], backendNodeId: 11, properties: { level: 1 } }),
                node({ nodeId: "2", role: "link", name: 'More "info"', childIds: [], backendNodeId: 12 }),
            ],
            options({ domFor: (id: number) => (id === 12 ? { tag: "a", attrs: { href: "https://x.example/" } } : undefined) }),
        );

        expect(result.text).toBe(
            '[1_1] heading level 1 "Example Domain"\n  [1_2] link "More \'info\'" href="https://x.example/"',
        );
        expect(result.nodeCount).toBe(2);
        expect(result.omitted).toBe(0);
    });

    it("skips layout containers transparently and counts them as omitted", () => {
        const result = formatAxTree(
            [
                node({ nodeId: "1", role: "generic", childIds: ["2"] }),
                node({ nodeId: "2", role: "button", name: "Save", childIds: ["3"], backendNodeId: 21 }),
                node({ nodeId: "3", role: "statictext", name: "Save", backendNodeId: 22 }),
            ],
            options(),
        );

        expect(result.text).toBe('[1_1] button "Save"\n  [1_2] text "Save"');
        expect(result.nodeCount).toBe(2);
        expect(result.omitted).toBe(1);
    });

    it("keeps interactive nodes only when asked", () => {
        const nodes = [
            node({ nodeId: "1", role: "heading", name: "Title", childIds: ["2"], backendNodeId: 11 }),
            node({ nodeId: "2", role: "textbox", name: "Search", backendNodeId: 12 }),
        ];

        const result = formatAxTree(nodes, options({ interactiveOnly: true }));

        expect(result.text).toBe('[1_1] textbox "Search"');
        expect(result.nodeCount).toBe(1);
        expect(result.omitted).toBe(1);
    });

    it("skips hidden and ignored nodes unless asked", () => {
        const nodes = [
            node({ nodeId: "1", role: "button", name: "Hidden", hidden: true, backendNodeId: 11 }),
            node({ nodeId: "2", role: "button", name: "Ignored", ignored: true, backendNodeId: 12 }),
            node({ nodeId: "3", role: "button", name: "Shown", backendNodeId: 13 }),
        ];

        expect(formatAxTree(nodes, options()).text).toBe('[1_1] button "Shown"');
        expect(formatAxTree(nodes, options({ includeHidden: true })).nodeCount).toBe(3);
    });

    it("shows values, states and descriptions, and hides password values", () => {
        const result = formatAxTree(
            [
                node({
                    nodeId       : "1",
                    role         : "textbox",
                    name         : "Password",
                    value        : "secret",
                    backendNodeId: 11,
                    properties   : { focused: true, required: true },
                }),
                node({
                    nodeId       : "2",
                    role         : "checkbox",
                    name         : "Remember",
                    properties   : { checked: true, disabled: false },
                    description  : "Stay signed in",
                    backendNodeId: 12,
                }),
                node({
                    nodeId       : "3",
                    role         : "combobox",
                    name         : "City",
                    value        : "Paris",
                    backendNodeId: 13,
                }),
            ],
            options({
                domFor: (id: number) =>
                    id === 11 ? { tag: "input", attrs: { type: "password" } } : undefined,
            }),
        );

        expect(result.text).toBe(
            '[1_1] textbox "Password" type="password" value="" focused required\n' +
                '[1_2] checkbox "Remember" checked desc="Stay signed in"\n' +
                '[1_3] combobox "City" value="Paris"',
        );
    });

    it("shows textbox type and placeholder from the DOM", () => {
        const result = formatAxTree(
            [node({ nodeId: "1", role: "searchbox", name: "Q", value: "", backendNodeId: 11 })],
            options({
                domFor: () => ({ tag: "input", attrs: { type: "search", placeholder: "Type here" } }),
            }),
        );

        expect(result.text).toBe('[1_1] searchbox "Q" type="search" placeholder="Type here" value=""');
    });

    it("clips long names with three dots and collapses whitespace", () => {
        const name = `line one\n   line two ${"x".repeat(AX_NAME_CLIP)}`;
        const result = formatAxTree(
            [node({ nodeId: "1", role: "button", name, backendNodeId: 11 })],
            options(),
        );

        expect(result.text).toBe(`[1_1] button "${`line one line two ${"x".repeat(AX_NAME_CLIP)}`.slice(0, AX_NAME_CLIP)}..."`);
    });

    it("omits nodes without a backend node and guards against cycles", () => {
        const result = formatAxTree(
            [
                node({ nodeId: "1", role: "button", name: "NoId", childIds: ["2"] }),
                node({ nodeId: "2", role: "button", name: "Loop", childIds: ["2"], backendNodeId: 12 }),
            ],
            options(),
        );

        expect(result.text).toBe('[1_1] button "Loop"');
        expect(result.nodeCount).toBe(1);
        expect(result.omitted).toBe(2);
    });

    it("emits landmark roles and named frames", () => {
        const result = formatAxTree(
            [
                node({ nodeId: "1", role: "navigation", name: "Main", childIds: ["2"], backendNodeId: 11 }),
                node({ nodeId: "2", role: "iframe", name: "Ads", backendNodeId: 12 }),
                node({ nodeId: "3", role: "image", name: "Logo", backendNodeId: 13 }),
            ],
            options({ domFor: (id: number) => (id === 13 ? { tag: "img", attrs: { src: "/logo.png" } } : undefined) }),
        );

        expect(result.text).toBe(
            '[1_1] navigation "Main"\n  [1_2] iframe "Ads"\n[1_3] image "Logo" src="/logo.png"',
        );
    });

    it("shows unnamed iframes with their frame id, also when only interactive nodes are listed", () => {
        const nodes = [
            node({ nodeId: "1", role: "generic", childIds: ["2", "3"], backendNodeId: 11 }),
            node({ nodeId: "2", role: "iframe", backendNodeId: 12 }),
            node({ nodeId: "3", role: "button", name: "Go", backendNodeId: 13 }),
        ];
        const frames = { frameFor: (id: number) => (id === 12 ? "F1" : undefined) };

        expect(formatAxTree(nodes, options(frames)).text).toBe('[1_1] iframe frame=F1\n[1_2] button "Go"');
        expect(formatAxTree(nodes, options({ ...frames, interactiveOnly: true })).text).toBe(
            '[1_1] iframe frame=F1\n[1_2] button "Go"',
        );
    });

    it("formats only the subtree of the starting backend node", () => {
        const nodes = [
            node({ nodeId: "1", role: "navigation", name: "Main", childIds: ["2"], backendNodeId: 11 }),
            node({ nodeId: "2", role: "link", name: "In", childIds: [], backendNodeId: 12 }),
            node({ nodeId: "3", role: "link", name: "Out", backendNodeId: 13 }),
        ];

        const result = formatAxTree(nodes, options({ startBackendNode: 11 }));

        expect(result.text).toBe('[1_1] navigation "Main"\n  [1_2] link "In"');
        expect(result.nodeCount).toBe(2);
        expect(result.omitted).toBe(0);
        expect(() => formatAxTree(nodes, options({ startBackendNode: 99 }))).toThrow(
            "root element is gone",
        );
    });
});
