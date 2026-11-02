import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name   : "unit",
                    include: ["test/**/*.test.ts"],
                    exclude: ["test/integration/**"],
                },
            },
            {
                test: {
                    name           : "integration",
                    include        : ["test/integration/**/*.test.ts"],
                    testTimeout    : 60_000,
                    hookTimeout    : 120_000,
                    fileParallelism: false,
                },
            },
        ],
    },
});
