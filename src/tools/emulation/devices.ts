import { z } from "zod";

export const DEVICE_WIDTH_MIN = 100;

export const DEVICE_WIDTH_MAX = 10000;

export const DEVICE_HEIGHT_MIN = 100;

export const DEVICE_HEIGHT_MAX = 10000;

export const DEVICE_SCALE_MIN = 0.5;

export const DEVICE_SCALE_MAX = 5;

export const DEVICE_USER_AGENT_MAX_CHARS = 1024;

export const deviceKindSchema = z.enum(["phone", "tablet", "desktop"]);

export type DeviceKind = z.infer<typeof deviceKindSchema>;

export interface DeviceSpec {
    name             : string;
    kind             : DeviceKind;
    width            : number;
    height           : number;
    deviceScaleFactor: number;
    mobile           : boolean;
    touch            : boolean;
    userAgent        : string;
}

export const DEVICES: DeviceSpec[] = [
    {
        name             : "iPhone SE",
        kind             : "phone",
        width            : 375,
        height           : 667,
        deviceScaleFactor: 2,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    },
    {
        name             : "iPhone 14",
        kind             : "phone",
        width            : 390,
        height           : 844,
        deviceScaleFactor: 3,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    },
    {
        name             : "iPhone 15 Pro Max",
        kind             : "phone",
        width            : 430,
        height           : 932,
        deviceScaleFactor: 3,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    },
    {
        name             : "Pixel 7",
        kind             : "phone",
        width            : 412,
        height           : 915,
        deviceScaleFactor: 2.625,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    },
    {
        name             : "Pixel 8 Pro",
        kind             : "phone",
        width            : 412,
        height           : 891,
        deviceScaleFactor: 2.625,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    },
    {
        name             : "Galaxy S23",
        kind             : "phone",
        width            : 360,
        height           : 780,
        deviceScaleFactor: 3,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    },
    {
        name             : "Galaxy S24 Ultra",
        kind             : "phone",
        width            : 412,
        height           : 915,
        deviceScaleFactor: 3,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    },
    {
        name             : "Galaxy Z Fold 5",
        kind             : "phone",
        width            : 344,
        height           : 882,
        deviceScaleFactor: 3,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (Linux; Android 14; SM-F946B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    },
    {
        name             : "iPad Air",
        kind             : "tablet",
        width            : 820,
        height           : 1180,
        deviceScaleFactor: 2,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    },
    {
        name             : "iPad Pro 11",
        kind             : "tablet",
        width            : 834,
        height           : 1194,
        deviceScaleFactor: 2,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    },
    {
        name             : "Galaxy Tab S9",
        kind             : "tablet",
        width            : 800,
        height           : 1280,
        deviceScaleFactor: 2,
        mobile           : true,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    {
        name             : "Surface Pro 9",
        kind             : "tablet",
        width            : 912,
        height           : 1368,
        deviceScaleFactor: 2,
        mobile           : false,
        touch            : true,
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    {
        name             : "MacBook Air 13",
        kind             : "desktop",
        width            : 1280,
        height           : 800,
        deviceScaleFactor: 2,
        mobile           : false,
        touch            : false,
        userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    {
        name             : "MacBook Pro 16",
        kind             : "desktop",
        width            : 1728,
        height           : 1117,
        deviceScaleFactor: 2,
        mobile           : false,
        touch            : false,
        userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    {
        name             : "Windows Laptop 1080p",
        kind             : "desktop",
        width            : 1920,
        height           : 1080,
        deviceScaleFactor: 1,
        mobile           : false,
        touch            : false,
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    {
        name             : "Windows Laptop 1440p",
        kind             : "desktop",
        width            : 2560,
        height           : 1440,
        deviceScaleFactor: 1,
        mobile           : false,
        touch            : false,
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    {
        name             : "Linux Desktop 1080p",
        kind             : "desktop",
        width            : 1920,
        height           : 1080,
        deviceScaleFactor: 1,
        mobile           : false,
        touch            : false,
        userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    {
        name             : "4K Desktop",
        kind             : "desktop",
        width            : 3840,
        height           : 2160,
        deviceScaleFactor: 1,
        mobile           : false,
        touch            : false,
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
];

export interface LandscapeSpec extends DeviceSpec {
    landscapeWidth : number;
    landscapeHeight: number;
}

export function asLandscape(device: DeviceSpec): LandscapeSpec {
    return { ...device, landscapeWidth: device.height, landscapeHeight: device.width };
}

function distance(left: string, right: string): number {
    const rows: number[][] = [];

    for (let row = 0; row <= left.length; row += 1) {
        rows.push([row]);
    }

    for (let column = 1; column <= right.length; column += 1) {
        rows[0]?.push(column);
    }

    for (let row = 1; row <= left.length; row += 1) {
        for (let column = 1; column <= right.length; column += 1) {
            const cost = left[row - 1] === right[column - 1] ? 0 : 1;
            const above = rows[row - 1]?.[column] ?? Number.MAX_SAFE_INTEGER;
            const beside = rows[row]?.[column - 1] ?? Number.MAX_SAFE_INTEGER;
            const diagonal = rows[row - 1]?.[column - 1] ?? Number.MAX_SAFE_INTEGER;

            rows[row]?.push(Math.min(above + 1, beside + 1, diagonal + cost));
        }
    }

    return rows[left.length]?.[right.length] ?? Number.MAX_SAFE_INTEGER;
}

export function suggestDevices(name: string, limit = 3): string[] {
    const wanted = name.trim().toLowerCase();

    return [...DEVICES]
        .map((device) => ({
            name : device.name,
            score: distance(wanted, device.name.toLowerCase()),
        }))
        .sort((left, right) => left.score - right.score || left.name.localeCompare(right.name))
        .slice(0, Math.max(0, limit))
        .map((entry) => entry.name);
}

export function findDevice(name: string): DeviceSpec | undefined {
    const wanted = name.trim().toLowerCase();

    return DEVICES.find((device) => device.name.toLowerCase() === wanted);
}

export function filterDevices(query: { query?: string; kind?: DeviceKind }): LandscapeSpec[] {
    const needle = query.query?.trim().toLowerCase();

    return DEVICES
        .filter((device) => query.kind === undefined || device.kind === query.kind)
        .filter((device) => needle === undefined || needle === "" || device.name.toLowerCase().includes(needle))
        .map(asLandscape);
}
