import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    link: vi.fn(async () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }),
  };
});

const { ensureToken } = await import("../src/daemon/token.js");
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("ensureToken when publishing fails", () => {
  it("rethrows the error and removes its temporary file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-token-"));

    dirs.push(dir);
    const file = path.join(dir, "daemon.token");

    await expect(ensureToken(file, process.platform, process.getuid?.())).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(await readdir(dir)).toEqual([]);
  });
});
