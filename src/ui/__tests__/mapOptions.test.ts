import { afterEach, describe, expect, it, vi } from "vitest";

/** Fresh module per test (the options are cached at module level). */
async function load(storage?: Record<string, string> | "throw") {
  vi.resetModules();
  const store = storage === "throw" ? null : { ...(storage ?? {}) };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => { if (!store) throw new Error("blocked"); return store[k] ?? null; },
    setItem: (k: string, v: string) => { if (!store) throw new Error("blocked"); store[k] = v; },
  });
  return { mod: await import("../mapOptions"), store };
}

afterEach(() => vi.unstubAllGlobals());

describe("map display options", () => {
  it("defaults to showing fleets and city names", async () => {
    const { mod } = await load();
    expect(mod.mapOptions()).toEqual({ fleets: true, cityNames: true });
  });

  it("remembers a change in storage and reads it back", async () => {
    const { mod, store } = await load();
    mod.setMapOption("fleets", false);
    expect(mod.mapOptions().fleets).toBe(false);
    expect(JSON.parse(store!["ww2-sim:map-options"])).toEqual({ fleets: false, cityNames: true });
    const again = await load(store!);
    expect(again.mod.mapOptions()).toEqual({ fleets: false, cityNames: true });
  });

  it("ignores corrupt or wrongly typed saved values", async () => {
    expect((await load({ "ww2-sim:map-options": "{oops" })).mod.mapOptions()).toEqual({ fleets: true, cityNames: true });
    const typed = await load({ "ww2-sim:map-options": JSON.stringify({ fleets: "no", cityNames: false, extra: 1 }) });
    expect(typed.mod.mapOptions()).toEqual({ fleets: true, cityNames: false });
  });

  it("still applies changes when storage is blocked", async () => {
    const { mod } = await load("throw");
    expect(mod.mapOptions()).toEqual({ fleets: true, cityNames: true });
    mod.setMapOption("cityNames", false);
    expect(mod.mapOptions().cityNames).toBe(false);
  });
});
