import { randomBytes, timingSafeEqual } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { pathFor } from "../browser/platform-path.js";
import { ensurePrivateDir } from "./private-dir.js";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export async function readToken(file: string): Promise<string | undefined> {
  let content: string;
  try {
    content = (await readFile(file, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return TOKEN_PATTERN.test(content) ? content : undefined;
}

export async function ensureToken(
  file: string,
  platform: NodeJS.Platform,
  uid: number | undefined,
): Promise<string> {
  const existing = await readToken(file);
  if (existing) return existing;
  await ensurePrivateDir(pathFor(platform).dirname(file), platform, uid);
  const token = generateToken();
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, token, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, file);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const winner = await readToken(file);
    if (winner) return winner;
    await rename(temporary, file);
    return token;
  } finally {
    await rm(temporary, { force: true });
  }
}

export function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
