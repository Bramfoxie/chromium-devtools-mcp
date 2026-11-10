const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const LOCAL_SUFFIXES = [
    ".localhost",
    ".local",
    ".localdomain",
    ".internal",
    ".lan",
    ".home.arpa",
];

const LOOPBACK_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

function ipv4Octets(host: string): number[] | undefined {
    const match = IPV4.exec(host);

    if (match === null) return undefined;

    return match.slice(1).map(Number);
}

function isPrivateIpv4(octets: readonly number[]): boolean {
    const [a = 0, b = 0] = octets;

    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 192 && b === 0 && octets[2] === 0)
        || (a === 198 && (b === 18 || b === 19));
}

function embeddedIpv4(groups: readonly number[]): number[] | undefined {
    const high = groups[6];
    const low = groups[7];

    if (high === undefined || low === undefined) return undefined;

    return [high >> 8, high & 255, low >> 8, low & 255];
}

function parseIpv6(text: string): number[] | undefined {
    let address = text;
    const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);

    if (tail !== null) {
        const octets = ipv4Octets(tail[1] ?? "");

        if (octets === undefined) return undefined;

        const [a = 0, b = 0, c = 0, d = 0] = octets;

        address = `${address.slice(0, -tail[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }

    const halves = address.split("::");

    if (halves.length > 2) return undefined;

    const head = (halves[0] ?? "") === "" ? [] : (halves[0] ?? "").split(":");
    const rest = halves.length === 2 ? ((halves[1] ?? "") === "" ? [] : (halves[1] ?? "").split(":")) : [];
    const missing = 8 - head.length - rest.length;

    if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined;

    const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];

    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;

    return groups.map((group) => parseInt(group, 16));
}

function isPrivateIpv6(groups: readonly number[]): boolean {
    const [first = 0] = groups;
    const zeros = groups.slice(0, 5).every((group) => group === 0);

    if (groups.every((group) => group === 0)) return true;

    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;

    if (zeros && (groups[5] === 0xffff || groups[5] === 0)) {
        const embedded = embeddedIpv4(groups);

        return embedded === undefined || isPrivateIpv4(embedded);
    }

    if (groups[0] === 0x64 && groups[1] === 0xff9b) {
        const embedded = embeddedIpv4(groups);

        return embedded === undefined || isPrivateIpv4(embedded);
    }

    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

// URL hostnames arrive normalized: numeric IPv4 forms are dotted decimal and IPv6 is bracketed.
export function isPrivateHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, "");

    if (host === "") return false;

    if (LOOPBACK_NAMES.has(host)) return true;

    if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

    if (host.startsWith("[") && host.endsWith("]")) {
        const groups = parseIpv6(host.slice(1, -1));

        return groups === undefined || isPrivateIpv6(groups);
    }

    const octets = ipv4Octets(host);

    return octets !== undefined && isPrivateIpv4(octets);
}

export function addressesArePrivate(addresses: readonly string[]): boolean {
    return addresses.some((address) => {
        const bare = address.split("%")[0] ?? "";

        if (bare.includes(":")) return isPrivateHost(`[${bare}]`);

        return ipv4Octets(bare) === undefined || isPrivateHost(bare);
    });
}
