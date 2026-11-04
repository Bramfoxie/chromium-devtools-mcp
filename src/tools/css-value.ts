const FETCHING_VALUE = /\b(?:url|image-set|src)\s*\(|@import/i;

function decodeCssEscapes(value: string): string {
    return value.replace(/\\([0-9a-f]{1,6})\s?|\\([^\n])/gi, (_match, hex?: string, plain?: string) => {
        if (hex === undefined) return plain ?? "";

        const code = Number.parseInt(hex, 16);

        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

export function isFetchingCssValue(value: string): boolean {
    return FETCHING_VALUE.test(decodeCssEscapes(value));
}
