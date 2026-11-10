import type {
    CpuState,
    DeviceMetrics,
    GeolocationState,
    LocaleSelection,
    MediaState,
    NetworkConditions,
} from "./commands.js";

interface DeviceEmulation extends DeviceMetrics {
    name     : string;
    userAgent: string;
    landscape: boolean;
}

interface NetworkEmulation extends NetworkConditions {
    preset   : string | undefined;
    blockUrls: string[];
}

interface LocaleEmulation extends LocaleSelection {
    locale        : string | undefined;
    timezone      : string | undefined;
    acceptLanguage: string | undefined;
}

export interface TabEmulation {
    device     : DeviceEmulation | undefined;
    media      : MediaState | undefined;
    network    : NetworkEmulation | undefined;
    locale     : LocaleEmulation | undefined;
    geolocation: GeolocationState | undefined;
    cpu        : CpuState | undefined;
}

function emptyTab(): TabEmulation {
    return {
        device     : undefined,
        media      : undefined,
        network    : undefined,
        locale     : undefined,
        geolocation: undefined,
        cpu        : undefined,
    };
}

export class EmulationState {
    private readonly tabs = new Map<string, TabEmulation>();
    private geolocationTail: Promise<void> = Promise.resolve();

    async withGeolocation<T>(run: () => Promise<T>): Promise<T> {
        const previous = this.geolocationTail;
        let release: () => void = () => undefined;

        this.geolocationTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;

        try {
            return await run();
        } finally {
            release();
        }
    }

    snapshot(tab: string): TabEmulation {
        const state = this.tabs.get(tab) ?? emptyTab();

        return {
            device : state.device === undefined ? undefined : { ...state.device },
            media  : state.media === undefined ? undefined : { ...state.media },
            network: state.network === undefined
                ? undefined
                : { ...state.network, blockUrls: [...state.network.blockUrls] },
            locale     : state.locale === undefined ? undefined : { ...state.locale },
            geolocation: state.geolocation === undefined ? undefined : { ...state.geolocation },
            cpu        : state.cpu === undefined ? undefined : { ...state.cpu },
        };
    }

    applyDevice(tab: string, device: DeviceEmulation): TabEmulation {
        return this.update(tab, { device });
    }

    resetDevice(tab: string): TabEmulation {
        return this.update(tab, { device: undefined });
    }

    applyMedia(tab: string, media: MediaState): TabEmulation {
        return this.update(tab, { media: { ...media } });
    }

    resetMedia(tab: string): TabEmulation {
        return this.update(tab, { media: undefined });
    }

    applyNetwork(tab: string, network: NetworkEmulation): TabEmulation {
        return this.update(tab, { network: { ...network, blockUrls: [...network.blockUrls] } });
    }

    resetNetwork(tab: string): TabEmulation {
        return this.update(tab, { network: undefined });
    }

    applyLocale(tab: string, locale: LocaleEmulation): TabEmulation {
        return this.update(tab, { locale: { ...locale } });
    }

    resetLocale(tab: string): TabEmulation {
        return this.update(tab, { locale: undefined });
    }

    applyGeolocation(tab: string, geolocation: GeolocationState): TabEmulation {
        return this.update(tab, { geolocation: { ...geolocation } });
    }

    resetGeolocation(tab: string): TabEmulation {
        return this.update(tab, { geolocation: undefined });
    }

    applyCpu(tab: string, cpu: CpuState): TabEmulation {
        return this.update(tab, { cpu: { ...cpu } });
    }

    resetCpu(tab: string): TabEmulation {
        return this.update(tab, { cpu: undefined });
    }

    geolocationOrigins(except?: string): Set<string> {
        const origins = new Set<string>();

        for (const [tab, state] of this.tabs) {
            if (tab !== except && state.geolocation !== undefined) {
                origins.add(state.geolocation.origin);
            }
        }

        return origins;
    }

    forget(tab: string): void {
        this.tabs.delete(tab);
    }

    reset(): void {
        this.tabs.clear();
    }

    private update(tab: string, patch: Partial<TabEmulation>): TabEmulation {
        const state = this.tabs.get(tab) ?? emptyTab();
        const next: TabEmulation = { ...state, ...patch };

        if (
            next.device === undefined && next.media === undefined &&
            next.network === undefined && next.locale === undefined &&
            next.geolocation === undefined && next.cpu === undefined
        ) {
            this.tabs.delete(tab);
        } else {
            this.tabs.set(tab, next);
        }

        return this.snapshot(tab);
    }
}
