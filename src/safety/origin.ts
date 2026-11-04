export function originOfUrl(url: string): string | undefined {
    try {
        const origin = new URL(url).origin;

        return origin === "null" ? undefined : origin;
    } catch {
        return undefined;
    }
}

// Accepts only an http or https origin written exactly as the browser writes it.
export function webOrigin(value: string): string | undefined {
    const origin = originOfUrl(value);

    return origin !== undefined && origin === value && /^https?:/.test(origin) ? origin : undefined;
}
