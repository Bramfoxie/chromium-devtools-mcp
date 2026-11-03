import type {
    DeviceMetrics,
    LocaleSelection,
    MediaState,
    NetworkConditions,
} from "./commands.js";

export interface DeviceEmulation extends DeviceMetrics {
    name     : string;
    userAgent: string;
    landscape: boolean;
}

export interface NetworkEmulation extends NetworkConditions {
    preset   : string | undefined;
    blockUrls: string[];
}

export interface LocaleEmulation extends LocaleSelection {
    locale        : string | undefined;
    timezone      : string | undefined;
    acceptLanguage: string | undefined;
}

export interface TabEmulation {
    device : DeviceEmulation | undefined;
    media  : MediaState | undefined;
    network: NetworkEmulation | undefined;
    locale : LocaleEmulation | undefined;
}

function emptyTab(): TabEmulation {
    return { device: undefined, media: undefined, network: undefined, locale: undefined };
}

export class EmulationState {
    private readonly tabs = new Map<string, TabEmulation>();

    snapshot(tab: string): TabEmulation {
        const state = this.tabs.get(tab) ?? emptyTab();

        return {
            device : state.device === undefined ? undefined : { ...state.device },
            media  : state.media === undefined ? undefined : { ...state.media },
            network: state.network === undefined
                ? undefined
                : { ...state.network, blockUrls: [...state.network.blockUrls] },
            locale: state.locale === undefined ? undefined : { ...state.locale },
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
            next.network === undefined && next.locale === undefined
        ) {
            this.tabs.delete(tab);
        } else {
            this.tabs.set(tab, next);
        }

        return this.snapshot(tab);
    }
}
