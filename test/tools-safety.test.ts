import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { checkSafety } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";

const readOnly: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, readOnly: true },
};

describe("checkSafety", () => {
    it("allows read tools in every mode", () => {
        expect(checkSafety({ tool: "list_tabs", access: "read", config: managedConfig })).toEqual({
            allowed: true,
        });
        expect(checkSafety({ tool: "page_info", access: "read", config: readOnly })).toEqual({
            allowed: true,
        });
    });

    it("allows mutate tools when read-only is off", () => {
        expect(checkSafety({ tool: "new_tab", access: "mutate", config: managedConfig })).toEqual({
            allowed: true,
        });
    });

    it("refuses mutate tools when read-only is on with a reason and a hint", () => {
        const decision = checkSafety({ tool: "new_tab", access: "mutate", config: readOnly });

        expect(decision).toEqual({
            allowed: false,
            reason : "new_tab changes page or browser state and is refused in read-only mode.",
            hint   : "Run without --read-only to allow changes.",
        });
    });
});
