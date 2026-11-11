import { constants } from "node:fs";
import { open, readlink } from "node:fs/promises";
import path from "node:path";
import { darwinPath, loadKoffi, nativeAsync, openUploadSource, UploadSourceUnavailableError, windowsPath, type NativeCall, type UploadSource } from "./upload-source.js";

export interface UploadRoot {
    path: string;
    open(relative: string): Promise<UploadSource>;
    close(): Promise<void>;
}

function components(relative: string, platform: NodeJS.Platform): string[] {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const parts = relative.split(paths.sep);

    if (paths.isAbsolute(relative) || parts.some((part) => part === "" || part === "." || part === "..")) {
        throw new Error("Invalid relative upload path.");
    }

    return parts;
}

async function posixRoot(root: string, platform: "linux" | "darwin"): Promise<UploadRoot> {
    const koffi = await loadKoffi();
    const lib = koffi.load(null);
    const openat = lib.func("int openat(int, const char *, int)") as NativeCall;
    const close = lib.func("int close(int)") as NativeCall;
    const directory = await open(
        root, constants.O_RDONLY | constants.O_DIRECTORY,
    );
    let resolved: string;

    try {
        resolved = platform === "darwin"
            ? await darwinPath(directory) : await readlink(`/proc/self/fd/${directory.fd}`);
        if (!resolved.startsWith("/") || resolved.endsWith(" (deleted)")) throw new Error("Invalid directory.");
    } catch (error) {
        await directory.close();

        throw error;
    }

    return {
        path: resolved,
        open: async (relative) => {
            const parts = components(relative, platform);
            const descriptors: number[] = [];
            let parent = directory.fd;

            try {
                for (const [index, part] of parts.entries()) {
                    const flags = constants.O_RDONLY | constants.O_NOFOLLOW |
                        (index === parts.length - 1 ? constants.O_NONBLOCK : constants.O_DIRECTORY);
                    const descriptor = await nativeAsync(openat, parent, part, flags);

                    if (typeof descriptor !== "number" || descriptor < 0) throw new Error("Cannot open upload path.");

                    descriptors.push(descriptor);
                    parent = descriptor;
                }

                const prefix = platform === "darwin" ? "/dev/fd" : "/proc/self/fd";

                return await openUploadSource(`${prefix}/${parent}`, platform);
            } finally {
                for (const descriptor of descriptors.reverse()) close(descriptor);
            }
        },
        close: async () => directory.close(),
    };
}

async function windowsRoot(root: string): Promise<UploadRoot> {
    const koffi = await loadKoffi();
    const kernel = koffi.load("kernel32.dll");
    const native = koffi.load("ntdll.dll");
    const create = kernel.func("intptr_t __stdcall CreateFileW(const char16_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)") as NativeCall;
    const close = kernel.func("int __stdcall CloseHandle(intptr_t)") as NativeCall;
    const finalName = kernel.func("uint32_t __stdcall GetFinalPathNameByHandleW(intptr_t, void *, uint32_t, uint32_t)") as NativeCall;
    const unicode = koffi.struct({ Length: "uint16_t", MaximumLength: "uint16_t", Buffer: "void *" });
    const attributes = koffi.struct({
        Length                  : "uint32_t", RootDirectory           : "intptr_t", ObjectName              : koffi.pointer(unicode),
        Attributes              : "uint32_t", SecurityDescriptor      : "void *", SecurityQualityOfService: "void *",
    });
    const ntopen = native.func("NtCreateFile", "int32_t", [
        "void *", "uint32_t", koffi.pointer(attributes), "void *", "void *", "uint32_t",
        "uint32_t", "uint32_t", "uint32_t", "void *", "uint32_t",
    ]) as NativeCall;
    const handle = await nativeAsync(create, root, 0x80000000, 7, null, 3, 0x02000000, null);

    if ((typeof handle !== "number" && typeof handle !== "bigint") || handle === -1 || handle === -1n ||
        handle === 0 || handle === 0n) throw new Error("Cannot open upload directory.");

    const buffer = Buffer.alloc(65536);
    let resolved: string;

    try {
        const length = await nativeAsync(finalName, handle, buffer, 32768, 0);

        if (typeof length !== "number" || length <= 0 || length >= 32768) throw new Error("Invalid directory.");

        resolved = windowsPath(buffer.toString("utf16le", 0, length * 2));
    } catch (error) {
        await nativeAsync(close, handle);

        throw error;
    }

    return {
        path: resolved,
        open: async (relative) => {
            components(relative, "win32");
            const name = Buffer.from(`${relative}\0`, "utf16le");

            if (name.length > 65534) throw new Error("Upload path is too long.");

            const result = Buffer.alloc(8);
            const io = Buffer.alloc(16);
            const status = await nativeAsync(ntopen, result, 0x80100080, {
                Length       : koffi.sizeof(attributes),
                RootDirectory: handle,
                ObjectName   : {
                    Length: name.length - 2, MaximumLength: name.length, Buffer: name,
                },
                Attributes              : 0x1040,
                SecurityDescriptor      : null,
                SecurityQualityOfService: null,
            }, io, null, 0, 7, 1, 0x60, null, 0);

            if (status !== 0) throw new Error("Cannot open upload path.");

            return openUploadSource("", "win32", result.readBigInt64LE());
        },
        close: async () => { await nativeAsync(close, handle); },
    };
}

export async function pinUploadRoots(
    roots: string[], platform: NodeJS.Platform,
): Promise<UploadRoot[]> {
    const pinned: UploadRoot[] = [];

    try {
        for (const root of roots) {
            try {
                if (platform === "linux" || platform === "darwin") pinned.push(await posixRoot(root, platform));
                else if (platform === "win32") pinned.push(await windowsRoot(root));
                else throw new UploadSourceUnavailableError("Unsupported platform.");
            } catch (error) {
                if (error instanceof UploadSourceUnavailableError) throw error;
            }
        }

        return pinned;
    } catch (error) {
        await Promise.allSettled(pinned.map(async (root) => root.close()));

        throw error;
    }
}
