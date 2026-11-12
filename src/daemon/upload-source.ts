import { constants } from "node:fs";
import { open, readlink, type FileHandle } from "node:fs/promises";

export const UPLOAD_SOURCE_MAX_BYTES = 100 * 1024 * 1024;

export class UploadSourceUnavailableError extends Error {}

export async function loadKoffi() {
    try {
        return (await import("koffi")).default;
    } catch {
        throw new UploadSourceUnavailableError("Native upload support is unavailable.");
    }
}

export interface UploadSource {
    path   : string;
    size   : number;
    mtimeMs: number;
    read(buffer: Buffer): Promise<number>;
    close(): Promise<void>;
}

export interface NativeCall {
    (...args: unknown[]): unknown;
    async(...args: unknown[]): void;
}

export function nativeAsync(call: NativeCall, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
        call.async(...args, (error: unknown, result: unknown) => {
            if (error != null) reject(error);
            else resolve(result);
        });
    });
}

export async function darwinPath(handle: FileHandle): Promise<string> {
    const koffi = await loadKoffi();
    const library = koffi.load("/usr/lib/libSystem.B.dylib");
    const fcntl = library.func("int fcntl(int, int, ...)") as NativeCall;
    const buffer = Buffer.alloc(4096);
    const result = fcntl(handle.fd, 50, "void *", buffer);

    if (result !== 0) throw new Error("Cannot resolve an open file.");

    const terminator = buffer.indexOf(0);

    if (terminator <= 0) throw new Error("Cannot resolve an open file.");

    return buffer.subarray(0, terminator).toString("utf8");
}

async function posixSource(file: string, platform: "linux" | "darwin"): Promise<UploadSource> {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));

    try {
        const info = await handle.stat();

        if (!info.isFile() || info.size > UPLOAD_SOURCE_MAX_BYTES) throw new Error("Invalid file.");

        const resolved = platform === "linux"
            ? await readlink(`/proc/self/fd/${handle.fd}`)
            : await darwinPath(handle);

        if (!resolved.startsWith("/") || resolved.endsWith(" (deleted)")) throw new Error("Invalid path.");

        return {
            path   : resolved,
            size   : info.size,
            mtimeMs: info.mtimeMs,
            read   : async (buffer) =>
                (await handle.read(buffer, 0, buffer.length, null)).bytesRead,
            close: async () => handle.close(),
        };
    } catch (error) {
        await handle.close();

        throw error;
    }
}

export function windowsPath(value: string): string {
    if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
    if (value.startsWith("\\\\?\\")) return value.slice(4);

    return value;
}

async function windowsSource(file: string, opened?: bigint): Promise<UploadSource> {
    const koffi = await loadKoffi();
    const library = koffi.load("kernel32.dll");
    const create = library.func("intptr_t __stdcall CreateFileW(const char16_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)") as NativeCall;
    const name = library.func("uint32_t __stdcall GetFinalPathNameByHandleW(intptr_t, void *, uint32_t, uint32_t)") as NativeCall;
    const fileType = library.func("uint32_t __stdcall GetFileType(intptr_t)") as NativeCall;
    const sizeOf = library.func("int __stdcall GetFileSizeEx(intptr_t, void *)") as NativeCall;
    const fileTime = library.func("int __stdcall GetFileTime(intptr_t, void *, void *, void *)") as NativeCall;
    const read = library.func("int __stdcall ReadFile(intptr_t, void *, uint32_t, void *, void *)") as NativeCall;
    const close = library.func("int __stdcall CloseHandle(intptr_t)") as NativeCall;
    const handle = opened ?? await nativeAsync(create, file, 0x80000000, 7, null, 3, 0x80, null);

    if ((typeof handle !== "number" && typeof handle !== "bigint") || handle === -1 || handle === -1n || handle === 0 || handle === 0n) {
        throw new Error("Cannot open file.");
    }

    try {
        const pathBuffer = Buffer.alloc(65536);
        const length = await nativeAsync(name, handle, pathBuffer, 32768, 0);
        const sizeBuffer = Buffer.alloc(8);
        const timeBuffer = Buffer.alloc(8);
        const validType = await nativeAsync(fileType, handle);
        const validSize = await nativeAsync(sizeOf, handle, sizeBuffer);
        const validTime = await nativeAsync(fileTime, handle, null, null, timeBuffer);
        const size = sizeBuffer.readBigInt64LE();
        const mtimeMs = Number(timeBuffer.readBigUInt64LE() / 10000n - 11644473600000n);

        if (typeof length !== "number" || length <= 0 || length >= 32768 || validType !== 1 ||
            validSize !== 1 || validTime !== 1 || size < 0n || size > BigInt(UPLOAD_SOURCE_MAX_BYTES)) throw new Error("Invalid file.");

        return {
            path: windowsPath(pathBuffer.toString("utf16le", 0, length * 2)),
            size: Number(size),
            mtimeMs,
            read: async (buffer) => {
                const count = Buffer.alloc(4);
                const result = await nativeAsync(read, handle, buffer, buffer.length, count, null);

                if (result !== 1) throw new Error("Cannot read file.");

                return count.readUInt32LE();
            },
            close: async () => { await nativeAsync(close, handle); },
        };
    } catch (error) {
        await nativeAsync(close, handle);

        throw error;
    }
}

export async function openUploadSource(
    file: string, platform: NodeJS.Platform, opened?: bigint,
): Promise<UploadSource> {
    if (platform === "linux" || platform === "darwin") return posixSource(file, platform);
    if (platform === "win32") return windowsSource(file, opened);

    throw new Error("Unsupported platform.");
}
