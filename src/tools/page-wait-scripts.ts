import { elementCollector } from "./walk-script.js";

const WAIT_REGISTRY = "__chromiumDevtoolsMcpWaits";

function waitPrelude(token: string): string {
    return `const waits = (globalThis[${JSON.stringify(WAIT_REGISTRY)}] ??= new Map());
  let cancelled = false;
  let timer;
  let wake;
  const nap = (ms) => new Promise((resolve) => {
    if (cancelled) return resolve();
    wake = resolve;
    timer = setTimeout(resolve, ms);
  });
  waits.set(${JSON.stringify(token)}, () => {
    cancelled = true;
    clearTimeout(timer);
    if (wake) wake();
  });`;
}

export function cancelWaitScript(token: string): string {
    return `(() => { const stop = globalThis[${JSON.stringify(WAIT_REGISTRY)}]?.get(${JSON.stringify(token)}); if (stop) stop(); })()`;
}

export function selectorScript(
    selector : string,
    state    : "attached" | "visible" | "hidden" | "detached",
    pollMs   : number,
    timeoutMs: number,
    pierce?  : boolean,
    token    : string = "wait",
): string {
    const matcher = JSON.stringify(selector);
    const want = JSON.stringify(state);
    const collect = elementCollector(selector, pierce === true);

    return `(async () => {
  ${waitPrelude(token)}
  const selector = ${matcher};
  const want = ${want};
  const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
  const query = () => {
    ${collect}
    const visible = found.filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        getComputedStyle(el).visibility !== "hidden";
    });
    return { matched: found.length, visible: visible.length, capped: walkTruncated };
  };
  const met = (detail) => want === "attached" ? detail.matched > 0
    : want === "visible" ? detail.visible > 0
    : want === "hidden" ? detail.matched === 0 || detail.visible === 0
    : detail.matched === 0;
  let detail = query();
  try {
    while (!cancelled && Date.now() < deadline) {
      if (met(detail)) return { met: true, detail };
      await nap(${JSON.stringify(pollMs)});
      if (cancelled || Date.now() >= deadline) break;
      detail = query();
    }
    return { met: met(detail), detail };
  } finally {
    clearTimeout(timer);
    waits.delete(${JSON.stringify(token)});
  }
})()`;
}

export function textScript(
    text     : string,
    selector : string | undefined,
    pollMs   : number,
    timeoutMs: number,
    token    : string = "wait",
): string {
    const needle = JSON.stringify(text);
    const scope = JSON.stringify(selector ?? "");

    return `(async () => {
  ${waitPrelude(token)}
  const needle = ${needle};
  const scope = ${scope};
  const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
  const read = () => {
    const root = scope === "" ? document.body : document.querySelector(scope);
    const haystack = root === null || root === undefined ? "" : (root.innerText ?? "");
    return { length: haystack.length, found: haystack.includes(needle) };
  };
  try {
    for (;;) {
      const detail = read();
      if (detail.found) return { met: true, detail };
      if (cancelled || Date.now() >= deadline) return { met: false, detail };
      await nap(${JSON.stringify(pollMs)});
    }
  } finally {
    clearTimeout(timer);
    waits.delete(${JSON.stringify(token)});
  }
})()`;
}

export function expressionScript(expression: string, pollMs: number, timeoutMs: number, token: string = "wait"): string {
    return `(async () => {
  ${waitPrelude(token)}
  const check = () => (${expression});
  const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
  let last = undefined;
  try {
    for (;;) {
      try {
        last = await check();
      } catch (error) {
        last = undefined;
      }
      if (last) return { met: true, detail: { truthy: true } };
      if (cancelled || Date.now() >= deadline) return { met: false, detail: { truthy: false } };
      await nap(${JSON.stringify(pollMs)});
    }
  } finally {
    clearTimeout(timer);
    waits.delete(${JSON.stringify(token)});
  }
})()`;
}
