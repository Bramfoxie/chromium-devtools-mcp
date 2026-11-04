export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();

            return;
        }

        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);

        signal?.addEventListener("abort", done, { once: true });
    });
}

export function sleep(ms: number): Promise<void> {
    return abortableSleep(ms);
}
