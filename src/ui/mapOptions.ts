import { el } from "./dom";

/**
 * Map display options shared by the setup, observation and result maps (user requirement: the naval power per sea
 * zone and the city names can be shown or hidden). Remembered per browser; the defaults apply when storage is
 * unavailable.
 */
export interface MapOptions {
  /** Fleet badges (naval power per sea zone). */
  fleets: boolean;
  /** City name labels (the city markers themselves stay). */
  cityNames: boolean;
}

const KEY = "ww2-sim:map-options";
const DEFAULTS: MapOptions = { fleets: true, cityNames: true };

let current: MapOptions | null = null;

export function mapOptions(): MapOptions {
  if (!current) {
    current = { ...DEFAULTS };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
      if (saved && typeof saved === "object") {
        for (const k of Object.keys(DEFAULTS) as (keyof MapOptions)[]) {
          if (typeof saved[k] === "boolean") current[k] = saved[k];
        }
      }
    } catch {
      // Storage blocked or corrupt: keep the defaults.
    }
  }
  return current;
}

export function setMapOption(key: keyof MapOptions, value: boolean): void {
  mapOptions()[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Not remembered, but still applied for this page.
  }
}

/**
 * Checkboxes for the map legend. `keys` picks which options the screen offers (the setup map has no fleets);
 * `onChange` redraws the map.
 */
export function mapOptionToggles(keys: (keyof MapOptions)[], onChange: () => void): HTMLElement[] {
  const labels: Record<keyof MapOptions, string> = { fleets: "海軍力を表示", cityNames: "都市名を表示" };
  return keys.map((key) => {
    const box = el("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = mapOptions()[key];
    box.onchange = () => {
      setMapOption(key, box.checked);
      onChange();
    };
    return el("label", { class: "map-toggle" }, box, labels[key]);
  });
}
