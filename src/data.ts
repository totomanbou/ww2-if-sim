import mapUrl from "../data/map.json?url";
import presetUrl from "../data/presets/historical.json?url";
import type { MapData } from "./sim/mapTypes";
import type { Scenario } from "./sim/types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const loadMap = () => getJson<MapData>(mapUrl);
export const loadHistoricalPreset = () => getJson<Scenario>(presetUrl);

/** "1939-09-01" → "1939年9月1日" */
export function formatDateJa(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日`;
}

export const FACTION_COLORS = { axis: "#e8463c", allies: "#3b86e8" } as const;
export const FACTION_NAMES = { axis: "枢軸国", allies: "連合国", neutral: "中立国" } as const;
