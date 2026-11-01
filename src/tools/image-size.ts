export interface ImageSize {
    width : number;
    height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngSize(bytes: Uint8Array): ImageSize | undefined {
    if (bytes.length < 24) return undefined;

    for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
        if (bytes[index] !== PNG_SIGNATURE[index]) return undefined;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

    let offset = 2;

    while (offset + 3 < bytes.length) {
        if (bytes[offset] !== 0xff) return undefined;

        const marker = bytes[offset + 1] as number;

        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
            continue;
        }

        if (marker === 0x01 || marker === 0xd9) return undefined;

        const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);

        if (length < 2 || offset + 1 + length >= bytes.length) return undefined;

        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
            const height = ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number);
            const width = ((bytes[offset + 7] as number) << 8) | (bytes[offset + 8] as number);

            return { width, height };
        }

        offset += 2 + length;
    }

    return undefined;
}

function webpSize(bytes: Uint8Array): ImageSize | undefined {
    if (bytes.length < 30) return undefined;

    const riff = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
    const webp = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);

    if (riff !== "RIFF" || webp !== "WEBP") return undefined;

    const chunk = String.fromCharCode(
        bytes[12] ?? 0,
        bytes[13] ?? 0,
        bytes[14] ?? 0,
        bytes[15] ?? 0,
    );

    if (chunk === "VP8 ") {
        if (bytes.length < 30) return undefined;

        const width = (bytes[26] as number) | ((bytes[27] as number) << 8);
        const height = (bytes[28] as number) | ((bytes[29] as number) << 8);

        return { width: width & 0x3fff, height: height & 0x3fff };
    }

    if (chunk === "VP8L") {
        if (bytes.length < 25 || bytes[20] !== 0x2f) return undefined;

        const bits = (bytes[21] as number) |
            ((bytes[22] as number) << 8) |
            ((bytes[23] as number) << 16) |
            ((bytes[24] as number) << 24);

        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }

    if (chunk === "VP8X") {
        if (bytes.length < 30) return undefined;

        const width = ((bytes[24] as number) << 16) | ((bytes[25] as number) << 8) |
            (bytes[26] as number);
        const height = ((bytes[27] as number) << 16) | ((bytes[28] as number) << 8) |
            (bytes[29] as number);

        return { width: (width & 0xffffff) + 1, height: (height & 0xffffff) + 1 };
    }

    return undefined;
}

export function imageSize(format: "png" | "jpeg" | "webp", bytes: Uint8Array): ImageSize | undefined {
    if (format === "png") return pngSize(bytes);
    if (format === "jpeg") return jpegSize(bytes);

    return webpSize(bytes);
}
