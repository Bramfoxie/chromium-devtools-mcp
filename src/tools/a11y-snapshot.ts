import { z } from "zod";
import { A11Y_NAME_CLIP, a11yEntries, summarize } from "./a11y-tree.js";
import { toAxNodes } from "./ax-format.js";
import { redactUrl } from "./capture/redact.js";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { domInfo, limitAxNodes, SNAPSHOT_MAX_AX_DEPTH } from "./dom-snapshot.js";
import {
    assertElementOriginAllowed,
    elementAccess,
    elementTargetSchema,
    resolveElement,
} from "./element-target.js";
import { releaseQuietly } from "./remote-objects.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const MAX_NODES_DEFAULT = 500;

const MAX_NODES_LIMIT = 2000;

const stateValue = z.union([z.string(), z.number(), z.boolean()]);

const nodeSchema = z.strictObject({
    uid        : z.string().optional().describe("Element id for the uid of element targets, valid until the page navigates."),
    role       : z.string().describe("Accessibility role, for example button, link, textbox, heading."),
    name       : z.string().optional().describe(`Accessible name, up to ${A11Y_NAME_CLIP} characters.`),
    description: z.string().optional().describe("Accessible description, when it differs from the name."),
    value      : z.string().optional().describe("Value of a field, never of a password field."),
    states     : z.record(z.string(), stateValue).describe("States the browser reports, such as checked, expanded, disabled, required."),
    level      : z.number().optional().describe("Heading level."),
    href       : z.string().optional().describe("Address of a link with sensitive query values replaced by [redacted]."),
    depth      : z.number().describe("Nesting depth among the listed nodes, starting at 0."),
    unnamed    : z.literal(true).optional().describe("Set on an interactive node that has no accessible name."),
});

export const a11ySnapshot = defineTool({
    name: "a11y_snapshot",
    description:
        "List the accessibility tree of a tab as structured nodes with role, name, value and states, and count the controls that have no accessible name.",
    access: "read",
    input : z.strictObject({
        tab            : tabSchema,
        root           : elementTargetSchema.optional().describe("Limit the tree to the subtree of this element."),
        interactiveOnly: z.boolean().optional().describe("List only interactive nodes such as buttons, links and fields. Defaults to false."),
        roles          : z.array(z.string().min(1).max(40)).max(30).optional().describe("List only nodes with one of these roles, for example heading or link."),
        includeHidden  : z.boolean().optional().describe("Include hidden nodes. Defaults to false."),
        maxNodes       : z.number().int().min(1).max(MAX_NODES_LIMIT).optional().describe(`Maximum nodes to return, up to ${MAX_NODES_LIMIT}. Defaults to ${MAX_NODES_DEFAULT}.`),
    }),
    output: z.strictObject({
        tab       : z.string().describe("Tab id."),
        generation: z.number().describe("Uid generation of the tab. Uids of older generations are stale."),
        nodes     : z.array(nodeSchema).describe("Nodes in document order."),
        total     : z.number().describe("Nodes that matched, also those beyond maxNodes."),
        truncated : z.boolean().describe("Whether maxNodes cut the list or the accessibility tree was too large to read completely."),
        summary   : z.strictObject({
            roles             : z.record(z.string(), z.number()).describe("Count of matched nodes by role, the 30 most frequent."),
            interactive       : z.number().describe("Matched interactive nodes."),
            unnamedInteractive: z.number().describe("Matched interactive nodes without an accessible name."),
        }),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        await ensureNoDialog(context.dialogs, targetId);

        let backendNodeId: number | undefined;
        let scoped = context.access;
        let rootFrame: { frameId: string } | undefined;

        if (args.root !== undefined) {
            const root = await resolveElement(
                context.access,
                context.elements,
                targetId,
                args.root,
                { frames: context.frames },
            );

            backendNodeId = root.backendNodeId;
            scoped = elementAccess(context.access, root);

            if (root.isolated === true && root.frameId !== undefined) {
                rootFrame = { frameId: root.frameId };
            }

            try {
                if (root.frameId !== undefined) {
                    await assertElementOriginAllowed(
                        { config: context.config, access: context.access },
                        targetId,
                        root,
                    );
                }
            } finally {
                await releaseQuietly(scoped, targetId, [root.objectId]);
            }
        }

        const tree: unknown = backendNodeId === undefined
            ? await scoped.send({
                targetId,
                method: "Accessibility.getFullAXTree",
                params: { depth: SNAPSHOT_MAX_AX_DEPTH },
            })
            : await scoped.send({
                targetId,
                method: "Accessibility.getPartialAXTree",
                params: { backendNodeId, fetchRelatives: true },
            });
        const limited = limitAxNodes(toAxNodes(tree), backendNodeId === undefined);
        const dom = await domInfo(scoped, targetId);
        const entries = a11yEntries(limited.nodes, {
            interactiveOnly : args.interactiveOnly ?? false,
            includeHidden   : args.includeHidden ?? false,
            roles           : args.roles,
            startBackendNode: backendNodeId,
            isPassword      : (id) => {
                const info = dom.info.get(id);

                return info?.tag === "input" && (info.attrs.type ?? "").toLowerCase() === "password";
            },
        });
        const maxNodes = args.maxNodes ?? MAX_NODES_DEFAULT;
        const shown = entries.slice(0, maxNodes);
        const generation = context.elements.nextGeneration(targetId);
        const rootNode = rootFrame === undefined
            ? {}
            : {
                frameId        : rootFrame.frameId,
                isolated       : true,
                frameGeneration: context.frames.generation(targetId, rootFrame.frameId),
            };

        return {
            tab  : targetId,
            generation,
            nodes: shown.map((entry) => {
                const uid = entry.backendNodeId === undefined
                    ? undefined
                    : context.elements.assign(targetId, [{
                        backendNodeId: entry.backendNodeId,
                        ...rootNode,
                    }])[0];
                const href = entry.role === "link" && entry.backendNodeId !== undefined
                    ? dom.info.get(entry.backendNodeId)?.attrs.href
                    : undefined;

                return {
                    ...(uid === undefined ? {} : { uid }),
                    role  : entry.role,
                    ...(entry.name === "" ? {} : { name: entry.name }),
                    ...(entry.description === "" ? {} : { description: entry.description }),
                    ...(entry.value === undefined ? {} : { value: entry.value }),
                    states: entry.states,
                    ...(entry.level === undefined ? {} : { level: entry.level }),
                    ...(href === undefined || href === "" ? {} : { href: redactUrl(href) }),
                    depth : entry.depth,
                    ...(entry.unnamed ? { unnamed: true as const } : {}),
                };
            }),
            total    : entries.length,
            truncated: entries.length > shown.length || limited.limited,
            summary  : summarize(entries),
        };
    },
});
