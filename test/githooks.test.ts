import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const posix = process.platform !== "win32";

function flagged(text: string): boolean {
  const run = spawnSync("sh", ["-c", '. ./.githooks/lib.sh; printf "%s\\n" "$1" | has_typography', "sh", text]);

  return run.status === 0;
}

const FORBIDDEN: Array<[string, number]> = [
  ["en dash", 0x2013],
  ["em dash", 0x2014],
  ["minus sign", 0x2212],
  ["ellipsis", 0x2026],
  ["left double quote", 0x201c],
  ["low double quote", 0x201e],
  ["single guillemet", 0x2039],
  ["bullet", 0x2022],
  ["arrow", 0x2192],
  ["greater or equal", 0x2265],
  ["almost equal", 0x2248],
  ["multiplication sign", 0xd7],
  ["guillemet", 0xab],
  ["no-break space", 0xa0],
  ["narrow no-break space", 0x202f],
  ["thin space", 0x2009],
  ["zero width space", 0x200b],
  ["line separator", 0x2028],
  ["check mark", 0x2713],
  ["variation selector", 0xfe0f],
  ["byte order mark", 0xfeff],
  ["emoji", 0x1f680],
];

describe.skipIf(!posix)("typography check of the git hooks", () => {
  it.each(FORBIDDEN)("flags %s", (_name, codePoint) => {
    expect(flagged(`a ${String.fromCodePoint(codePoint)} b`)).toBe(true);
  });

  it.each(["plain ascii - text...", `20${String.fromCodePoint(0xb0)}C`])("accepts %s", (text) => {
    expect(flagged(text)).toBe(false);
  });
});
